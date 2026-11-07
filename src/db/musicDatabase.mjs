import fs from 'node:fs';
import path from 'node:path';

// Suppress Node's one-time ExperimentalWarning specifically for built-in node:sqlite
const _origEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...args) {
  const msg = typeof warning === 'string' ? warning : warning?.message || '';
  if (msg.includes('SQLite')) return;
  return _origEmitWarning.call(process, warning, ...args);
};

const { DatabaseSync } = await import('node:sqlite');

const TRACK_LIST_COLS = `
  t.id,
  t.file_path,
  t.folder_id,
  t.file_name,
  t.size_bytes,
  t.mtime_ms,
  t.tag_format,
  t.title,
  t.artist,
  t.artist_id,
  t.album,
  t.album_id,
  t.year,
  t.composer,
  t.genre,
  t.track_number,
  t.has_lyrics,
  t.has_synced_lyrics,
  t.has_cover,
  t.cover_id,
  t.codec,
  t.sample_rate,
  t.bit_depth,
  t.channels,
  t.duration_sec,
  t.dsd_bit_rate,
  t.is_lossless,
  t.is_hires,
  t.replaygain_track_db,
  t.replaygain_track_peak,
  t.replaygain_album_db,
  t.replaygain_album_peak,
  t.integrated_lufs,
  t.loudness_range_lu,
  t.true_peak_dbtp,
  t.added_at
`;

const FIELD_TO_SQL_COL = {
  id: 't.id',
  filePath: 't.file_path',
  fileName: 't.file_name',
  sizeBytes: 't.size_bytes',
  mtimeMs: 't.mtime_ms',
  tagFormat: 't.tag_format',
  title: 't.title',
  artist: 't.artist',
  album: 't.album',
  year: 't.year',
  composer: 't.composer',
  genre: 't.genre',
  trackNumber: 't.track_number',
  hasLyrics: 't.has_lyrics',
  hasSyncedLyrics: 't.has_synced_lyrics',
  hasCover: 't.has_cover',
  codec: 't.codec',
  sampleRate: 't.sample_rate',
  bitDepth: 't.bit_depth',
  channels: 't.channels',
  durationSec: 't.duration_sec',
  dsdBitRate: 't.dsd_bit_rate',
  isLossless: 't.is_lossless',
  isHiRes: 't.is_hires',
  replayGainTrackDb: 't.replaygain_track_db',
  replayGainTrackPeak: 't.replaygain_track_peak',
  replayGainAlbumDb: 't.replaygain_album_db',
  replayGainAlbumPeak: 't.replaygain_album_peak',
  integratedLufs: 't.integrated_lufs',
  loudnessRangeLu: 't.loudness_range_lu',
  truePeakDbtp: 't.true_peak_dbtp',
  addedAt: 't.added_at',
};

const NUMERIC_SORT_FIELDS = new Set([
  'sizeBytes',
  'mtimeMs',
  'year',
  'sampleRate',
  'bitDepth',
  'channels',
  'durationSec',
  'dsdBitRate',
  'replayGainTrackDb',
  'integratedLufs',
  'loudnessRangeLu',
  'truePeakDbtp',
]);

function escapeLike(str) {
  return String(str ?? '').replace(/[\\%_]/g, '\\$&');
}

function buildFtsMatchQuery(rawSearch) {
  const tokens = String(rawSearch || '').match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens.map((tok) => `"${tok.replace(/"/g, '""')}"*`).join(' AND ');
}

export function rowToTrack(row) {
  if (!row) return null;
  const rawYear = row.year ?? '';
  const parsedYear = /^\d+$/.test(String(rawYear)) ? parseInt(rawYear, 10) : rawYear;
  return {
    id: row.id,
    filePath: row.file_path,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    mtimeMs: row.mtime_ms,
    tagFormat: row.tag_format || '',
    title: row.title,
    artist: row.artist,
    artistId: row.artist_id ?? null,
    album: row.album,
    albumId: row.album_id ?? null,
    year: parsedYear,
    composer: row.composer || '',
    genre: row.genre || '',
    trackNumber: row.track_number || '',
    hasSyncedLyrics: Boolean(row.has_synced_lyrics),
    hasLyrics: Boolean(row.has_lyrics),
    hasCover: Boolean(row.has_cover),
    coverId: row.cover_id || null,
    codec: row.codec,
    sampleRate: row.sample_rate,
    bitDepth: row.bit_depth,
    channels: row.channels,
    durationSec: row.duration_sec,
    dsdBitRate: row.dsd_bit_rate || 0,
    isLossless: Boolean(row.is_lossless),
    isHiRes: Boolean(row.is_hires),
    replayGainTrackDb: row.replaygain_track_db ?? null,
    replayGainTrackPeak: row.replaygain_track_peak ?? null,
    replayGainAlbumDb: row.replaygain_album_db ?? null,
    replayGainAlbumPeak: row.replaygain_album_peak ?? null,
    integratedLufs: row.integrated_lufs ?? null,
    loudnessRangeLu: row.loudness_range_lu ?? null,
    truePeakDbtp: row.true_peak_dbtp ?? null,
    addedAt: row.added_at,
  };
}

function buildOrderBySql(sortBy = 'title', sortOrder = 'asc') {
  const dir = String(sortOrder).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
  const col = FIELD_TO_SQL_COL[sortBy] || 't.title';
  if (NUMERIC_SORT_FIELDS.has(sortBy)) {
    return `CAST(${col} AS REAL) ${dir}, t.title COLLATE NOCASE ASC`;
  }
  if (sortBy === 'trackNumber') {
    return `CAST(t.track_number AS INTEGER) ${dir}, t.title COLLATE NOCASE ASC`;
  }
  return `${col} COLLATE NOCASE ${dir}, t.id ASC`;
}

function compileSingleSmartRule(rule) {
  if (!rule || !rule.field) return { sql: '1 = 1', params: [] };
  const col = FIELD_TO_SQL_COL[rule.field];
  if (!col) return null;

  const op = String(rule.operator || 'contains').toLowerCase();
  if (op === 'is_true') return { sql: `${col} = 1`, params: [] };
  if (op === 'is_false') return { sql: `(${col} = 0 OR ${col} IS NULL)`, params: [] };

  if (['gt', 'gte', 'lt', 'lte', 'between', 'num_eq'].includes(op)) {
    const target = Number(rule.value);
    if (!Number.isFinite(target)) return { sql: '1 = 0', params: [] };
    const numExpr = `CAST(${col} AS REAL)`;
    if (op === 'gt') return { sql: `(${col} IS NOT NULL AND ${numExpr} > ?)`, params: [target] };
    if (op === 'gte') return { sql: `(${col} IS NOT NULL AND ${numExpr} >= ?)`, params: [target] };
    if (op === 'lt') return { sql: `(${col} IS NOT NULL AND ${numExpr} < ?)`, params: [target] };
    if (op === 'lte') return { sql: `(${col} IS NOT NULL AND ${numExpr} <= ?)`, params: [target] };
    if (op === 'num_eq') return { sql: `(${col} IS NOT NULL AND ${numExpr} = ?)`, params: [target] };
    if (op === 'between') {
      const hi = Number(rule.valueTo);
      if (!Number.isFinite(hi)) return { sql: '1 = 0', params: [] };
      return {
        sql: `(${col} IS NOT NULL AND ${numExpr} BETWEEN ? AND ?)`,
        params: [Math.min(target, hi), Math.max(target, hi)],
      };
    }
  }

  const sTarget = String(rule.value ?? '');
  const strExpr = `LOWER(COALESCE(CAST(${col} AS TEXT), ''))`;
  if (op === 'equals' || op === 'is') {
    return { sql: `${strExpr} = LOWER(?)`, params: [sTarget] };
  }
  if (op === 'not_equals' || op === 'is_not') {
    return { sql: `${strExpr} != LOWER(?)`, params: [sTarget] };
  }
  if (op === 'starts_with') {
    return { sql: `${strExpr} LIKE LOWER(?) ESCAPE '\\'`, params: [`${escapeLike(sTarget)}%`] };
  }
  if (op === 'ends_with') {
    return { sql: `${strExpr} LIKE LOWER(?) ESCAPE '\\'`, params: [`%${escapeLike(sTarget)}`] };
  }
  if (op === 'not_contains') {
    return { sql: `${strExpr} NOT LIKE LOWER(?) ESCAPE '\\'`, params: [`%${escapeLike(sTarget)}%`] };
  }
  return { sql: `${strExpr} LIKE LOWER(?) ESCAPE '\\'`, params: [`%${escapeLike(sTarget)}%`] };
}

/**
 * Clean-Room Embedded Local Relational + FTS5 SQLite Engine (`data/ourmusic.db`).
 * Provides ACID WAL transactions, zero-RAM-bloat SQL pagination, sub-millisecond FTS5 search,
 * relational Folders/Artists/Albums/Tracks/Playlists tables, and compiled SQL Smart Playlists.
 */
export class MusicDatabase {
  constructor(dataDir) {
    this.dataDir = path.resolve(dataDir);
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, 'ourmusic.db');
    this.db = new DatabaseSync(this.dbPath);
    this._inTxDepth = 0;

    this._initPragmasAndSchema();
    this._prepareStatements();
    this._migrateLegacyJsonIfNeeded();
  }

  _initPragmasAndSchema() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA cache_size = -32000;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        added_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS artists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE
      );

      CREATE TABLE IF NOT EXISTS albums (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL COLLATE NOCASE,
        artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
        year TEXT,
        cover_id TEXT,
        UNIQUE(title, artist_id)
      );

      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL UNIQUE,
        folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
        file_name TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        mtime_ms REAL NOT NULL,
        tag_format TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        artist_id INTEGER REFERENCES artists(id) ON DELETE SET NULL,
        album TEXT NOT NULL,
        album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
        year TEXT,
        composer TEXT,
        genre TEXT,
        track_number TEXT,
        lyrics TEXT,
        has_lyrics INTEGER NOT NULL DEFAULT 0,
        has_synced_lyrics INTEGER NOT NULL DEFAULT 0,
        has_cover INTEGER NOT NULL DEFAULT 0,
        cover_id TEXT,
        codec TEXT NOT NULL,
        sample_rate INTEGER NOT NULL,
        bit_depth INTEGER NOT NULL,
        channels INTEGER NOT NULL,
        duration_sec REAL NOT NULL,
        dsd_bit_rate INTEGER NOT NULL DEFAULT 0,
        is_lossless INTEGER NOT NULL DEFAULT 0,
        is_hires INTEGER NOT NULL DEFAULT 0,
        replaygain_track_db REAL,
        replaygain_track_peak REAL,
        replaygain_album_db REAL,
        replaygain_album_peak REAL,
        integrated_lufs REAL,
        loudness_range_lu REAL,
        true_peak_dbtp REAL,
        added_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tracks_folder ON tracks(folder_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_artist_id ON tracks(artist_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_album_id ON tracks(album_id);
      CREATE INDEX IF NOT EXISTS idx_tracks_codec ON tracks(codec);
      CREATE INDEX IF NOT EXISTS idx_tracks_sample_rate ON tracks(sample_rate DESC);
      CREATE INDEX IF NOT EXISTS idx_tracks_hires ON tracks(is_hires);
      CREATE INDEX IF NOT EXISTS idx_tracks_lossless ON tracks(is_lossless);
      CREATE INDEX IF NOT EXISTS idx_tracks_synced_lyrics ON tracks(has_synced_lyrics);
      CREATE INDEX IF NOT EXISTS idx_tracks_title_nocase ON tracks(title COLLATE NOCASE);

      CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
        track_id UNINDEXED,
        title,
        artist,
        album,
        composer,
        genre,
        codec,
        lyrics,
        file_name,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TRIGGER IF NOT EXISTS trg_tracks_ai AFTER INSERT ON tracks BEGIN
        INSERT INTO tracks_fts(rowid, track_id, title, artist, album, composer, genre, codec, lyrics, file_name)
        VALUES (new.rowid, new.id, new.title, new.artist, new.album, COALESCE(new.composer, ''), COALESCE(new.genre, ''), new.codec, COALESCE(new.lyrics, ''), new.file_name);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_tracks_ad AFTER DELETE ON tracks BEGIN
        DELETE FROM tracks_fts WHERE rowid = old.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS trg_tracks_au AFTER UPDATE ON tracks BEGIN
        DELETE FROM tracks_fts WHERE rowid = old.rowid;
        INSERT INTO tracks_fts(rowid, track_id, title, artist, album, composer, genre, codec, lyrics, file_name)
        VALUES (new.rowid, new.id, new.title, new.artist, new.album, COALESCE(new.composer, ''), COALESCE(new.genre, ''), new.codec, COALESCE(new.lyrics, ''), new.file_name);
      END;

      CREATE TABLE IF NOT EXISTS playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS playlist_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        file_path TEXT NOT NULL,
        track_id TEXT REFERENCES tracks(id) ON DELETE SET NULL,
        position INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_playlist_items_order ON playlist_items(playlist_id, position);
      CREATE INDEX IF NOT EXISTS idx_playlist_items_path ON playlist_items(file_path);

      CREATE TABLE IF NOT EXISTS smart_playlists (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        match_mode TEXT NOT NULL DEFAULT 'all',
        rules_json TEXT NOT NULL DEFAULT '[]',
        sort_by TEXT NOT NULL DEFAULT 'title',
        sort_order TEXT NOT NULL DEFAULT 'asc',
        row_limit INTEGER NOT NULL DEFAULT 250,
        updated_at TEXT NOT NULL
      );
    `);
  }

  _prepareStatements() {
    this.stmts = {
      insertFolder: this.db.prepare(`
        INSERT INTO folders (path, added_at) VALUES (?, ?)
        ON CONFLICT(path) DO NOTHING
      `),
      selectFolderByPath: this.db.prepare(`SELECT id, path, added_at FROM folders WHERE path = ?`),
      selectAllFolders: this.db.prepare(`SELECT id, path, added_at FROM folders ORDER BY id ASC`),
      deleteFolder: this.db.prepare(`DELETE FROM folders WHERE path = ?`),

      upsertArtist: this.db.prepare(`
        INSERT INTO artists (name) VALUES (?)
        ON CONFLICT(name) DO UPDATE SET name = excluded.name
        RETURNING id
      `),
      upsertAlbum: this.db.prepare(`
        INSERT INTO albums (title, artist_id, year, cover_id)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(title, artist_id) DO UPDATE SET
          year = COALESCE(NULLIF(excluded.year, ''), albums.year),
          cover_id = COALESCE(albums.cover_id, excluded.cover_id)
        RETURNING id
      `),

      selectTrackStatByPath: this.db.prepare(`
        SELECT id, mtime_ms, size_bytes, added_at,
               replaygain_track_db, replaygain_track_peak,
               replaygain_album_db, replaygain_album_peak,
               integrated_lufs, loudness_range_lu, true_peak_dbtp
        FROM tracks WHERE file_path = ?
      `),
      selectTrackById: this.db.prepare(`SELECT ${TRACK_LIST_COLS} FROM tracks t WHERE t.id = ?`),
      selectTrackByPath: this.db.prepare(`SELECT ${TRACK_LIST_COLS} FROM tracks t WHERE t.file_path = ?`),

      upsertTrack: this.db.prepare(`
        INSERT INTO tracks (
          id, file_path, folder_id, file_name, size_bytes, mtime_ms, tag_format,
          title, artist, artist_id, album, album_id, year, composer, genre, track_number,
          lyrics, has_lyrics, has_synced_lyrics, has_cover, cover_id,
          codec, sample_rate, bit_depth, channels, duration_sec, dsd_bit_rate,
          is_lossless, is_hires,
          replaygain_track_db, replaygain_track_peak, replaygain_album_db, replaygain_album_peak,
          integrated_lufs, loudness_range_lu, true_peak_dbtp, added_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
        ON CONFLICT(file_path) DO UPDATE SET
          id = excluded.id,
          folder_id = COALESCE(excluded.folder_id, tracks.folder_id),
          file_name = excluded.file_name,
          size_bytes = excluded.size_bytes,
          mtime_ms = excluded.mtime_ms,
          tag_format = excluded.tag_format,
          title = excluded.title,
          artist = excluded.artist,
          artist_id = excluded.artist_id,
          album = excluded.album,
          album_id = excluded.album_id,
          year = excluded.year,
          composer = excluded.composer,
          genre = excluded.genre,
          track_number = excluded.track_number,
          lyrics = COALESCE(excluded.lyrics, tracks.lyrics),
          has_lyrics = excluded.has_lyrics,
          has_synced_lyrics = excluded.has_synced_lyrics,
          has_cover = excluded.has_cover,
          cover_id = excluded.cover_id,
          codec = excluded.codec,
          sample_rate = excluded.sample_rate,
          bit_depth = excluded.bit_depth,
          channels = excluded.channels,
          duration_sec = excluded.duration_sec,
          dsd_bit_rate = excluded.dsd_bit_rate,
          is_lossless = excluded.is_lossless,
          is_hires = excluded.is_hires,
          replaygain_track_db = excluded.replaygain_track_db,
          replaygain_track_peak = excluded.replaygain_track_peak,
          replaygain_album_db = excluded.replaygain_album_db,
          replaygain_album_peak = excluded.replaygain_album_peak,
          integrated_lufs = excluded.integrated_lufs,
          loudness_range_lu = excluded.loudness_range_lu,
          true_peak_dbtp = excluded.true_peak_dbtp
      `),

      relinkPlaylistItemsByPath: this.db.prepare(`
        UPDATE playlist_items SET track_id = ? WHERE file_path = ?
      `),

      updateTrackLoudness: this.db.prepare(`
        UPDATE tracks SET
          integrated_lufs = ?,
          loudness_range_lu = ?,
          true_peak_dbtp = ?,
          replaygain_track_db = ?,
          replaygain_track_peak = ?,
          mtime_ms = ?,
          size_bytes = ?
        WHERE id = ?
      `),

      deleteTrackByPath: this.db.prepare(`DELETE FROM tracks WHERE file_path = ?`),
      deleteTracksUnderPrefix: this.db.prepare(
        `DELETE FROM tracks WHERE file_path = ? OR (file_path >= ? AND file_path < ?)`,
      ),
      selectPathsUnderPrefix: this.db.prepare(
        `SELECT id, file_path FROM tracks WHERE file_path >= ? AND file_path < ?`,
      ),

      pruneOrphanAlbums: this.db.prepare(`
        DELETE FROM albums WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.album_id = albums.id)
      `),
      pruneOrphanArtists: this.db.prepare(`
        DELETE FROM artists WHERE NOT EXISTS (SELECT 1 FROM tracks WHERE tracks.artist_id = artists.id)
      `),

      countTracks: this.db.prepare(`SELECT COUNT(*) AS cnt FROM tracks`),
      summaryTotals: this.db.prepare(`
        SELECT
          COUNT(*) AS total_tracks,
          COALESCE(SUM(CASE WHEN is_hires = 1 THEN 1 ELSE 0 END), 0) AS hires_count,
          COALESCE(SUM(duration_sec), 0.0) AS total_duration_sec
        FROM tracks
      `),
      summaryCodecs: this.db.prepare(`
        SELECT codec, COUNT(*) AS cnt FROM tracks GROUP BY codec
      `),
      summaryAlbums: this.db.prepare(`
        SELECT
          al.title AS album,
          ar.name AS artist,
          COALESCE(al.year, '') AS year,
          COALESCE(al.cover_id, MAX(t.cover_id)) AS cover_id,
          COUNT(t.id) AS track_count
        FROM albums al
        LEFT JOIN artists ar ON ar.id = al.artist_id
        INNER JOIN tracks t ON t.album_id = al.id
        GROUP BY al.id
        ORDER BY al.title COLLATE NOCASE ASC
      `),
      summaryArtists: this.db.prepare(`
        SELECT
          ar.name AS name,
          COUNT(t.id) AS track_count
        FROM artists ar
        INNER JOIN tracks t ON t.artist_id = ar.id
        GROUP BY ar.id
        ORDER BY ar.name COLLATE NOCASE ASC
      `),

      // Playlists & Smart Playlists
      selectAllPlaylists: this.db.prepare(`SELECT id, name, updated_at FROM playlists ORDER BY rowid ASC`),
      selectPlaylistById: this.db.prepare(`SELECT id, name, updated_at FROM playlists WHERE id = ?`),
      upsertPlaylist: this.db.prepare(`
        INSERT INTO playlists (id, name, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
      `),
      deletePlaylist: this.db.prepare(`DELETE FROM playlists WHERE id = ?`),
      deletePlaylistItems: this.db.prepare(`DELETE FROM playlist_items WHERE playlist_id = ?`),
      insertPlaylistItem: this.db.prepare(`
        INSERT INTO playlist_items (playlist_id, file_path, track_id, position)
        VALUES (?, ?, (SELECT id FROM tracks WHERE file_path = ?), ?)
      `),
      selectPlaylistItemsJoined: this.db.prepare(`
        SELECT
          pi.file_path AS item_file_path,
          pi.position AS item_position,
          ${TRACK_LIST_COLS}
        FROM playlist_items pi
        LEFT JOIN tracks t ON t.id = pi.track_id OR (pi.track_id IS NULL AND t.file_path = pi.file_path)
        WHERE pi.playlist_id = ?
        ORDER BY pi.position ASC
      `),

      countSmartPlaylists: this.db.prepare(`SELECT COUNT(*) AS cnt FROM smart_playlists`),
      selectAllSmartPlaylists: this.db.prepare(`
        SELECT id, name, match_mode, rules_json, sort_by, sort_order, row_limit, updated_at
        FROM smart_playlists ORDER BY rowid ASC
      `),
      selectSmartPlaylistById: this.db.prepare(`
        SELECT id, name, match_mode, rules_json, sort_by, sort_order, row_limit, updated_at
        FROM smart_playlists WHERE id = ?
      `),
      upsertSmartPlaylist: this.db.prepare(`
        INSERT INTO smart_playlists (id, name, match_mode, rules_json, sort_by, sort_order, row_limit, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          match_mode = excluded.match_mode,
          rules_json = excluded.rules_json,
          sort_by = excluded.sort_by,
          sort_order = excluded.sort_order,
          row_limit = excluded.row_limit,
          updated_at = excluded.updated_at
      `),
      deleteSmartPlaylist: this.db.prepare(`DELETE FROM smart_playlists WHERE id = ?`),
    };
  }

  runInTransaction(fn) {
    if (this._inTxDepth > 0) {
      this._inTxDepth++;
      try {
        return fn();
      } finally {
        this._inTxDepth--;
      }
    }
    this.db.exec('BEGIN IMMEDIATE');
    this._inTxDepth = 1;
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore rollback error
      }
      throw err;
    } finally {
      this._inTxDepth = 0;
    }
  }

  _migrateLegacyJsonIfNeeded() {
    const legacyLibPath = path.join(this.dataDir, 'library.json');
    const legacyPlPath = path.join(this.dataDir, 'playlists.json');

    const trackCount = Number(this.stmts.countTracks.get()?.cnt || 0);
    if (trackCount === 0 && fs.existsSync(legacyLibPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyLibPath, 'utf8'));
        this.runInTransaction(() => {
          if (Array.isArray(parsed.folders)) {
            for (const dir of parsed.folders) {
              if (typeof dir === 'string' && dir) this.addFolder(dir);
            }
          }
          if (Array.isArray(parsed.tracks)) {
            for (const t of parsed.tracks) {
              if (t && t.id && t.filePath) this.upsertTrack(t);
            }
          }
        });
        fs.renameSync(legacyLibPath, `${legacyLibPath}.migrated`);
      } catch {
        // Keep legacy file untouched on malformed JSON
      }
    }

    const smartCount = Number(this.stmts.countSmartPlaylists.get()?.cnt || 0);
    if (smartCount === 0 && fs.existsSync(legacyPlPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacyPlPath, 'utf8'));
        this.runInTransaction(() => {
          if (Array.isArray(parsed.playlists)) {
            for (const pl of parsed.playlists) {
              if (pl && pl.id && pl.name) {
                this.savePlaylistRecord({
                  id: pl.id,
                  name: pl.name,
                  trackPaths: Array.isArray(pl.trackPaths) ? pl.trackPaths : [],
                  updatedAt: pl.updatedAt || new Date().toISOString(),
                });
              }
            }
          }
          if (Array.isArray(parsed.smartPlaylists)) {
            for (const sp of parsed.smartPlaylists) {
              if (sp && sp.id && sp.name) {
                this.saveSmartPlaylistRecord(sp);
              }
            }
          }
        });
        fs.renameSync(legacyPlPath, `${legacyPlPath}.migrated`);
      } catch {
        // Keep legacy file untouched on malformed JSON
      }
    }
  }

  /* ---------------- Folders ---------------- */

  addFolder(dirPath) {
    const abs = path.resolve(dirPath);
    this.stmts.insertFolder.run(abs, new Date().toISOString());
    return this.stmts.selectFolderByPath.get(abs);
  }

  listFolders() {
    return this.stmts.selectAllFolders.all().map((r) => r.path);
  }

  findMatchingFolderId(filePath) {
    const abs = path.resolve(filePath);
    const folders = this.stmts.selectAllFolders.all();
    let best = null;
    for (const f of folders) {
      if (abs === f.path || abs.startsWith(f.path + path.sep)) {
        if (!best || f.path.length > best.path.length) best = f;
      }
    }
    return best ? best.id : null;
  }

  removeFolderAndTracks(dirPath) {
    const abs = path.resolve(dirPath);
    const prefixLo = abs + path.sep;
    const prefixHi = abs + String.fromCharCode(path.sep.charCodeAt(0) + 1);
    this.runInTransaction(() => {
      this.stmts.deleteTracksUnderPrefix.run(abs, prefixLo, prefixHi);
      this.stmts.deleteFolder.run(abs);
      this.pruneOrphanEntities();
    });
  }

  /* ---------------- Tracks CRUD & Indexed / FTS5 Queries ---------------- */

  getTrackStatByPath(filePath) {
    const row = this.stmts.selectTrackStatByPath.get(path.resolve(filePath));
    if (!row) return null;
    return {
      id: row.id,
      mtimeMs: row.mtime_ms,
      sizeBytes: row.size_bytes,
      addedAt: row.added_at,
      replayGainTrackDb: row.replaygain_track_db ?? null,
      replayGainTrackPeak: row.replaygain_track_peak ?? null,
      replayGainAlbumDb: row.replaygain_album_db ?? null,
      replayGainAlbumPeak: row.replaygain_album_peak ?? null,
      integratedLufs: row.integrated_lufs ?? null,
      loudnessRangeLu: row.loudness_range_lu ?? null,
      truePeakDbtp: row.true_peak_dbtp ?? null,
    };
  }

  upsertTrack(record, { lyricsText = null, folderId = null } = {}) {
    return this.runInTransaction(() => {
      const artistName = String(record.artist || 'Artista Desconocido');
      const albumTitle = String(record.album || 'Álbum Desconocido');
      const yearStr = record.year !== undefined && record.year !== null ? String(record.year) : '';

      const artistRow = this.stmts.upsertArtist.get(artistName);
      const albumRow = this.stmts.upsertAlbum.get(
        albumTitle,
        artistRow.id,
        yearStr,
        record.coverId || null,
      );
      const resolvedFolderId = folderId ?? this.findMatchingFolderId(record.filePath);

      this.stmts.upsertTrack.run(
        record.id,
        record.filePath,
        resolvedFolderId,
        record.fileName || path.basename(record.filePath),
        Number(record.sizeBytes) || 0,
        Number(record.mtimeMs) || 0,
        record.tagFormat || '',
        String(record.title || path.basename(record.filePath)),
        artistName,
        artistRow.id,
        albumTitle,
        albumRow.id,
        yearStr,
        record.composer || '',
        record.genre || '',
        record.trackNumber || '',
        lyricsText,
        record.hasLyrics ? 1 : 0,
        record.hasSyncedLyrics ? 1 : 0,
        record.hasCover ? 1 : 0,
        record.coverId || null,
        record.codec || 'WAV',
        Number(record.sampleRate) || 44100,
        Number(record.bitDepth) || 16,
        Number(record.channels) || 2,
        Number(record.durationSec) || 0,
        Number(record.dsdBitRate) || 0,
        record.isLossless ? 1 : 0,
        record.isHiRes ? 1 : 0,
        record.replayGainTrackDb ?? null,
        record.replayGainTrackPeak ?? null,
        record.replayGainAlbumDb ?? null,
        record.replayGainAlbumPeak ?? null,
        record.integratedLufs ?? null,
        record.loudnessRangeLu ?? null,
        record.truePeakDbtp ?? null,
        record.addedAt || new Date().toISOString(),
      );

      this.stmts.relinkPlaylistItemsByPath.run(record.id, record.filePath);
      return this.getTrackById(record.id);
    });
  }

  updateTrackLoudness(trackId, { integratedLufs, loudnessRangeLu, truePeakDbtp, replayGainTrackDb, replayGainTrackPeak, mtimeMs, sizeBytes }) {
    this.stmts.updateTrackLoudness.run(
      integratedLufs ?? null,
      loudnessRangeLu ?? null,
      truePeakDbtp ?? null,
      replayGainTrackDb ?? null,
      replayGainTrackPeak ?? null,
      mtimeMs,
      sizeBytes,
      trackId,
    );
    return this.getTrackById(trackId);
  }

  deleteTrackByPath(filePath) {
    const abs = path.resolve(filePath);
    const info = this.stmts.deleteTrackByPath.run(abs);
    if (info.changes > 0) this.pruneOrphanEntities();
    return info.changes > 0;
  }

  deleteTracksUnderDir(dirPath) {
    const abs = path.resolve(dirPath);
    const prefixLo = abs + path.sep;
    const prefixHi = abs + String.fromCharCode(path.sep.charCodeAt(0) + 1);
    let changes = 0;
    this.runInTransaction(() => {
      const info = this.stmts.deleteTracksUnderPrefix.run(abs, prefixLo, prefixHi);
      changes = info.changes;
      if (changes > 0) this.pruneOrphanEntities();
    });
    return changes;
  }

  listTracksUnderDir(dirPath) {
    const abs = path.resolve(dirPath);
    const prefixLo = abs + path.sep;
    const prefixHi = abs + String.fromCharCode(path.sep.charCodeAt(0) + 1);
    return this.stmts.selectPathsUnderPrefix.all(prefixLo, prefixHi);
  }

  pruneOrphanEntities() {
    this.stmts.pruneOrphanAlbums.run();
    this.stmts.pruneOrphanArtists.run();
  }

  getTrackById(id) {
    return rowToTrack(this.stmts.selectTrackById.get(String(id)));
  }

  getTrackByPath(filePath) {
    return rowToTrack(this.stmts.selectTrackByPath.get(path.resolve(filePath)));
  }

  countTracks() {
    return Number(this.stmts.countTracks.get()?.cnt || 0);
  }

  queryTracksPaginated({
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
    limit = 0,
    offset = 0,
  } = {}) {
    const where = [];
    const params = [];

    const trimmedSearch = String(search || '').trim();
    if (trimmedSearch) {
      const ftsQuery = buildFtsMatchQuery(trimmedSearch);
      if (ftsQuery) {
        where.push(`t.rowid IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)`);
        params.push(ftsQuery);
      } else {
        const likePat = `%${escapeLike(trimmedSearch)}%`;
        where.push(
          `(LOWER(t.title) LIKE LOWER(?) ESCAPE '\\' OR LOWER(t.artist) LIKE LOWER(?) ESCAPE '\\' OR LOWER(t.album) LIKE LOWER(?) ESCAPE '\\' OR LOWER(t.file_name) LIKE LOWER(?) ESCAPE '\\')`,
        );
        params.push(likePat, likePat, likePat, likePat);
      }
    }

    if (codec && String(codec).trim()) {
      where.push(`UPPER(t.codec) = UPPER(?)`);
      params.push(String(codec).trim());
    }
    if (hiResOnly) where.push(`t.is_hires = 1`);
    if (losslessOnly) where.push(`t.is_lossless = 1`);
    if (syncedLyricsOnly) where.push(`t.has_synced_lyrics = 1`);

    if (artist && String(artist).trim()) {
      where.push(`t.artist = ? COLLATE NOCASE`);
      params.push(String(artist).trim());
    }
    if (album && String(album).trim()) {
      where.push(`t.album = ? COLLATE NOCASE`);
      params.push(String(album).trim());
    }
    if (composer && String(composer).trim()) {
      where.push(`LOWER(COALESCE(t.composer, '')) LIKE LOWER(?) ESCAPE '\\'`);
      params.push(`%${escapeLike(String(composer).trim())}%`);
    }

    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const orderBy = buildOrderBySql(sortBy, sortOrder);

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM tracks t ${whereClause}`)
      .get(...params);
    const total = Number(totalRow?.cnt || 0);

    let pageSql = `SELECT ${TRACK_LIST_COLS} FROM tracks t ${whereClause} ORDER BY ${orderBy}`;
    const pageParams = [...params];
    const safeLimit = Number(limit) > 0 ? Math.min(100000, Math.floor(Number(limit))) : 0;
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));

    if (safeLimit > 0) {
      pageSql += ` LIMIT ? OFFSET ?`;
      pageParams.push(safeLimit, safeOffset);
    } else if (safeOffset > 0) {
      pageSql += ` LIMIT -1 OFFSET ?`;
      pageParams.push(safeOffset);
    }

    const rows = this.db.prepare(pageSql).all(...pageParams);
    return {
      tracks: rows.map(rowToTrack),
      total,
      limit: safeLimit,
      offset: safeOffset,
    };
  }

  getSummary() {
    const totals = this.stmts.summaryTotals.get() || {
      total_tracks: 0,
      hires_count: 0,
      total_duration_sec: 0,
    };
    const codecs = {};
    for (const c of this.stmts.summaryCodecs.all()) {
      codecs[c.codec] = Number(c.cnt);
    }
    const albums = this.stmts.summaryAlbums.all().map((a) => ({
      album: a.album,
      artist: a.artist || 'Artista Desconocido',
      year: /^\d+$/.test(String(a.year)) ? parseInt(a.year, 10) : a.year,
      coverId: a.cover_id || null,
      trackCount: Number(a.track_count),
    }));
    const artists = this.stmts.summaryArtists.all().map((ar) => ({
      name: ar.name,
      trackCount: Number(ar.track_count),
    }));

    return {
      totalTracks: Number(totals.total_tracks),
      totalAlbums: albums.length,
      totalArtists: artists.length,
      hiResCount: Number(totals.hires_count),
      totalDurationSec: Number(totals.total_duration_sec),
      codecs,
      folders: this.listFolders(),
      albums,
      artists,
    };
  }

  /* ---------------- Compiled SQL Smart Playlists ---------------- */

  evaluateSmartPlaylistSql(smartDef, fallbackEvaluator = null) {
    const rules = Array.isArray(smartDef.rules) ? smartDef.rules : [];
    const matchMode = smartDef.match === 'any' ? 'any' : 'all';

    const compiledParts = [];
    const params = [];
    let canCompileAll = true;

    for (const r of rules) {
      const comp = compileSingleSmartRule(r);
      if (!comp) {
        canCompileAll = false;
        break;
      }
      compiledParts.push(comp.sql);
      params.push(...comp.params);
    }

    if (!canCompileAll && typeof fallbackEvaluator === 'function') {
      const allTracks = this.queryTracksPaginated().tracks;
      return fallbackEvaluator(smartDef, allTracks);
    }

    let whereSql = '';
    if (compiledParts.length > 0) {
      const joiner = matchMode === 'any' ? ' OR ' : ' AND ';
      whereSql = `WHERE (${compiledParts.join(joiner)})`;
    }

    const orderBy = buildOrderBySql(smartDef.sortBy || 'title', smartDef.sortOrder || 'asc');
    let sql = `SELECT ${TRACK_LIST_COLS} FROM tracks t ${whereSql} ORDER BY ${orderBy}`;
    if (smartDef.limit && Number(smartDef.limit) > 0) {
      sql += ` LIMIT ?`;
      params.push(Math.floor(Number(smartDef.limit)));
    }

    return this.db.prepare(sql).all(...params).map(rowToTrack);
  }

  /* ---------------- Playlists & Smart Playlists Persistence ---------------- */

  listPlaylistRecords() {
    return this.stmts.selectAllPlaylists.all();
  }

  getPlaylistWithTracks(playlistId, fallbackResolver) {
    const pl = this.stmts.selectPlaylistById.get(String(playlistId));
    if (!pl) return null;
    const rows = this.stmts.selectPlaylistItemsJoined.all(pl.id);
    const tracks = rows
      .map((r) => {
        if (r.id) return rowToTrack(r);
        return typeof fallbackResolver === 'function' ? fallbackResolver(r.item_file_path) : null;
      })
      .filter(Boolean);

    return {
      id: pl.id,
      name: pl.name,
      trackCount: tracks.length,
      tracks,
      updatedAt: pl.updated_at,
    };
  }

  savePlaylistRecord({ id, name, trackPaths = [], updatedAt = new Date().toISOString() }) {
    this.runInTransaction(() => {
      this.stmts.upsertPlaylist.run(id, name, updatedAt);
      this.stmts.deletePlaylistItems.run(id);
      for (let i = 0; i < trackPaths.length; i++) {
        const fp = path.resolve(trackPaths[i]);
        this.stmts.insertPlaylistItem.run(id, fp, fp, i);
      }
    });
  }

  deletePlaylistRecord(id) {
    const info = this.stmts.deletePlaylist.run(String(id));
    return info.changes > 0;
  }

  listSmartPlaylistDefs() {
    return this.stmts.selectAllSmartPlaylists.all().map((r) => ({
      id: r.id,
      name: r.name,
      match: r.match_mode,
      rules: JSON.parse(r.rules_json || '[]'),
      sortBy: r.sort_by,
      sortOrder: r.sort_order,
      limit: r.row_limit,
      updatedAt: r.updated_at,
    }));
  }

  getSmartPlaylistDef(id) {
    const r = this.stmts.selectSmartPlaylistById.get(String(id));
    if (!r) return null;
    return {
      id: r.id,
      name: r.name,
      match: r.match_mode,
      rules: JSON.parse(r.rules_json || '[]'),
      sortBy: r.sort_by,
      sortOrder: r.sort_order,
      limit: r.row_limit,
      updatedAt: r.updated_at,
    };
  }

  saveSmartPlaylistRecord(def) {
    const updatedAt = def.updatedAt || new Date().toISOString();
    this.stmts.upsertSmartPlaylist.run(
      def.id,
      def.name,
      def.match === 'any' ? 'any' : 'all',
      JSON.stringify(Array.isArray(def.rules) ? def.rules : []),
      def.sortBy || 'title',
      def.sortOrder === 'desc' ? 'desc' : 'asc',
      Number(def.limit) > 0 ? Math.floor(Number(def.limit)) : 250,
      updatedAt,
    );
  }

  deleteSmartPlaylistRecord(id) {
    const info = this.stmts.deleteSmartPlaylist.run(String(id));
    return info.changes > 0;
  }

  getStats() {
    let sizeBytes = 0;
    try {
      sizeBytes = fs.statSync(this.dbPath).size;
    } catch {
      sizeBytes = 0;
    }
    const journalMode = this.db.prepare('PRAGMA journal_mode').get()?.journal_mode || 'wal';
    const ftsRows = Number(this.db.prepare('SELECT COUNT(*) AS cnt FROM tracks_fts').get()?.cnt || 0);
    return {
      engine: 'SQLite (node:sqlite C++ + FTS5 + WAL)',
      dbPath: this.dbPath,
      sizeBytes,
      journalMode,
      totalTracks: this.countTracks(),
      ftsIndexedTracks: ftsRows,
      watchedFolders: this.listFolders().length,
    };
  }

  close() {
    if (!this.db) return;
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // ignore if read-only or busy
    }
    try {
      this.db.close();
    } catch {
      // ignore if already closed
    }
    this.db = null;
  }
}
