import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineBridge } from './engine/engineBridge.mjs';
import { PresetManager } from './dsp/presetManager.mjs';
import { MusicDatabase } from './db/musicDatabase.mjs';
import { LibraryManager } from './library/libraryManager.mjs';
import { PlaylistManager } from './playlists/playlistManager.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const UI_DIR = path.join(__dirname, 'ui');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

function readJsonBody(req, maxBytes = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Carga útil demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Cuerpo JSON inválido'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export async function createOurMusicApp({
  dataDir = path.join(ROOT_DIR, 'data'),
  port = 0,
  host = '127.0.0.1',
  pollIntervalMs = 100,
  watchFolders = true,
  watcherDebounceMs = 200,
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });

  const engine = new EngineBridge({ pollIntervalMs });
  await engine.start();

  const database = new MusicDatabase(dataDir);
  const presets = new PresetManager(dataDir);
  const library = new LibraryManager({
    dataDir,
    engineBridge: engine,
    database,
    watchFolders,
    watcherDebounceMs,
  });
  const playlists = new PlaylistManager({
    dataDir,
    libraryManager: library,
    engineBridge: engine,
    presetManager: presets,
    database,
  });

  // Push persisted EQ, PEQ, Crossfeed, Convolver, ReplayGain, Resampler & DSP Hook configuration to C11 engine at boot
  const initEq = presets.getActiveState();
  if (initEq.peqMode && Array.isArray(initEq.peqBands) && initEq.peqBands.length > 0) {
    await engine.configureParametricEq({
      enabled: initEq.enabled,
      preampDb: initEq.preampDb,
      smoothing: initEq.smoothingEnabled,
      limiter: initEq.limiterEnabled,
      bands: initEq.peqBands,
    });
  } else {
    await engine.configureEqualizer({
      enabled: initEq.enabled,
      numBands: initEq.numBands,
      preampDb: initEq.preampDb,
      gains: initEq.gains,
      smoothing: initEq.smoothingEnabled,
      limiter: initEq.limiterEnabled,
    });
  }
  await engine.setDspHook({
    enabled: initEq.customHookEnabled,
    stereoWidth: initEq.stereoWidth,
  });
  await engine.setCrossfeed(initEq.crossfeed);
  await engine.setReplayGain(initEq.replayGain);
  await engine.setResampler(initEq.resampler);
  if (initEq.convolver?.irPath && fs.existsSync(initEq.convolver.irPath)) {
    await engine.setConvolver(initEq.convolver).catch(() => {});
  }

  const sseClients = new Set();
  const broadcastSse = (event, data) => {
    if (sseClients.size === 0) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(msg);
      } catch {
        sseClients.delete(res);
      }
    }
  };

  engine.on('telemetry', (st) => broadcastSse('telemetry', st));
  engine.on('track_started', (ev) => broadcastSse('track_started', ev));
  engine.on('playback_ended', (ev) => broadcastSse('playback_ended', ev));
  playlists.on('queue_updated', (q) => broadcastSse('queue_updated', q));
  library.on('scan_started', (p) => broadcastSse('scan_started', p));
  library.on('scan_progress', (p) => broadcastSse('scan_progress', p));
  library.on('scan_completed', (p) => broadcastSse('scan_completed', p));
  library.on('track_updated', (t) => broadcastSse('track_updated', t));
  library.on('watcher_indexed', (t) => broadcastSse('watcher_indexed', t));
  library.on('watcher_removed', (ev) => broadcastSse('watcher_removed', ev));
  library.on('library_changed', (ev) => broadcastSse('library_changed', {
    ...ev,
    summary: library.getSummary(),
  }));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = decodeURIComponent(url.pathname);
      const method = req.method || 'GET';

      /* --- Real-time SSE Stream --- */
      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      /* --- Bootstrap --- */
      if (method === 'GET' && pathname === '/api/bootstrap') {
        const [status, devices] = await Promise.all([engine.getStatus(), engine.listDevices()]);
        const eqState = presets.getActiveState();
        const bootLimit = parseInt(url.searchParams.get('limit') || '0', 10) || 0;
        const bootOffset = parseInt(url.searchParams.get('offset') || '0', 10) || 0;
        const page = library.queryTracksPaginated({ limit: bootLimit, offset: bootOffset });
        return sendJson(res, 200, {
          ok: true,
          platform: process.platform,
          audioApi: process.platform === 'win32' ? 'WASAPI / ASIO' : 'ALSA',
          status,
          devices,
          deviceConfig: engine.deviceConfig,
          eqState,
          presets: presets.listPresets(eqState.numBands),
          queueState: playlists.getQueueState(),
          librarySummary: library.getSummary(),
          dbStats: library.getDatabaseStats(),
          tracks: page.tracks,
          totalTracks: page.total,
          playlists: playlists.listPlaylists(),
          smartPlaylists: playlists.listSmartPlaylists(),
        });
      }

      /* --- Library (SQLite + FTS5 + Pagination) & Tag Editing --- */
      if (method === 'GET' && pathname === '/api/library/tracks') {
        const page = library.queryTracksPaginated({
          search: url.searchParams.get('search') || '',
          codec: url.searchParams.get('codec') || '',
          artist: url.searchParams.get('artist') || '',
          album: url.searchParams.get('album') || '',
          composer: url.searchParams.get('composer') || '',
          hiResOnly: url.searchParams.get('hiResOnly') === 'true',
          losslessOnly: url.searchParams.get('losslessOnly') === 'true',
          syncedLyricsOnly: url.searchParams.get('syncedLyricsOnly') === 'true',
          sortBy: url.searchParams.get('sortBy') || 'title',
          sortOrder: url.searchParams.get('sortOrder') || 'asc',
          limit: parseInt(url.searchParams.get('limit') || '0', 10) || 0,
          offset: parseInt(url.searchParams.get('offset') || '0', 10) || 0,
        });
        return sendJson(res, 200, {
          ok: true,
          tracks: page.tracks,
          total: page.total,
          limit: page.limit,
          offset: page.offset,
        });
      }

      if (method === 'GET' && pathname === '/api/library/db-stats') {
        return sendJson(res, 200, { ok: true, stats: library.getDatabaseStats() });
      }

      if (method === 'GET' && pathname === '/api/library/summary') {
        return sendJson(res, 200, { ok: true, summary: library.getSummary() });
      }

      if (method === 'POST' && pathname === '/api/library/scan') {
        const body = await readJsonBody(req);
        if (!body.directory) return sendJson(res, 400, { ok: false, error: 'Falta el campo directory' });
        const report = await library.scanDirectory(body.directory);
        return sendJson(res, 200, {
          ok: true,
          report,
          summary: library.getSummary(),
          tracks: library.queryTracks(),
          smartPlaylists: playlists.listSmartPlaylists(),
        });
      }

      if (method === 'DELETE' && pathname === '/api/library/folder') {
        const body = await readJsonBody(req);
        if (body.directory) library.removeFolder(body.directory);
        return sendJson(res, 200, {
          ok: true,
          summary: library.getSummary(),
          tracks: library.queryTracks(),
        });
      }

      const trackDetailMatch = /^\/api\/tracks\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && trackDetailMatch) {
        const detail = await library.getTrackFullMetadata(trackDetailMatch[1]);
        return sendJson(res, 200, { ok: true, track: detail });
      }

      const trackTagsMatch = /^\/api\/tracks\/([^/]+)\/tags$/.exec(pathname);
      if (method === 'PUT' && trackTagsMatch) {
        const body = await readJsonBody(req);
        const updated = await library.updateTrackMetadata(trackTagsMatch[1], body);
        return sendJson(res, 200, {
          ok: true,
          track: updated,
          summary: library.getSummary(),
          smartPlaylists: playlists.listSmartPlaylists(),
        });
      }

      const trackLoudnessMatch = /^\/api\/tracks\/([^/]+)\/loudness$/.exec(pathname);
      if (method === 'POST' && trackLoudnessMatch) {
        const body = await readJsonBody(req);
        const result = await library.analyzeTrackLoudness(trackLoudnessMatch[1], {
          writeTags: Boolean(body.writeTags),
        });
        return sendJson(res, 200, { ok: true, ...result });
      }

      const coverMatch = /^\/api\/covers\/([^/]+)$/.exec(pathname);
      if (method === 'GET' && coverMatch) {
        const cp = library.getCoverFilePath(coverMatch[1]);
        if (!cp) {
          res.writeHead(404);
          return res.end('Not found');
        }
        const ext = path.extname(cp).toLowerCase();
        res.writeHead(200, {
          'Content-Type': ext === '.png' ? 'image/png' : 'image/jpeg',
          'Cache-Control': 'public, max-age=86400',
        });
        return fs.createReadStream(cp).pipe(res);
      }

      /* --- Playback & Active Queue --- */
      if (method === 'GET' && pathname === '/api/player/status') {
        const status = await engine.getStatus();
        return sendJson(res, 200, { ok: true, status, queueState: playlists.getQueueState() });
      }

      if (method === 'POST' && pathname === '/api/player/play') {
        const body = await readJsonBody(req);
        let qState;
        if (Array.isArray(body.trackIds) && body.trackIds.length > 0) {
          qState = await playlists.setQueueAndPlay(body.trackIds, body.startIndex ?? 0);
        } else if (body.trackId) {
          qState = await playlists.setQueueAndPlay([body.trackId], 0);
        } else if (body.path) {
          qState = await playlists.setQueueAndPlay([body.path], 0);
        } else if (typeof body.queueIndex === 'number') {
          qState = await playlists.playIndex(body.queueIndex);
        } else {
          await engine.pause(false);
          qState = playlists.getQueueState();
        }
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      if (method === 'POST' && pathname === '/api/player/pause') {
        const body = await readJsonBody(req);
        await engine.pause(body.paused !== undefined ? Boolean(body.paused) : true);
        return sendJson(res, 200, { ok: true, status: await engine.getStatus() });
      }

      if (method === 'POST' && pathname === '/api/player/stop') {
        await engine.stop();
        return sendJson(res, 200, { ok: true, status: await engine.getStatus() });
      }

      if (method === 'POST' && pathname === '/api/player/seek') {
        const body = await readJsonBody(req);
        await engine.seek(body.seconds ?? 0);
        return sendJson(res, 200, { ok: true, status: await engine.getStatus() });
      }

      if (method === 'POST' && pathname === '/api/player/next') {
        const qState = await playlists.next();
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      if (method === 'POST' && pathname === '/api/player/previous') {
        const qState = await playlists.previous();
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      if (method === 'POST' && pathname === '/api/player/volume') {
        const body = await readJsonBody(req);
        await engine.setVolume(body.value ?? 1.0);
        return sendJson(res, 200, { ok: true, status: await engine.getStatus() });
      }

      if (method === 'POST' && pathname === '/api/player/modes') {
        const body = await readJsonBody(req);
        const qState = await playlists.setModes(body);
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      if (method === 'POST' && pathname === '/api/queue/enqueue') {
        const body = await readJsonBody(req);
        const qState = await playlists.enqueue(body.trackId || body.path, {
          playNext: Boolean(body.playNext),
        });
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      const queueDelMatch = /^\/api\/queue\/(\d+)$/.exec(pathname);
      if (method === 'DELETE' && queueDelMatch) {
        const qState = await playlists.removeFromQueue(parseInt(queueDelMatch[1], 10));
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      if (method === 'DELETE' && pathname === '/api/queue') {
        const qState = await playlists.clearQueue();
        return sendJson(res, 200, { ok: true, queueState: qState });
      }

      /* --- Output Devices & Bit-Perfect / DoP Configuration --- */
      if (method === 'GET' && pathname === '/api/devices') {
        const devices = await engine.listDevices();
        return sendJson(res, 200, { ok: true, devices, deviceConfig: engine.deviceConfig });
      }

      if (method === 'POST' && pathname === '/api/devices') {
        const body = await readJsonBody(req);
        await engine.setDevice(body);
        return sendJson(res, 200, { ok: true, deviceConfig: engine.deviceConfig });
      }

      /* --- DSP Pipeline Hook, Equalizer, Presets & Parameter Smoothing --- */
      if (method === 'GET' && pathname === '/api/eq') {
        const eqState = presets.getActiveState();
        return sendJson(res, 200, {
          ok: true,
          eqState,
          presets: presets.listPresets(eqState.numBands),
        });
      }

      if (method === 'POST' && pathname === '/api/eq') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState(body);
        await engine.configureEqualizer({
          enabled: eqState.enabled,
          numBands: eqState.numBands,
          preampDb: eqState.preampDb,
          gains: eqState.gains,
          smoothing: eqState.smoothingEnabled,
          limiter: eqState.limiterEnabled,
        });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, {
          ok: true,
          eqState,
          presets: presets.listPresets(eqState.numBands),
        });
      }

      if (method === 'POST' && pathname === '/api/eq/band') {
        const body = await readJsonBody(req);
        const idx = Number(body.band);
        const gainDb = Number(body.gainDb) || 0;
        const cur = presets.getActiveState();
        if (idx >= 0 && idx < cur.gains.length) {
          cur.gains[idx] = gainDb;
        }
        const eqState = presets.saveActiveState({ gains: cur.gains, activePresetId: 'custom' });
        await engine.setBandGain(idx, eqState.gains[idx]);
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/eq/preamp') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({ preampDb: Number(body.preampDb) || 0 });
        await engine.setPreamp(eqState.preampDb);
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/eq/smoothing') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({ smoothingEnabled: Boolean(body.enabled) });
        await engine.setSmoothing(eqState.smoothingEnabled);
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/eq/hook') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({
          customHookEnabled:
            body.enabled !== undefined ? Boolean(body.enabled) : presets.activeState.customHookEnabled,
          stereoWidth:
            body.stereoWidth !== undefined ? Number(body.stereoWidth) : presets.activeState.stereoWidth,
        });
        await engine.setDspHook({
          enabled: eqState.customHookEnabled,
          stereoWidth: eqState.stereoWidth,
        });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'GET' && pathname === '/api/eq/presets') {
        const nb = parseInt(url.searchParams.get('numBands') || '', 10) || presets.activeState.numBands;
        return sendJson(res, 200, { ok: true, presets: presets.listPresets(nb) });
      }

      if (method === 'POST' && pathname === '/api/eq/presets') {
        const body = await readJsonBody(req);
        const saved = presets.saveUserPreset({
          id: body.id,
          name: body.name,
          numBands: body.numBands || presets.activeState.numBands,
          preampDb: body.preampDb ?? presets.activeState.preampDb,
          gains: body.gains || presets.activeState.gains,
          smoothingEnabled: body.smoothingEnabled ?? presets.activeState.smoothingEnabled,
        });
        const eqState = presets.saveActiveState({ activePresetId: saved.id });
        return sendJson(res, 200, {
          ok: true,
          preset: saved,
          eqState,
          presets: presets.listPresets(eqState.numBands),
        });
      }

      if (method === 'POST' && pathname === '/api/eq/presets/apply') {
        const body = await readJsonBody(req);
        const nb = body.numBands || presets.activeState.numBands;
        const p = presets.getPreset(body.id, nb);
        if (!p) return sendJson(res, 404, { ok: false, error: 'Preset no encontrado' });
        const eqState = presets.saveActiveState({
          numBands: p.numBands,
          preampDb: p.preampDb,
          gains: p.gains,
          activePresetId: p.id,
        });
        await engine.configureEqualizer({
          enabled: eqState.enabled,
          numBands: eqState.numBands,
          preampDb: eqState.preampDb,
          gains: eqState.gains,
          smoothing: eqState.smoothingEnabled,
          limiter: eqState.limiterEnabled,
        });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/eq/presets/import') {
        const body = await readJsonBody(req);
        const imported = presets.importPresetJson(body.json || body);
        return sendJson(res, 200, {
          ok: true,
          preset: imported,
          presets: presets.listPresets(presets.activeState.numBands),
        });
      }

      const presetExportMatch = /^\/api\/eq\/presets\/([^/]+)\/export$/.exec(pathname);
      if (method === 'GET' && presetExportMatch) {
        const jsonStr = presets.exportPresetJson(presetExportMatch[1]);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': `attachment; filename="ourmusic-preset-${presetExportMatch[1]}.json"`,
        });
        return res.end(jsonStr);
      }

      const presetDelMatch = /^\/api\/eq\/presets\/([^/]+)$/.exec(pathname);
      if (method === 'DELETE' && presetDelMatch) {
        presets.deleteUserPreset(presetDelMatch[1]);
        return sendJson(res, 200, {
          ok: true,
          eqState: presets.getActiveState(),
          presets: presets.listPresets(presets.activeState.numBands),
        });
      }

      /* --- Point 1 & Point 2 Advanced Audiophile DSP & SRC Endpoints --- */
      if (method === 'GET' && pathname === '/api/dsp') {
        const [status] = await Promise.all([engine.getStatus()]);
        return sendJson(res, 200, {
          ok: true,
          eqState: presets.getActiveState(),
          engineDsp: status?.eq || null,
          resampler: {
            active: Boolean(status?.resamplerActive),
            targetRate: status?.resamplerTargetRate || 0,
            quality: status?.resamplerQuality || 'high',
          },
        });
      }

      if (method === 'POST' && pathname === '/api/dsp/peq') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : presets.activeState.enabled,
          peqMode: body.peqMode !== undefined ? Boolean(body.peqMode) : true,
          preampDb: body.preampDb !== undefined ? Number(body.preampDb) : presets.activeState.preampDb,
          smoothingEnabled:
            body.smoothing !== undefined ? Boolean(body.smoothing) : presets.activeState.smoothingEnabled,
          limiterEnabled:
            body.limiter !== undefined ? Boolean(body.limiter) : presets.activeState.limiterEnabled,
          peqBands: Array.isArray(body.bands) ? body.bands : presets.activeState.peqBands,
        });
        await engine.configureParametricEq({
          enabled: eqState.enabled,
          preampDb: eqState.preampDb,
          smoothing: eqState.smoothingEnabled,
          limiter: eqState.limiterEnabled,
          bands: eqState.peqBands,
        });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/dsp/peq/band') {
        const body = await readJsonBody(req);
        const idx = Math.max(0, Math.min(15, Number(body.band) || 0));
        const cur = presets.getActiveState();
        while (cur.peqBands.length <= idx) {
          cur.peqBands.push({ enabled: false, type: 'peaking', freq: 1000, q: 1.0, gainDb: 0 });
        }
        cur.peqBands[idx] = {
          enabled: body.enabled !== undefined ? Boolean(body.enabled) : cur.peqBands[idx].enabled,
          type: body.type || cur.peqBands[idx].type,
          freq: body.freq !== undefined ? Number(body.freq) : cur.peqBands[idx].freq,
          q: body.q !== undefined ? Number(body.q) : cur.peqBands[idx].q,
          gainDb: body.gainDb !== undefined ? Number(body.gainDb) : cur.peqBands[idx].gainDb,
        };
        const eqState = presets.saveActiveState({ peqMode: true, peqBands: cur.peqBands });
        await engine.setPeqBand({ band: idx, ...eqState.peqBands[idx] });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState });
      }

      if (method === 'POST' && pathname === '/api/dsp/crossfeed') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({ crossfeed: body });
        await engine.setCrossfeed(eqState.crossfeed);
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState, crossfeed: eqState.crossfeed });
      }

      if (method === 'POST' && pathname === '/api/dsp/convolver') {
        const body = await readJsonBody(req);
        await engine.setConvolver({
          enabled: body.enabled ?? presets.activeState.convolver.enabled,
          irPath: body.irPath !== undefined ? body.irPath : presets.activeState.convolver.irPath,
          mix: body.mix ?? presets.activeState.convolver.mix,
          gainDb: body.gainDb ?? presets.activeState.convolver.gainDb,
          autoNormalize: body.autoNormalize ?? presets.activeState.convolver.autoNormalize,
        });
        const eqState = presets.saveActiveState({ convolver: body });
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState, convolver: eqState.convolver });
      }

      if (method === 'POST' && pathname === '/api/dsp/replaygain') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({ replayGain: body });
        await engine.setReplayGain({
          ...eqState.replayGain,
          ...(typeof body.trackGainDb === 'number' ? { trackGainDb: body.trackGainDb } : {}),
          ...(typeof body.trackPeak === 'number' ? { trackPeak: body.trackPeak } : {}),
          ...(typeof body.albumGainDb === 'number' ? { albumGainDb: body.albumGainDb } : {}),
          ...(typeof body.albumPeak === 'number' ? { albumPeak: body.albumPeak } : {}),
        });
        const curTrack = playlists.getQueueState().currentTrack;
        if (curTrack && body.trackGainDb === undefined) {
          await playlists._pushTrackReplayGain(curTrack);
        }
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState, replayGain: eqState.replayGain });
      }

      if (method === 'POST' && pathname === '/api/dsp/resampler') {
        const body = await readJsonBody(req);
        const eqState = presets.saveActiveState({ resampler: body });
        await engine.setResampler(eqState.resampler);
        broadcastSse('eq_updated', eqState);
        return sendJson(res, 200, { ok: true, eqState, resampler: eqState.resampler });
      }

      /* --- Playlists (M3U/PLS/XSPF) & Smart Playlists --- */
      if (method === 'GET' && pathname === '/api/playlists') {
        return sendJson(res, 200, {
          ok: true,
          playlists: playlists.listPlaylists(),
          smartPlaylists: playlists.listSmartPlaylists(),
        });
      }

      if (method === 'POST' && pathname === '/api/playlists') {
        const body = await readJsonBody(req);
        const created = playlists.createPlaylist(body);
        return sendJson(res, 201, {
          ok: true,
          playlist: created,
          playlists: playlists.listPlaylists(),
        });
      }

      if (method === 'POST' && pathname === '/api/playlists/import') {
        const body = await readJsonBody(req);
        const imported = await playlists.importPlaylist(body);
        return sendJson(res, 201, {
          ok: true,
          playlist: imported,
          playlists: playlists.listPlaylists(),
          tracks: library.queryTracks(),
        });
      }

      const plExportMatch = /^\/api\/playlists\/([^/]+)\/export$/.exec(pathname);
      if (method === 'GET' && plExportMatch) {
        const fmt = url.searchParams.get('format') || 'm3u';
        const exported = playlists.exportPlaylist(plExportMatch[1], fmt);
        res.writeHead(200, {
          'Content-Type': exported.mime,
          'Content-Disposition': `attachment; filename="playlist-${plExportMatch[1]}.${exported.ext}"`,
        });
        return res.end(exported.content);
      }

      const plItemMatch = /^\/api\/playlists\/([^/]+)$/.exec(pathname);
      if (method === 'PUT' && plItemMatch) {
        const body = await readJsonBody(req);
        const updated = playlists.updatePlaylist(plItemMatch[1], body);
        return sendJson(res, 200, {
          ok: true,
          playlist: updated,
          playlists: playlists.listPlaylists(),
        });
      }
      if (method === 'DELETE' && plItemMatch) {
        playlists.deletePlaylist(plItemMatch[1]);
        return sendJson(res, 200, { ok: true, playlists: playlists.listPlaylists() });
      }

      if (method === 'GET' && pathname === '/api/smart-playlists') {
        return sendJson(res, 200, { ok: true, smartPlaylists: playlists.listSmartPlaylists() });
      }

      if (method === 'POST' && pathname === '/api/smart-playlists') {
        const body = await readJsonBody(req);
        const saved = playlists.saveSmartPlaylist(body);
        return sendJson(res, 200, {
          ok: true,
          smartPlaylist: saved,
          smartPlaylists: playlists.listSmartPlaylists(),
        });
      }

      const smartDelMatch = /^\/api\/smart-playlists\/([^/]+)$/.exec(pathname);
      if (method === 'DELETE' && smartDelMatch) {
        playlists.deleteSmartPlaylist(smartDelMatch[1]);
        return sendJson(res, 200, { ok: true, smartPlaylists: playlists.listSmartPlaylists() });
      }

      /* --- Static Clean-Room UI Serving --- */
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const safePath = path.resolve(UI_DIR, rel);
      if (!safePath.startsWith(UI_DIR + path.sep) && safePath !== path.join(UI_DIR, 'index.html')) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if (fs.existsSync(safePath) && fs.statSync(safePath).isFile()) {
        const ext = path.extname(safePath).toLowerCase();
        res.writeHead(200, {
          'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
          'Cache-Control': 'no-cache',
        });
        return fs.createReadStream(safePath).pipe(res);
      }

      sendJson(res, 404, { ok: false, error: `Ruta no encontrada: ${pathname}` });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Error interno del servidor' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const baseUrl = `http://${host}:${actualPort}`;

  const close = async () => {
    for (const c of sseClients) {
      try {
        c.end();
      } catch {
        // ignore
      }
    }
    sseClients.clear();
    library.close();
    await new Promise((resolve) => server.close(() => resolve()));
    await engine.shutdown();
    database.close();
  };

  return {
    baseUrl,
    port: actualPort,
    server,
    engine,
    database,
    presets,
    library,
    playlists,
    close,
  };
}
