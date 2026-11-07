import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { readMetadata, writeMetadata } from '../tags/tagParser.mjs';
import { EngineBridge } from '../engine/engineBridge.mjs';

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
 * Local Music Library Manager — performs bounded-concurrency parallel recursive directory scanning,
 * O(metadata) header-only tag indexing, ITU-R BS.1770-4 / EBU R128 loudness analysis,
 * cover art deduplication, fast search/filtering, and tag editing.
 */
export class LibraryManager extends EventEmitter {
  constructor({ dataDir, engineBridge = null } = {}) {
    super();
    this.dataDir = dataDir;
    this.engineBridge = engineBridge;
    this.indexPath = path.join(dataDir, 'library.json');
    this.coversDir = path.join(dataDir, 'covers');
    this.tracksById = new Map();
    this.tracksByPath = new Map();
    this.watchedFolders = [];
    this.scanning = false;
    this.scanProgress = { scanned: 0, total: 0, currentFile: '' };
    this._load();
  }

  _load() {
    fs.mkdirSync(this.coversDir, { recursive: true });
    if (!fs.existsSync(this.indexPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (Array.isArray(parsed.folders)) this.watchedFolders = parsed.folders;
      if (Array.isArray(parsed.tracks)) {
        for (const t of parsed.tracks) {
          if (t && t.id && t.filePath) {
            this.tracksById.set(t.id, t);
            this.tracksByPath.set(t.filePath, t);
          }
        }
      }
    } catch {
      // Corrupted index starts clean
    }
  }

  _save() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      folders: this.watchedFolders,
      tracks: Array.from(this.tracksById.values()),
    };
    fs.writeFileSync(this.indexPath, JSON.stringify(payload, null, 2), 'utf8');
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

  async indexSingleFile(filePath, { saveAfter = false } = {}) {
    const absPath = path.resolve(filePath);
    const stat = await fsp.stat(absPath);
    const existing = this.tracksByPath.get(absPath);
    if (existing && existing.mtimeMs === stat.mtimeMs && existing.sizeBytes === stat.size) {
      return existing;
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

    this.tracksById.set(record.id, record);
    this.tracksByPath.set(absPath, record);
    if (saveAfter) this._save();
    return record;
  }

  async scanDirectory(dirPath) {
    const absDir = path.resolve(dirPath);
    const st = await fsp.stat(absDir).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(`El directorio no existe o no es accesible: ${absDir}`);
    }

    if (!this.watchedFolders.includes(absDir)) {
      this.watchedFolders.push(absDir);
    }

    this.scanning = true;
    const files = await this._collectAudioFiles(absDir);
    this.scanProgress = { scanned: 0, total: files.length, currentFile: '' };
    this.emit('scan_started', { directory: absDir, total: files.length });

    const indexed = new Array(files.length);
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
          indexed[idx] = await this.indexSingleFile(f, { saveAfter: false });
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

    const validIndexed = indexed.filter(Boolean);

    // Prune deleted files under absDir
    for (const [p, trk] of this.tracksByPath.entries()) {
      if (p.startsWith(absDir + path.sep) && !fs.existsSync(p)) {
        this.tracksByPath.delete(p);
        this.tracksById.delete(trk.id);
      }
    }

    this.scanning = false;
    this.scanProgress = { scanned: files.length, total: files.length, currentFile: '' };
    this._save();
    this.emit('scan_completed', {
      directory: absDir,
      indexedCount: validIndexed.length,
      totalLibraryTracks: this.tracksById.size,
      errors,
    });

    return {
      directory: absDir,
      indexedCount: validIndexed.length,
      totalLibraryTracks: this.tracksById.size,
      errors,
    };
  }

  removeFolder(dirPath) {
    const absDir = path.resolve(dirPath);
    this.watchedFolders = this.watchedFolders.filter((d) => d !== absDir);
    for (const [p, trk] of this.tracksByPath.entries()) {
      if (p === absDir || p.startsWith(absDir + path.sep)) {
        this.tracksByPath.delete(p);
        this.tracksById.delete(trk.id);
      }
    }
    this._save();
  }

  getTrack(id) {
    return this.tracksById.get(id) || null;
  }

  getTrackByPath(filePath) {
    return this.tracksByPath.get(path.resolve(filePath)) || null;
  }

  getAllTracks() {
    return Array.from(this.tracksById.values());
  }

  queryTracks({
    search = '',
    codec = '',
    artist = '',
    album = '',
    composer = '',
    hiResOnly = false,
    losslessOnly = false,
    syncedLyricsOnly = false,
    sortBy = 'title',
    sortOrder = 'asc',
  } = {}) {
    const q = String(search || '').trim().toLowerCase();
    const codecUpper = String(codec || '').trim().toUpperCase();
    const artistLower = String(artist || '').trim().toLowerCase();
    const albumLower = String(album || '').trim().toLowerCase();
    const compLower = String(composer || '').trim().toLowerCase();

    const filtered = [];
    for (const t of this.tracksById.values()) {
      if (codecUpper && t.codec.toUpperCase() !== codecUpper) continue;
      if (hiResOnly && !t.isHiRes) continue;
      if (losslessOnly && !t.isLossless) continue;
      if (syncedLyricsOnly && !t.hasSyncedLyrics) continue;
      if (artistLower && t.artist.toLowerCase() !== artistLower) continue;
      if (albumLower && t.album.toLowerCase() !== albumLower) continue;
      if (compLower && !String(t.composer || '').toLowerCase().includes(compLower)) continue;

      if (q) {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.composer} ${t.genre} ${t.codec} ${t.fileName}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      filtered.push(t);
    }

    const dir = sortOrder === 'desc' ? -1 : 1;
    filtered.sort((a, b) => {
      const va = a[sortBy] ?? '';
      const vb = b[sortBy] ?? '';
      if (typeof va === 'number' && typeof vb === 'number') {
        return (va - vb) * dir;
      }
      return String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' }) * dir;
    });

    return filtered;
  }

  getSummary() {
    const codecs = {};
    const albums = new Map();
    const artists = new Map();
    let hiResCount = 0;
    let totalDurationSec = 0;

    for (const t of this.tracksById.values()) {
      codecs[t.codec] = (codecs[t.codec] || 0) + 1;
      if (t.isHiRes) hiResCount++;
      totalDurationSec += t.durationSec || 0;

      const albKey = `${t.album}:::${t.artist}`;
      if (!albums.has(albKey)) {
        albums.set(albKey, {
          album: t.album,
          artist: t.artist,
          year: t.year,
          coverId: t.coverId,
          trackCount: 0,
        });
      }
      const alb = albums.get(albKey);
      alb.trackCount++;
      if (!alb.coverId && t.coverId) alb.coverId = t.coverId;

      artists.set(t.artist, (artists.get(t.artist) || 0) + 1);
    }

    return {
      totalTracks: this.tracksById.size,
      totalAlbums: albums.size,
      totalArtists: artists.size,
      hiResCount,
      totalDurationSec,
      codecs,
      folders: this.watchedFolders,
      albums: Array.from(albums.values()).sort((a, b) => a.album.localeCompare(b.album, 'es')),
      artists: Array.from(artists.entries())
        .map(([name, trackCount]) => ({ name, trackCount }))
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
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
    trk.mtimeMs = 0;
    const updated = await this.indexSingleFile(trk.filePath, { saveAfter: true });
    this.emit('track_updated', updated);
    return this.getTrackFullMetadata(updated.id);
  }

  async analyzeTrackLoudness(trackId, { writeTags = false } = {}) {
    const trk = this.getTrack(trackId);
    if (!trk) throw new Error('Pista no encontrada en biblioteca');

    const res = this.engineBridge
      ? await this.engineBridge.scanLoudness(trk.filePath)
      : await EngineBridge.scanLoudnessCli(trk.filePath);

    trk.integratedLufs = res.integratedLufs;
    trk.loudnessRangeLu = res.loudnessRangeLu;
    trk.truePeakDbtp = res.truePeakDbtp;
    trk.replayGainTrackDb = res.replayGain18Db;
    trk.replayGainTrackPeak = res.truePeak;

    if (writeTags) {
      await writeMetadata(trk.filePath, {
        replayGainTrackDb: res.replayGain18Db,
        replayGainTrackPeak: res.truePeak,
      });
      const st = await fsp.stat(trk.filePath);
      trk.mtimeMs = st.mtimeMs;
      trk.sizeBytes = st.size;
    }

    this._save();
    this.emit('track_updated', trk);
    return { track: trk, loudness: res };
  }
}
