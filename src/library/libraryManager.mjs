import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readMetadata, writeMetadata } from '../tags/tagParser.mjs';
import { EngineBridge } from '../engine/engineBridge.mjs';
import { MusicDatabase } from '../db/musicDatabase.mjs';
import { FolderWatcher } from './folderWatcher.mjs';

export const SUPPORTED_AUDIO_EXTENSIONS = new Set([
  '.flac',
  '.m4a',
  '.alac',
  '.mp3',
  '.wav',
  '.dsf',
  '.dff',
]);

const SCAN_CONCURRENCY = 8;

function makeTrackId(absPath) {
  return 'trk_' + crypto.createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

/**
 * Local Music Library Manager backed by Embedded SQLite (`data/ourmusic.db`, WAL + FTS5)
 * and Real-Time Cross-Platform OS File Watching (`inotify` / `ReadDirectoryChangesW`).
 */
export class LibraryManager extends EventEmitter {
  constructor({
    dataDir,
    engineBridge = null,
    database = null,
    watchFolders = true,
    watcherDebounceMs = 200,
  } = {}) {
    super();
    this.dataDir = path.resolve(dataDir);
    this.engineBridge = engineBridge;
    this.coversDir = path.join(this.dataDir, 'covers');
    fs.mkdirSync(this.coversDir, { recursive: true });

    this._ownsDb = !database;
    this.db = database || new MusicDatabase(this.dataDir);

    this.scanning = false;
    this.scanProgress = { scanned: 0, total: 0, currentFile: '' };

    this.watcher = null;
    if (watchFolders) {
      this.watcher = new FolderWatcher({
        supportedExtensions: SUPPORTED_AUDIO_EXTENSIONS,
        debounceMs: watcherDebounceMs,
        onFileChanged: (filePath) => this._onWatchedFileChanged(filePath),
        onFileRemoved: (filePath) => this._onWatchedFileRemoved(filePath),
        onDirectoryAdded: (dirPath) => this._onWatchedDirectoryAdded(dirPath),
        onDirectoryRemoved: (dirPath) => this._onWatchedDirectoryRemoved(dirPath),
      });
      for (const folder of this.db.listFolders()) {
        this.watcher.watchRoot(folder).catch(() => {});
      }
    }
  }

  get watchedFolders() {
    return this.db.listFolders();
  }

  _save() {
    // No-op kept for backward compatibility: SQLite WAL commits atomically per transaction.
  }

  async _onWatchedFileChanged(filePath) {
    if (this.scanning) return;
    try {
      const rec = await this.indexSingleFile(filePath);
      if (rec) {
        this.emit('watcher_indexed', rec);
        this.emit('library_changed', { reason: 'file_changed', track: rec });
      }
    } catch {
      // Ignore unreadable/incomplete external files
    }
  }

  async _onWatchedFileRemoved(filePath) {
    if (this.scanning) return;
    const removed = this.db.deleteTrackByPath(filePath);
    if (removed) {
      this.emit('watcher_removed', { filePath });
      this.emit('library_changed', { reason: 'file_removed', filePath });
    }
  }

  async _onWatchedDirectoryAdded(dirPath) {
    if (this.scanning) return;
    const files = await this._collectAudioFiles(dirPath);
    if (files.length === 0) return;
    let indexedCount = 0;
    for (const f of files) {
      try {
        await this.indexSingleFile(f);
        indexedCount++;
      } catch {
        // continue
      }
    }
    if (indexedCount > 0) {
      this.emit('library_changed', { reason: 'directory_added', dirPath, indexedCount });
    }
  }

  async _onWatchedDirectoryRemoved(dirPath) {
    if (this.scanning) return;
    const removedCount = this.db.deleteTracksUnderDir(dirPath);
    if (removedCount > 0) {
      this.emit('watcher_removed', { dirPath, removedCount });
      this.emit('library_changed', { reason: 'directory_removed', dirPath, removedCount });
    }
  }

  _cacheCoverArt(coverArt) {
    if (!coverArt || !Buffer.isBuffer(coverArt.data) || coverArt.data.length === 0) {
      return null;
    }
    const ext = String(coverArt.mime || '').includes('png') ? '.png' : '.jpg';
    const hash = crypto.createHash('sha1').update(coverArt.data).digest('hex').slice(0, 20);
    const fileName = `${hash}${ext}`;
    const full = path.join(this.coversDir, fileName);
    if (!fs.existsSync(full)) {
      fs.writeFileSync(full, coverArt.data);
    }
    return {
      id: fileName,
      mime: coverArt.mime || 'image/jpeg',
    };
  }

  getCoverFilePath(coverId) {
    const safe = path.basename(String(coverId || ''));
    if (!safe) return null;
    const p = path.join(this.coversDir, safe);
    return fs.existsSync(p) ? p : null;
  }

  async _collectAudioFiles(rootDir) {
    const results = [];
    const stack = [path.resolve(rootDir)];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = await fsp.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        const full = path.join(current, ent.name);
        if (ent.isDirectory()) {
          stack.push(full);
        } else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (SUPPORTED_AUDIO_EXTENSIONS.has(ext)) {
            results.push(full);
          }
        }
      }
    }
    results.sort();
    return results;
  }

  async _prepareTrackPayload(filePath, { forceReindex = false, folderId = null } = {}) {
    const absPath = path.resolve(filePath);
    const stat = await fsp.stat(absPath);
    const existing = this.db.getTrackStatByPath(absPath);
    if (
      !forceReindex &&
      existing &&
      existing.mtimeMs === stat.mtimeMs &&
      existing.sizeBytes === stat.size
    ) {
      return { unchanged: true, track: this.db.getTrackById(existing.id) };
    }

    const meta = await readMetadata(absPath, {
      probeAudio: true,
      engineBridge: this.engineBridge,
    });
    if (!meta.audio) {
      throw new Error(`Formato no soportado o archivo corrupto: ${absPath}`);
    }

    const coverRef = this._cacheCoverArt(meta.coverArt);
    const codec = meta.audio.codec || path.extname(absPath).slice(1).toUpperCase();
    const sampleRate = meta.audio.sampleRate || 44100;
    const bitDepth = meta.audio.bitDepth || 16;
    const dsdBitRate = meta.audio.dsdBitRate || 0;
    const isLossless = ['FLAC', 'ALAC', 'WAV', 'DSD'].includes(codec);
    const isHiRes = dsdBitRate > 0 || sampleRate > 48000 || (isLossless && bitDepth > 16);

    const record = {
      id: makeTrackId(absPath),
      filePath: absPath,
      fileName: path.basename(absPath),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      tagFormat: meta.tagFormat,
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      year: parseInt(meta.year, 10) || (meta.year ? meta.year : ''),
      composer: meta.composer,
      genre: meta.genre,
      trackNumber: meta.trackNumber,
      hasSyncedLyrics: Array.isArray(meta.syncedLyrics) && meta.syncedLyrics.length > 0,
      hasLyrics: Boolean(meta.lyrics || (meta.syncedLyrics && meta.syncedLyrics.length > 0)),
      hasCover: Boolean(coverRef),
      coverId: coverRef ? coverRef.id : null,
      codec,
      sampleRate,
      bitDepth,
      channels: meta.audio.channels || 2,
      durationSec: Number(meta.audio.durationSec) || 0,
      dsdBitRate,
      isLossless,
      isHiRes,
      replayGainTrackDb: meta.replayGainTrackDb ?? existing?.replayGainTrackDb ?? null,
      replayGainTrackPeak: meta.replayGainTrackPeak ?? existing?.replayGainTrackPeak ?? null,
      replayGainAlbumDb: meta.replayGainAlbumDb ?? existing?.replayGainAlbumDb ?? null,
      replayGainAlbumPeak: meta.replayGainAlbumPeak ?? existing?.replayGainAlbumPeak ?? null,
      integratedLufs: existing?.integratedLufs ?? null,
      loudnessRangeLu: existing?.loudnessRangeLu ?? null,
      truePeakDbtp: existing?.truePeakDbtp ?? null,
      addedAt: existing?.addedAt || new Date().toISOString(),
    };

    return {
      unchanged: false,
      record,
      lyricsText: meta.lyrics || '',
      folderId,
    };
  }

  async indexSingleFile(filePath, { forceReindex = false, folderId = null } = {}) {
    const prep = await this._prepareTrackPayload(filePath, { forceReindex, folderId });
    if (prep.unchanged) return prep.track;
    return this.db.upsertTrack(prep.record, {
      lyricsText: prep.lyricsText,
      folderId: prep.folderId,
    });
  }

  async scanDirectory(dirPath) {
    const absDir = path.resolve(dirPath);
    const st = await fsp.stat(absDir).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`El directorio no existe o no es accesible: ${absDir}`);
    }

    const folderRow = this.db.addFolder(absDir);
    const folderId = folderRow?.id ?? null;

    this.scanning = true;
    const files = await this._collectAudioFiles(absDir);
    this.scanProgress = { scanned: 0, total: files.length, currentFile: '' };
    this.emit('scan_started', { directory: absDir, total: files.length });

    const preparedPayloads = new Array(files.length);
    const errors = [];
    let cursor = 0;
    let completed = 0;

    const workerCount = Math.min(SCAN_CONCURRENCY, Math.max(1, files.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= files.length) break;
        const f = files[idx];
        try {
          preparedPayloads[idx] = await this._prepareTrackPayload(f, { folderId });
        } catch (err) {
          errors.push({ file: f, error: err.message });
        }
        completed++;
        this.scanProgress = {
          scanned: completed,
          total: files.length,
          currentFile: path.basename(f),
        };
        if ((completed & 3) === 0 || completed === files.length) {
          this.emit('scan_progress', { ...this.scanProgress });
          await new Promise((r) => setImmediate(r));
        }
      }
    });

    await Promise.all(workers);

    // Atomic batch upsert + deleted-file pruning inside a single SQLite WAL transaction!
    const foundPaths = new Set(files);
    let indexedCount = 0;

    this.db.runInTransaction(() => {
      for (const item of preparedPayloads) {
        if (!item) continue;
        if (item.unchanged) {
          if (item.track) indexedCount++;
        } else {
          this.db.upsertTrack(item.record, {
            lyricsText: item.lyricsText,
            folderId: item.folderId,
          });
          indexedCount++;
        }
      }

      const existingUnderDir = this.db.listTracksUnderDir(absDir);
      let prunedAny = false;
      for (const row of existingUnderDir) {
        if (!foundPaths.has(row.file_path) && !fs.existsSync(row.file_path)) {
          this.db.stmts.deleteTrackByPath.run(row.file_path);
          prunedAny = true;
        }
      }
      if (prunedAny) {
        this.db.pruneOrphanEntities();
      }
    });

    if (this.watcher) {
      await this.watcher.watchRoot(absDir).catch(() => {});
    }

    this.scanning = false;
    this.scanProgress = { scanned: files.length, total: files.length, currentFile: '' };
    const totalLibraryTracks = this.db.countTracks();

    this.emit('scan_completed', {
      directory: absDir,
      indexedCount,
      totalLibraryTracks,
      errors,
    });

    return {
      directory: absDir,
      indexedCount,
      totalLibraryTracks,
      errors,
    };
  }

  removeFolder(dirPath) {
    const absDir = path.resolve(dirPath);
    this.watcher?.unwatchRoot(absDir);
    this.db.removeFolderAndTracks(absDir);
  }

  getTrack(id) {
    return this.db.getTrackById(id);
  }

  getTrackByPath(filePath) {
    return this.db.getTrackByPath(filePath);
  }

  getAllTracks() {
    return this.db.queryTracksPaginated().tracks;
  }

  queryTracks(opts = {}) {
    return this.db.queryTracksPaginated(opts).tracks;
  }

  queryTracksPaginated(opts = {}) {
    return this.db.queryTracksPaginated(opts);
  }

  getSummary() {
    return this.db.getSummary();
  }

  getDatabaseStats() {
    return {
      ...this.db.getStats(),
      activeWatchers: this.watcher ? this.watcher.watchedRootCount() : 0,
    };
  }

  async getTrackFullMetadata(trackId) {
    const trk = this.getTrack(trackId);
    if (!trk) throw new Error('Pista no encontrada en biblioteca');
    const meta = await readMetadata(trk.filePath, {
      probeAudio: false,
      engineBridge: this.engineBridge,
    });
    return {
      ...trk,
      lyrics: meta.lyrics,
      syncedLyrics: meta.syncedLyrics,
      tagFormat: meta.tagFormat,
    };
  }

  async updateTrackMetadata(trackId, patch) {
    const trk = this.getTrack(trackId);
    if (!trk) throw new Error('Pista no encontrada en biblioteca');
    await writeMetadata(trk.filePath, patch);
    const updated = await this.indexSingleFile(trk.filePath, { forceReindex: true });
    this.emit('track_updated', updated);
    return this.getTrackFullMetadata(updated.id);
  }

  async analyzeTrackLoudness(trackId, { writeTags = false } = {}) {
    const trk = this.getTrack(trackId);
    if (!trk) throw new Error('Pista no encontrada en biblioteca');

    const res = this.engineBridge
      ? await this.engineBridge.scanLoudness(trk.filePath)
      : await EngineBridge.scanLoudnessCli(trk.filePath);

    let mtimeMs = trk.mtimeMs;
    let sizeBytes = trk.sizeBytes;

    if (writeTags) {
      await writeMetadata(trk.filePath, {
        replayGainTrackDb: res.replayGain18Db,
        replayGainTrackPeak: res.truePeak,
      });
      const st = await fsp.stat(trk.filePath);
      mtimeMs = st.mtimeMs;
      sizeBytes = st.size;
    }

    const updated = this.db.updateTrackLoudness(trk.id, {
      integratedLufs: res.integratedLufs,
      loudnessRangeLu: res.loudnessRangeLu,
      truePeakDbtp: res.truePeakDbtp,
      replayGainTrackDb: res.replayGain18Db,
      replayGainTrackPeak: res.truePeak,
      mtimeMs,
      sizeBytes,
    });

    this.emit('track_updated', updated);
    return { track: updated, loudness: res };
  }

  close() {
    this.watcher?.close();
    this.watcher = null;
    if (this._ownsDb && this.db) {
      this.db.close();
    }
  }
}
