import fs from 'node:fs';
import path from 'node:path';
import { readId3File, writeId3File } from './id3v2.mjs';
import { readFlacTags, writeFlacTags } from './flacTags.mjs';
import { readMp4Tags, writeMp4Tags } from './mp4Tags.mjs';
import { parseLrc, formatLrc } from './lrc.mjs';
import { EngineBridge } from '../engine/engineBridge.mjs';

const COVER_CANDIDATES = ['cover.jpg', 'cover.jpeg', 'cover.png', 'folder.jpg', 'front.jpg'];

function detectTagBackend(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.flac') return 'flac';
  if (ext === '.m4a' || ext === '.mp4' || ext === '.alac') return 'mp4';
  if (ext === '.mp3' || ext === '.wav' || ext === '.dsf') return 'id3';
  if (ext === '.dff') return 'dff';
  return 'id3';
}

function findSidecarLyrics(filePath) {
  const parsed = path.parse(filePath);
  const lrcPath = path.join(parsed.dir, `${parsed.name}.lrc`);
  if (fs.existsSync(lrcPath)) {
    try {
      const txt = fs.readFileSync(lrcPath, 'utf8');
      return { lyrics: txt, syncedLyrics: parseLrc(txt), sidecarPath: lrcPath };
    } catch {
      return null;
    }
  }
  return null;
}

function findFolderCover(filePath) {
  const dir = path.dirname(filePath);
  for (const name of COVER_CANDIDATES) {
    const candidate = path.join(dir, name);
    if (fs.existsSync(candidate)) {
      try {
        const data = fs.readFileSync(candidate);
        const mime = name.endsWith('.png') ? 'image/png' : 'image/jpeg';
        return { mime, data, external: true };
      } catch {
        // continue
      }
    }
  }
  return null;
}

/**
 * Unified Metadata Analyzer (Tag Parser) — reads embedded tags, synced lyrics, cover art,
 * ReplayGain 2.0 / EBU R128 loudness tags, and exact stream parameters across FLAC (Vorbis),
 * M4A/ALAC (MP4 ilst), and MP3/WAV/DSF (ID3v2) using O(metadata) header-only slices.
 */
export async function readMetadata(
  filePath,
  { probeAudio = true, engineBridge = null, includeCoverArt = true } = {},
) {
  const absPath = path.resolve(filePath);
  const backend = detectTagBackend(absPath);

  let rawTags;
  if (backend === 'flac') {
    rawTags = readFlacTags(absPath, { includeCoverArt });
  } else if (backend === 'mp4') {
    rawTags = readMp4Tags(absPath, { includeCoverArt });
  } else if (backend === 'id3') {
    rawTags = readId3File(absPath, { includeCoverArt });
  } else {
    rawTags = {
      tagFormat: 'DSDIFF / Sidecar',
      title: '',
      artist: '',
      album: '',
      year: '',
      composer: '',
      genre: '',
      trackNumber: '',
      lyrics: '',
      syncedLyrics: [],
      coverArt: null,
      replayGainTrackDb: null,
      replayGainTrackPeak: null,
      replayGainAlbumDb: null,
      replayGainAlbumPeak: null,
    };
  }

  if (!rawTags.lyrics && rawTags.syncedLyrics.length === 0) {
    const side = findSidecarLyrics(absPath);
    if (side) {
      rawTags.lyrics = side.lyrics;
      rawTags.syncedLyrics = side.syncedLyrics;
    }
  }

  if (includeCoverArt && !rawTags.coverArt) {
    const folderCover = findFolderCover(absPath);
    if (folderCover) rawTags.coverArt = folderCover;
  }

  const baseName = path.basename(absPath, path.extname(absPath));
  if (!rawTags.title) rawTags.title = baseName;

  let streamInfo = null;
  if (probeAudio) {
    try {
      streamInfo = engineBridge
        ? await engineBridge.probe(absPath)
        : await EngineBridge.probeCli(absPath);
    } catch {
      streamInfo = null;
    }
  }

  return {
    filePath: absPath,
    tagFormat: rawTags.tagFormat || backend.toUpperCase(),
    title: rawTags.title,
    artist: rawTags.artist || 'Artista Desconocido',
    album: rawTags.album || 'Álbum Desconocido',
    year: rawTags.year || '',
    composer: rawTags.composer || '',
    genre: rawTags.genre || '',
    trackNumber: rawTags.trackNumber || '',
    lyrics: rawTags.lyrics || '',
    syncedLyrics: rawTags.syncedLyrics || [],
    coverArt: rawTags.coverArt,
    replayGainTrackDb: rawTags.replayGainTrackDb ?? null,
    replayGainTrackPeak: rawTags.replayGainTrackPeak ?? null,
    replayGainAlbumDb: rawTags.replayGainAlbumDb ?? null,
    replayGainAlbumPeak: rawTags.replayGainAlbumPeak ?? null,
    audio: streamInfo,
  };
}

/**
 * Unified Metadata Writer — updates embedded tags, synchronized lyrics, ReplayGain, and cover art
 * directly inside FLAC (Vorbis+PICTURE), M4A/ALAC (MP4 ilst), and MP3/WAV/DSF (ID3v2.4).
 */
export async function writeMetadata(filePath, patch = {}) {
  const absPath = path.resolve(filePath);
  const backend = detectTagBackend(absPath);
  const current = await readMetadata(absPath, { probeAudio: false });

  let coverArt = current.coverArt && !current.coverArt.external ? current.coverArt : null;
  if (patch.coverArt === null) {
    coverArt = null;
  } else if (patch.coverArt && patch.coverArt.data) {
    const buf = Buffer.isBuffer(patch.coverArt.data)
      ? patch.coverArt.data
      : Buffer.from(patch.coverArt.data, 'base64');
    coverArt = { mime: patch.coverArt.mime || 'image/jpeg', data: buf };
  }

  let lyrics = patch.lyrics !== undefined ? String(patch.lyrics) : current.lyrics;
  let syncedLyrics =
    patch.syncedLyrics !== undefined ? patch.syncedLyrics : parseLrc(lyrics);
  if (Array.isArray(patch.syncedLyrics) && patch.lyrics === undefined) {
    lyrics = formatLrc(patch.syncedLyrics);
  }

  const merged = {
    title: patch.title !== undefined ? String(patch.title) : current.title,
    artist: patch.artist !== undefined ? String(patch.artist) : (current.artist === 'Artista Desconocido' ? '' : current.artist),
    album: patch.album !== undefined ? String(patch.album) : (current.album === 'Álbum Desconocido' ? '' : current.album),
    year: patch.year !== undefined ? String(patch.year) : current.year,
    composer: patch.composer !== undefined ? String(patch.composer) : current.composer,
    genre: patch.genre !== undefined ? String(patch.genre) : current.genre,
    trackNumber: patch.trackNumber !== undefined ? String(patch.trackNumber) : current.trackNumber,
    lyrics,
    syncedLyrics,
    coverArt,
    replayGainTrackDb:
      patch.replayGainTrackDb !== undefined ? patch.replayGainTrackDb : current.replayGainTrackDb,
    replayGainTrackPeak:
      patch.replayGainTrackPeak !== undefined ? patch.replayGainTrackPeak : current.replayGainTrackPeak,
    replayGainAlbumDb:
      patch.replayGainAlbumDb !== undefined ? patch.replayGainAlbumDb : current.replayGainAlbumDb,
    replayGainAlbumPeak:
      patch.replayGainAlbumPeak !== undefined ? patch.replayGainAlbumPeak : current.replayGainAlbumPeak,
  };

  if (backend === 'flac') {
    writeFlacTags(absPath, merged);
  } else if (backend === 'mp4') {
    writeMp4Tags(absPath, merged);
  } else if (backend === 'id3') {
    writeId3File(absPath, merged);
  } else if (backend === 'dff') {
    if (lyrics) {
      const parsed = path.parse(absPath);
      fs.writeFileSync(path.join(parsed.dir, `${parsed.name}.lrc`), lyrics, 'utf8');
    }
  }

  return readMetadata(absPath, { probeAudio: false });
}
