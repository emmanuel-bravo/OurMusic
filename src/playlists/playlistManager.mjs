import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function xmlEscape(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(str) {
  return String(str ?? '')
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function resolvePlaylistEntryPath(rawLoc, baseDir) {
  const trimmed = String(rawLoc || '').trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('file://')) {
    try {
      return fileURLToPath(trimmed);
    } catch {
      return decodeURIComponent(trimmed.replace(/^file:\/\/\/?/, '/'));
    }
  }
  if (path.isAbsolute(trimmed)) return path.normalize(trimmed);
  return path.resolve(baseDir || process.cwd(), trimmed);
}

/* ---------------- Standard Formats: M3U/M3U8, PLS, XSPF ---------------- */

export function serializeM3u(name, tracks) {
  const lines = ['#EXTM3U'];
  if (name) lines.push(`#PLAYLIST:${name}`);
  for (const t of tracks) {
    const dur = Math.round(Number(t.durationSec) || -1);
    const label = t.artist && t.artist !== 'Artista Desconocido' ? `${t.artist} - ${t.title}` : t.title;
    lines.push(`#EXTINF:${dur},${label}`);
    lines.push(t.filePath);
  }
  return lines.join('\n') + '\n';
}

export function parseM3u(content, baseDir = process.cwd()) {
  const lines = String(content || '').split(/\r?\n/);
  let name = '';
  const entries = [];
  let pendingMeta = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#PLAYLIST:')) {
      name = line.slice(10).trim();
    } else if (line.startsWith('#EXTINF:')) {
      const rest = line.slice(8);
      const comma = rest.indexOf(',');
      const dur = comma >= 0 ? parseFloat(rest.slice(0, comma)) : -1;
      const title = comma >= 0 ? rest.slice(comma + 1).trim() : '';
      pendingMeta = { durationSec: dur, title };
    } else if (!line.startsWith('#')) {
      const filePath = resolvePlaylistEntryPath(line, baseDir);
      entries.push({
        filePath,
        title: pendingMeta?.title || path.basename(filePath),
        durationSec: pendingMeta?.durationSec ?? -1,
      });
      pendingMeta = null;
    }
  }
  return { name: name || 'Lista M3U Importada', entries };
}

export function serializePls(name, tracks) {
  const lines = ['[playlist]'];
  if (name) lines.push(`X-PlaylistName=${name}`);
  tracks.forEach((t, idx) => {
    const n = idx + 1;
    const label = t.artist && t.artist !== 'Artista Desconocido' ? `${t.artist} - ${t.title}` : t.title;
    lines.push(`File${n}=${t.filePath}`);
    lines.push(`Title${n}=${label}`);
    lines.push(`Length${n}=${Math.round(Number(t.durationSec) || -1)}`);
  });
  lines.push(`NumberOfEntries=${tracks.length}`);
  lines.push('Version=2');
  return lines.join('\n') + '\n';
}

export function parsePls(content, baseDir = process.cwd()) {
  const lines = String(content || '').split(/\r?\n/);
  const byIdx = new Map();
  let name = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('[') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();

    if (key.toLowerCase() === 'x-playlistname') {
      name = val;
      continue;
    }

    const m = /^(file|title|length)(\d+)$/i.exec(key);
    if (!m) continue;
    const kind = m[1].toLowerCase();
    const idx = parseInt(m[2], 10);
    if (!byIdx.has(idx)) byIdx.set(idx, {});
    const item = byIdx.get(idx);
    if (kind === 'file') item.filePath = resolvePlaylistEntryPath(val, baseDir);
    else if (kind === 'title') item.title = val;
    else if (kind === 'length') item.durationSec = parseFloat(val);
  }

  const entries = Array.from(byIdx.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v)
    .filter((v) => Boolean(v.filePath));

  return { name: name || 'Lista PLS Importada', entries };
}

export function serializeXspf(name, tracks) {
  const trackNodes = tracks
    .map((t) => {
      const locUrl = pathToFileURL(t.filePath).href;
      const durMs = Math.max(0, Math.round((Number(t.durationSec) || 0) * 1000));
      return [
        '    <track>',
        `      <location>${xmlEscape(locUrl)}</location>`,
        `      <title>${xmlEscape(t.title || '')}</title>`,
        `      <creator>${xmlEscape(t.artist || '')}</creator>`,
        `      <album>${xmlEscape(t.album || '')}</album>`,
        `      <duration>${durMs}</duration>`,
        '    </track>',
      ].join('\n');
    })
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<playlist version="1" xmlns="http://xspf.org/ns/0/">',
    `  <title>${xmlEscape(name || 'OurMusic Playlist')}</title>`,
    '  <trackList>',
    trackNodes,
    '  </trackList>',
    '</playlist>',
    '',
  ].join('\n');
}

export function parseXspf(content, baseDir = process.cwd()) {
  const xml = String(content || '');
  const playlistTitleMatch = /<playlist[^>]*>[\s\S]*?<title>([\s\S]*?)<\/title>/i.exec(xml);
  // Avoid matching first track's <title> if <playlist> has no top-level <title> before <trackList>
  const beforeTrackList = xml.split(/<trackList>/i)[0] || '';
  const topTitleMatch = /<title>([\s\S]*?)<\/title>/i.exec(beforeTrackList);
  const name = topTitleMatch ? xmlUnescape(topTitleMatch[1].trim()) : (playlistTitleMatch ? '' : '');

  const entries = [];
  const trackRe = /<track>([\s\S]*?)<\/track>/gi;
  let m;
  while ((m = trackRe.exec(xml)) !== null) {
    const blk = m[1];
    const loc = /<location>([\s\S]*?)<\/location>/i.exec(blk);
    if (!loc) continue;
    const ttl = /<title>([\s\S]*?)<\/title>/i.exec(blk);
    const dur = /<duration>([\s\S]*?)<\/duration>/i.exec(blk);
    const filePath = resolvePlaylistEntryPath(xmlUnescape(loc[1].trim()), baseDir);
    entries.push({
      filePath,
      title: ttl ? xmlUnescape(ttl[1].trim()) : path.basename(filePath),
      durationSec: dur ? parseInt(dur[1].trim(), 10) / 1000 : -1,
    });
  }
  return { name: name || 'Lista XSPF Importada', entries };
}

/* ---------------- Smart Playlists Rule Engine ---------------- */

export function evaluateSmartRule(track, rule) {
  if (!rule || !rule.field) return true;
  const rawVal = track[rule.field];
  const op = String(rule.operator || 'contains').toLowerCase();

  if (op === 'is_true') return Boolean(rawVal) === true;
  if (op === 'is_false') return Boolean(rawVal) === false;

  if (['gt', 'gte', 'lt', 'lte', 'between', 'num_eq'].includes(op)) {
    const num = Number(rawVal);
    const target = Number(rule.value);
    if (!Number.isFinite(num) || !Number.isFinite(target)) return false;
    if (op === 'gt') return num > target;
    if (op === 'gte') return num >= target;
    if (op === 'lt') return num < target;
    if (op === 'lte') return num <= target;
    if (op === 'num_eq') return num === target;
    if (op === 'between') {
      const hi = Number(rule.valueTo);
      return Number.isFinite(hi) && num >= Math.min(target, hi) && num <= Math.max(target, hi);
    }
  }

  const sVal = String(rawVal ?? '').toLowerCase();
  const sTarget = String(rule.value ?? '').toLowerCase();

  if (op === 'equals' || op === 'is') return sVal === sTarget;
  if (op === 'not_equals' || op === 'is_not') return sVal !== sTarget;
  if (op === 'starts_with') return sVal.startsWith(sTarget);
  if (op === 'ends_with') return sVal.endsWith(sTarget);
  if (op === 'not_contains') return !sVal.includes(sTarget);
  return sVal.includes(sTarget); // default 'contains'
}

export function evaluateSmartPlaylist(smartDef, allTracks) {
  const rules = Array.isArray(smartDef.rules) ? smartDef.rules : [];
  const matchMode = smartDef.match === 'any' ? 'any' : 'all';

  let matched = allTracks.filter((trk) => {
    if (rules.length === 0) return true;
    return matchMode === 'any'
      ? rules.some((r) => evaluateSmartRule(trk, r))
      : rules.every((r) => evaluateSmartRule(trk, r));
  });

  const sortBy = smartDef.sortBy || 'title';
  const dir = smartDef.sortOrder === 'desc' ? -1 : 1;
  matched.sort((a, b) => {
    const va = a[sortBy] ?? '';
    const vb = b[sortBy] ?? '';
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
    return String(va).localeCompare(String(vb), 'es', { numeric: true, sensitivity: 'base' }) * dir;
  });

  if (smartDef.limit && Number(smartDef.limit) > 0) {
    matched = matched.slice(0, Number(smartDef.limit));
  }
  return matched;
}

const DEFAULT_SMART_PLAYLISTS = [
  {
    id: 'smart_hires',
    name: 'Hi-Res y DSD Audiófilo',
    match: 'any',
    rules: [
      { field: 'sampleRate', operator: 'gt', value: 48000 },
      { field: 'bitDepth', operator: 'gt', value: 16 },
      { field: 'codec', operator: 'equals', value: 'DSD' },
    ],
    sortBy: 'sampleRate',
    sortOrder: 'desc',
    limit: 200,
  },
  {
    id: 'smart_synced_lyrics',
    name: 'Con Letras Sincronizadas',
    match: 'all',
    rules: [{ field: 'hasSyncedLyrics', operator: 'is_true', value: true }],
    sortBy: 'title',
    sortOrder: 'asc',
    limit: 200,
  },
  {
    id: 'smart_lossless',
    name: 'Colección Sin Pérdida (Lossless)',
    match: 'all',
    rules: [{ field: 'isLossless', operator: 'is_true', value: true }],
    sortBy: 'album',
    sortOrder: 'asc',
    limit: 500,
  },
];

/**
 * Playlist & Active Playback Queue Manager with Gapless Next-Track Handoff,
 * M3U/PLS/XSPF Import/Export, and Rule-Based Smart Playlists.
 */
export class PlaylistManager extends EventEmitter {
  constructor({ dataDir, libraryManager, engineBridge, presetManager = null, database = null }) {
    super();
    this.dataDir = dataDir;
    this.library = libraryManager;
    this.engine = engineBridge;
    this.presets = presetManager;
    this.db = database || libraryManager?.db || null;

    // Active playback queue
    this.queue = []; // Array of track objects or minimal path descriptors
    this.currentIndex = -1;
    this.repeatMode = 'off'; // 'off' | 'all' | 'one'
    this.shuffle = false;

    this._seedDefaultSmartPlaylists();
    this._bindEngineEvents();
  }

  _seedDefaultSmartPlaylists() {
    if (!this.db) return;
    if (this.db.listSmartPlaylistDefs().length === 0) {
      this.db.runInTransaction(() => {
        for (const sp of DEFAULT_SMART_PLAYLISTS) {
          this.db.saveSmartPlaylistRecord(sp);
        }
      });
    }
  }

  _bindEngineEvents() {
    if (!this.engine) return;

    this.engine.on('track_started', (ev) => {
      if (ev.gapless) {
        const nextIdx = this._peekNextIndex();
        if (nextIdx >= 0 && this.queue[nextIdx]?.filePath === ev.path) {
          this.currentIndex = nextIdx;
        } else {
          const found = this.queue.findIndex((item) => item.filePath === ev.path);
          if (found >= 0) this.currentIndex = found;
        }
        const cur = this.queue[this.currentIndex];
        if (cur) this._pushTrackReplayGain(cur).catch(() => {});
        this._armGaplessNext().catch(() => {});
        this.emit('queue_updated', this.getQueueState());
      }
    });

    this.engine.on('playback_ended', async () => {
      const nextIdx = this._peekNextIndex();
      if (nextIdx >= 0) {
        await this.playIndex(nextIdx).catch(() => {});
      } else {
        this.emit('queue_updated', this.getQueueState());
      }
    });
  }

  _resolveTrackItem(idOrPath) {
    if (!idOrPath) return null;
    if (typeof idOrPath === 'object' && idOrPath.filePath) {
      return this.library.getTrackByPath(idOrPath.filePath) || idOrPath;
    }
    const byId = this.library.getTrack(String(idOrPath));
    if (byId) return byId;
    const byPath = this.library.getTrackByPath(String(idOrPath));
    if (byPath) return byPath;
    if (fs.existsSync(String(idOrPath))) {
      const abs = path.resolve(String(idOrPath));
      return {
        id: `ext_${Buffer.from(abs).toString('base64url').slice(0, 12)}`,
        filePath: abs,
        title: path.basename(abs, path.extname(abs)),
        artist: 'Archivo Local',
        album: '',
        durationSec: 0,
      };
    }
    return null;
  }

  _peekNextIndex() {
    if (this.queue.length === 0 || this.currentIndex < 0) return -1;
    if (this.repeatMode === 'one') return this.currentIndex;
    if (this.shuffle && this.queue.length > 1) {
      return (this.currentIndex + 1) % this.queue.length;
    }
    if (this.currentIndex + 1 < this.queue.length) {
      return this.currentIndex + 1;
    }
    if (this.repeatMode === 'all') {
      return 0;
    }
    return -1;
  }

  async _armGaplessNext() {
    if (!this.engine || !this.engine.ready) return;
    const nextIdx = this._peekNextIndex();
    const nextItem = nextIdx >= 0 ? this.queue[nextIdx] : null;
    await this.engine.queueNext(nextItem ? nextItem.filePath : '');
  }

  getQueueState() {
    return {
      queue: this.queue,
      currentIndex: this.currentIndex,
      currentTrack: this.currentIndex >= 0 ? this.queue[this.currentIndex] || null : null,
      repeatMode: this.repeatMode,
      shuffle: this.shuffle,
    };
  }

  async setQueueAndPlay(items, startIndex = 0) {
    let resolved = items.map((x) => this._resolveTrackItem(x)).filter(Boolean);
    if (resolved.length === 0) throw new Error('No hay pistas válidas para reproducir');

    let idx = Math.max(0, Math.min(resolved.length - 1, Number(startIndex) || 0));
    if (this.shuffle && resolved.length > 1) {
      const first = resolved[idx];
      const rest = resolved.filter((_, i) => i !== idx);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      resolved = [first, ...rest];
      idx = 0;
    }

    this.queue = resolved;
    return this.playIndex(idx);
  }

  async _pushTrackReplayGain(track) {
    if (!this.engine || !this.engine.ready || !track) return;
    await this.engine.setReplayGain({
      trackGainDb: Number.isFinite(track.replayGainTrackDb) ? track.replayGainTrackDb : 0.0,
      trackPeak: Number.isFinite(track.replayGainTrackPeak) && track.replayGainTrackPeak > 0 ? track.replayGainTrackPeak : 1.0,
      albumGainDb: Number.isFinite(track.replayGainAlbumDb)
        ? track.replayGainAlbumDb
        : (Number.isFinite(track.replayGainTrackDb) ? track.replayGainTrackDb : 0.0),
      albumPeak:
        Number.isFinite(track.replayGainAlbumPeak) && track.replayGainAlbumPeak > 0
          ? track.replayGainAlbumPeak
          : (Number.isFinite(track.replayGainTrackPeak) && track.replayGainTrackPeak > 0 ? track.replayGainTrackPeak : 1.0),
    });
  }

  async playIndex(index) {
    if (index < 0 || index >= this.queue.length) {
      throw new Error('Índice de cola fuera de rango');
    }
    this.currentIndex = index;
    const current = this.queue[this.currentIndex];
    const nextIdx = this._peekNextIndex();
    const nextTrack = nextIdx >= 0 ? this.queue[nextIdx] : null;

    if (this.engine && this.engine.ready) {
      await this._pushTrackReplayGain(current);
      await this.engine.play(current.filePath, nextTrack ? nextTrack.filePath : '');
    }
    this.emit('queue_updated', this.getQueueState());
    return this.getQueueState();
  }

  async enqueue(idOrPath, { playNext = false } = {}) {
    const item = this._resolveTrackItem(idOrPath);
    if (!item) throw new Error('No se encontró la pista solicitada');

    if (playNext && this.currentIndex >= 0) {
      this.queue.splice(this.currentIndex + 1, 0, item);
    } else {
      this.queue.push(item);
    }

    if (this.currentIndex < 0 && this.queue.length === 1) {
      return this.playIndex(0);
    }

    await this._armGaplessNext();
    this.emit('queue_updated', this.getQueueState());
    return this.getQueueState();
  }

  async removeFromQueue(index) {
    const idx = Number(index);
    if (idx < 0 || idx >= this.queue.length) return this.getQueueState();
    const removingCurrent = idx === this.currentIndex;
    this.queue.splice(idx, 1);

    if (this.queue.length === 0) {
      this.currentIndex = -1;
      if (this.engine?.ready) await this.engine.stop();
    } else if (removingCurrent) {
      const nextIdx = Math.min(idx, this.queue.length - 1);
      await this.playIndex(nextIdx);
      return this.getQueueState();
    } else if (idx < this.currentIndex) {
      this.currentIndex--;
    }

    await this._armGaplessNext();
    this.emit('queue_updated', this.getQueueState());
    return this.getQueueState();
  }

  async clearQueue() {
    this.queue = [];
    this.currentIndex = -1;
    if (this.engine?.ready) await this.engine.stop();
    this.emit('queue_updated', this.getQueueState());
    return this.getQueueState();
  }

  async next() {
    if (this.queue.length === 0) return this.getQueueState();
    const nextIdx =
      this.repeatMode === 'one'
        ? (this.currentIndex + 1) % this.queue.length
        : this._peekNextIndex();
    if (nextIdx >= 0) {
      return this.playIndex(nextIdx);
    }
    return this.getQueueState();
  }

  async previous() {
    if (this.queue.length === 0) return this.getQueueState();
    const prevIdx =
      this.currentIndex > 0
        ? this.currentIndex - 1
        : this.repeatMode === 'all'
          ? this.queue.length - 1
          : 0;
    return this.playIndex(prevIdx);
  }

  async setModes({ repeatMode, shuffle } = {}) {
    if (repeatMode && ['off', 'all', 'one'].includes(repeatMode)) {
      this.repeatMode = repeatMode;
    }
    if (typeof shuffle === 'boolean') {
      this.shuffle = shuffle;
    }
    await this._armGaplessNext();
    this.emit('queue_updated', this.getQueueState());
    return this.getQueueState();
  }

  /* ---------------- Standard Playlists CRUD + Import/Export (SQLite) ---------------- */

  listPlaylists() {
    return this.db
      .listPlaylistRecords()
      .map((pl) => this.getPlaylist(pl.id))
      .filter(Boolean);
  }

  getPlaylist(id) {
    return this.db.getPlaylistWithTracks(id, (fp) => this._resolveTrackItem(fp));
  }

  createPlaylist({ name, trackIdsOrPaths = [] }) {
    const cleanName = String(name || '').trim() || 'Nueva Lista';
    const trackPaths = trackIdsOrPaths
      .map((x) => this._resolveTrackItem(x)?.filePath)
      .filter(Boolean);
    const id = `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.db.savePlaylistRecord({
      id,
      name: cleanName,
      trackPaths,
      updatedAt: new Date().toISOString(),
    });
    return this.getPlaylist(id);
  }

  updatePlaylist(id, { name, trackIdsOrPaths }) {
    const existing = this.getPlaylist(id);
    if (!existing) throw new Error('Lista de reproducción no encontrada');
    const newName = typeof name === 'string' && name.trim() ? name.trim() : existing.name;
    const newPaths = Array.isArray(trackIdsOrPaths)
      ? trackIdsOrPaths.map((x) => this._resolveTrackItem(x)?.filePath).filter(Boolean)
      : existing.tracks.map((t) => t.filePath);

    this.db.savePlaylistRecord({
      id: existing.id,
      name: newName,
      trackPaths: newPaths,
      updatedAt: new Date().toISOString(),
    });
    return this.getPlaylist(existing.id);
  }

  deletePlaylist(id) {
    return this.db.deletePlaylistRecord(id);
  }

  exportPlaylist(id, format = 'm3u') {
    const pl = this.getPlaylist(id);
    if (!pl) throw new Error('Lista de reproducción no encontrada');
    const fmt = String(format || 'm3u').toLowerCase();
    if (fmt === 'pls') {
      return {
        mime: 'audio/x-scpls; charset=utf-8',
        ext: 'pls',
        content: serializePls(pl.name, pl.tracks),
      };
    }
    if (fmt === 'xspf') {
      return {
        mime: 'application/xspf+xml; charset=utf-8',
        ext: 'xspf',
        content: serializeXspf(pl.name, pl.tracks),
      };
    }
    return {
      mime: 'audio/x-mpegurl; charset=utf-8',
      ext: 'm3u8',
      content: serializeM3u(pl.name, pl.tracks),
    };
  }

  async importPlaylist({ format = 'auto', content = '', filePath = '', name = '' }) {
    let rawContent = content;
    let baseDir = process.cwd();
    let detectedFormat = format.toLowerCase();

    if (filePath) {
      const abs = path.resolve(filePath);
      rawContent = fs.readFileSync(abs, 'utf8');
      baseDir = path.dirname(abs);
      if (detectedFormat === 'auto') {
        const ext = path.extname(abs).toLowerCase();
        if (ext === '.pls') detectedFormat = 'pls';
        else if (ext === '.xspf' || ext === '.xml') detectedFormat = 'xspf';
        else detectedFormat = 'm3u';
      }
    } else if (detectedFormat === 'auto') {
      const trimmed = rawContent.trimStart();
      if (trimmed.startsWith('<?xml') || trimmed.includes('<playlist')) detectedFormat = 'xspf';
      else if (trimmed.toLowerCase().startsWith('[playlist]')) detectedFormat = 'pls';
      else detectedFormat = 'm3u';
    }

    let parsed;
    if (detectedFormat === 'pls') parsed = parsePls(rawContent, baseDir);
    else if (detectedFormat === 'xspf') parsed = parseXspf(rawContent, baseDir);
    else parsed = parseM3u(rawContent, baseDir);

    const validPaths = [];
    for (const entry of parsed.entries) {
      if (!entry.filePath) continue;
      if (!this.library.getTrackByPath(entry.filePath) && fs.existsSync(entry.filePath)) {
        try {
          await this.library.indexSingleFile(entry.filePath, { saveAfter: false });
        } catch {
          // Keep path even if unindexed
        }
      }
      validPaths.push(entry.filePath);
    }
    this.library._save();

    return this.createPlaylist({
      name: name || parsed.name,
      trackIdsOrPaths: validPaths,
    });
  }

  /* ---------------- Smart Playlists ("Listas Inteligentes" compiladas a SQL) ---------------- */

  listSmartPlaylists() {
    const defs = this.db.listSmartPlaylistDefs();
    return defs.map((sp) => {
      const tracks = this.db.evaluateSmartPlaylistSql(sp, evaluateSmartPlaylist);
      return {
        ...sp,
        trackCount: tracks.length,
        tracks,
      };
    });
  }

  getSmartPlaylist(id) {
    const sp = this.db.getSmartPlaylistDef(id);
    if (!sp) return null;
    const tracks = this.db.evaluateSmartPlaylistSql(sp, evaluateSmartPlaylist);
    return { ...sp, trackCount: tracks.length, tracks };
  }

  saveSmartPlaylist(def) {
    const cleanName = String(def.name || '').trim() || 'Lista Inteligente';
    const id =
      def.id || `smart_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id,
      name: cleanName,
      match: def.match === 'any' ? 'any' : 'all',
      rules: Array.isArray(def.rules) ? def.rules : [],
      sortBy: def.sortBy || 'title',
      sortOrder: def.sortOrder === 'desc' ? 'desc' : 'asc',
      limit: Number(def.limit) > 0 ? Number(def.limit) : 250,
      updatedAt: new Date().toISOString(),
    };

    this.db.saveSmartPlaylistRecord(entry);
    return this.getSmartPlaylist(id);
  }

  deleteSmartPlaylist(id) {
    return this.db.deleteSmartPlaylistRecord(id);
  }
}
