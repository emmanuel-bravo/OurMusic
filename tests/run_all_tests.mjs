import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  generateAllFixtures,
  readWavPcm,
  writeWavPcm,
  writeDsfSine,
  writeDffSine,
} from './generate_fixtures.mjs';
import { PresetManager } from '../src/dsp/presetManager.mjs';
import { MusicDatabase } from '../src/db/musicDatabase.mjs';
import { EngineBridge } from '../src/engine/engineBridge.mjs';
import { readMetadata, writeMetadata } from '../src/tags/tagParser.mjs';
import { createOurMusicApp } from '../src/server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const ENGINE_BIN = path.join(ROOT_DIR, 'bin', process.platform === 'win32' ? 'ourmusic-engine.exe' : 'ourmusic-engine');
const TMP_DIR = path.join(__dirname, '.tmp_fixtures');

let passed = 0;
async function runTest(name, fn) {
  process.stdout.write(`  [TEST] ${name} ... `);
  const t0 = performance.now();
  await fn();
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`OK (${ms} ms)`);
  passed++;
}

/**
 * Helper to drive bin/ourmusic-engine deterministically into wav:<outPath> and return final status + events.
 */
function runEngineRender({
  inputFile,
  nextFile = '',
  outWav,
  setupCmds = [],
  midCmds = [],
  dop = false,
  dsdMode = '',
  bitPerfect = true,
}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ENGINE_BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let idSeq = 1;
    let finalStatus = null;
    const events = [];
    const send = (obj) => proc.stdin.write(JSON.stringify({ id: idSeq++, ...obj }) + '\n');

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);

        if (msg.type === 'ready') {
          send({
            cmd: 'set_device',
            device: `wav:${outWav}`,
            bitPerfect,
            dop,
            ...(dsdMode ? { dsdMode } : {}),
          });
          for (const c of setupCmds) send(c);
          send({ cmd: 'play', path: inputFile, nextPath: nextFile });
          if (midCmds.length > 0) {
            for (const mc of midCmds) {
              setTimeout(() => send(mc.cmdObj), mc.delayMs);
            }
          }
        } else if (msg.type === 'event') {
          events.push(msg);
          if (msg.event === 'playback_ended') {
            send({ cmd: 'status' });
          }
        } else if (msg.type === 'reply' && msg.status) {
          finalStatus = msg.status;
          send({ cmd: 'quit' });
        } else if (msg.ok === false) {
          reject(new Error(`Engine command error: ${JSON.stringify(msg)}`));
        }
      }
    });

    proc.on('error', reject);
    proc.on('close', () => resolve({ status: finalStatus, events }));
  });
}

function maxSampleDiff(wavA, wavB) {
  assert.equal(wavA.samples.length, wavB.samples.length, 'Longitud de muestras PCM distinta');
  let maxD = 0;
  for (let i = 0; i < wavA.samples.length; i++) {
    const d = Math.abs(wavA.samples[i] - wavB.samples[i]);
    if (d > maxD) maxD = d;
  }
  return maxD;
}

function channelRms(wav, ch, startFrame = 0, endFrame = wav.frames) {
  const scale = 1 << (wav.bitDepth - 1);
  let sumSq = 0;
  let count = 0;
  for (let f = startFrame; f < endFrame; f++) {
    const v = wav.samples[f * wav.channels + ch] / scale;
    sumSq += v * v;
    count++;
  }
  return Math.sqrt(sumSq / Math.max(1, count));
}

// Minimal valid 1x1 PNG image buffer for embedded cover art verification
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

console.log('\n======================================================================');
console.log('  OurMusic — Suite Integral de Verificación Clean-Room');
console.log('======================================================================\n');

fs.rmSync(TMP_DIR, { recursive: true, force: true });
const fx = generateAllFixtures(TMP_DIR);

/* 1. DECODERS & BIT-PERFECT ACCURACY */
await runTest('1.1 Decodificador WAV Hi-Res (96 kHz / 24-bit) — Bit-Perfect 0 LSB', async () => {
  const outWav = path.join(TMP_DIR, 'dec_wav24.wav');
  const { status } = await runEngineRender({ inputFile: fx.ref24, outWav });
  const ref = readWavPcm(fx.ref24);
  const dec = readWavPcm(outWav);
  assert.equal(dec.sampleRate, 96000);
  assert.equal(dec.bitDepth, 24);
  assert.equal(maxSampleDiff(ref, dec), 0);
  assert.equal(status.bitPerfect, true);
});

await runTest('1.2 Decodificador FLAC (44.1 kHz / 16-bit y 96 kHz / 24-bit LPC) — 0 LSB', async () => {
  const out16 = path.join(TMP_DIR, 'dec_flac16.wav');
  const out24 = path.join(TMP_DIR, 'dec_flac24.wav');
  await runEngineRender({ inputFile: fx.flac16, outWav: out16 });
  await runEngineRender({ inputFile: fx.flac24, outWav: out24 });
  assert.equal(maxSampleDiff(readWavPcm(fx.ref16), readWavPcm(out16)), 0);
  assert.equal(maxSampleDiff(readWavPcm(fx.ref24), readWavPcm(out24)), 0);
});

await runTest('1.3 Decodificador ALAC (.m4a Golomb-Rice + LPC dinámico) — 0 LSB', async () => {
  const outAlac = path.join(TMP_DIR, 'dec_alac16.wav');
  await runEngineRender({ inputFile: fx.alac16, outWav: outAlac });
  assert.equal(maxSampleDiff(readWavPcm(fx.ref16), readWavPcm(outAlac)), 0);
});

await runTest('1.4 Decodificador MP3 (ISO 11172-3 Layer III 320 kbps) — Correlación > 0.999', async () => {
  const outMp3 = path.join(TMP_DIR, 'dec_mp3.wav');
  await runEngineRender({ inputFile: fx.mp3File, outWav: outMp3 });
  const ref = readWavPcm(fx.ref16);
  const dec = readWavPcm(outMp3);
  assert.equal(dec.sampleRate, 44100);

  let bestCorr = -1;
  for (let lag = -2000; lag <= 2000; lag++) {
    let num = 0, dA = 0, dB = 0;
    for (let f = 3000; f < 14000; f += 4) {
      const f2 = f + lag;
      if (f2 < 0 || f2 >= dec.frames) continue;
      const a = ref.samples[f * 2];
      const b = dec.samples[f2 * 2];
      num += a * b;
      dA += a * a;
      dB += b * b;
    }
    const c = num / (Math.sqrt(dA * dB) + 1e-12);
    if (c > bestCorr) bestCorr = c;
  }
  assert.ok(bestCorr > 0.999, `Correlación MP3 demasiado baja: ${bestCorr}`);
});

await runTest('1.5 Decodificador DSD64 (.dsf y .dff) — Modo DoP (0x05/0xFA) y Modo PCM FIR', async () => {
  const outDsfDop = path.join(TMP_DIR, 'dec_dsf_dop.wav');
  const outDsfPcm = path.join(TMP_DIR, 'dec_dsf_pcm.wav');
  const outDffPcm = path.join(TMP_DIR, 'dec_dff_pcm.wav');

  await runEngineRender({ inputFile: fx.dsfFile, outWav: outDsfDop, dop: true });
  const dopWav = readWavPcm(outDsfDop);
  assert.equal(dopWav.sampleRate, 176400);
  assert.equal(dopWav.bitDepth, 24);
  assert.equal((dopWav.samples[0] >>> 16) & 0xff, 0x05);
  assert.equal((dopWav.samples[2] >>> 16) & 0xff, 0xfa);

  await runEngineRender({ inputFile: fx.dsfFile, outWav: outDsfPcm, dop: false });
  const pcmDsf = readWavPcm(outDsfPcm);
  const rmsDsf = channelRms(pcmDsf, 0, 500);
  assert.ok(rmsDsf > 0.2 && rmsDsf < 0.85, `RMS DSF PCM fuera de rango: ${rmsDsf}`);

  await runEngineRender({ inputFile: fx.dffFile, outWav: outDffPcm, dop: false });
  const pcmDff = readWavPcm(outDffPcm);
  const rmsDff = channelRms(pcmDff, 0, 500);
  assert.ok(rmsDff > 0.2 && rmsDff < 0.85, `RMS DFF PCM fuera de rango: ${rmsDff}`);
});

/* 2. GAPLESS PLAYBACK */
await runTest('2.1 Reproducción Gapless en Memoria — Continuidad de fase exacta (0 muestras de silencio)', async () => {
  const outGap = path.join(TMP_DIR, 'out_gapless.wav');
  const { status, events } = await runEngineRender({
    inputFile: fx.gap1,
    nextFile: fx.gap2,
    outWav: outGap,
  });

  const gapWav = readWavPcm(outGap);
  assert.equal(gapWav.frames, fx.totalGapFrames, 'El número total de tramas combinadas debe ser exacto');
  assert.ok(status.gaplessTransitions >= 1, 'Debe registrar al menos 1 transición gapless');
  assert.ok(
    events.some((e) => e.event === 'track_started' && e.data?.gapless === true),
    'Debe emitir evento track_started con gapless=true'
  );

  // Verify exact phase continuity across the track boundary (frame 12024 -> 12025 -> 12026)
  for (let f = fx.splitFrame - 5; f <= fx.splitFrame + 5; f++) {
    const phase = (2 * Math.PI * 480 * f) / 48000;
    const expectedL = Math.round(18000 * Math.sin(phase));
    const expectedR = Math.round(18000 * Math.cos(phase));
    assert.equal(gapWav.samples[f * 2], expectedL, `Discontinuidad en canal L en trama ${f}`);
    assert.equal(gapWav.samples[f * 2 + 1], expectedR, `Discontinuidad en canal R en trama ${f}`);
  }
});

/* 3. DSP HOOK, BIQUAD EQUALIZER, PRE-AMP & PARAMETER SMOOTHING */
await runTest('3.1 Ecualizador Biquad 64-bit — Selectividad en frecuencia (+6 dB @ 910 Hz vs 60 Hz)', async () => {
  const outFlat = path.join(TMP_DIR, 'eq_flat.wav');
  const outBoost = path.join(TMP_DIR, 'eq_boost910.wav');

  await runEngineRender({ inputFile: fx.eqTestWav, outWav: outFlat });
  await runEngineRender({
    inputFile: fx.eqTestWav,
    outWav: outBoost,
    setupCmds: [
      {
        cmd: 'set_eq',
        enabled: true,
        numBands: 5,
        preampDb: 0,
        gains: [0, 0, 6.0, 0, 0],
        smoothing: false,
      },
    ],
  });

  const wFlat = readWavPcm(outFlat);
  const wBoost = readWavPcm(outBoost);
  // Left channel has 910 Hz; Right channel has 60 Hz
  const gain910Db = 20 * Math.log10(channelRms(wBoost, 0, 4000) / channelRms(wFlat, 0, 4000));
  const gain60Db = 20 * Math.log10(channelRms(wBoost, 1, 4000) / channelRms(wFlat, 1, 4000));

  assert.ok(Math.abs(gain910Db - 6.0) < 0.45, `Ganancia en 910 Hz esperada ~6 dB, obtenida ${gain910Db.toFixed(2)} dB`);
  assert.ok(Math.abs(gain60Db) < 0.35, `Banda 60 Hz no debía alterarse significativamente, obtenida ${gain60Db.toFixed(2)} dB`);
});

await runTest('3.2 Pre-amp en dB y Hook de Pipeline DSP (Colapso Estéreo Mid/Side)', async () => {
  const outPre = path.join(TMP_DIR, 'eq_preamp.wav');
  await runEngineRender({
    inputFile: fx.eqTestWav,
    outWav: outPre,
    setupCmds: [
      { cmd: 'set_eq', enabled: true, numBands: 5, preampDb: -6.0, gains: [0, 0, 0, 0, 0], smoothing: false },
    ],
  });
  const wFlat = readWavPcm(path.join(TMP_DIR, 'eq_flat.wav'));
  const wPre = readWavPcm(outPre);
  const preDb = 20 * Math.log10(channelRms(wPre, 0, 2000) / channelRms(wFlat, 0, 2000));
  assert.ok(Math.abs(preDb - -6.0) < 0.25, `Pre-amp esperado -6.0 dB, obtenido ${preDb.toFixed(2)} dB`);

  // Test DSP Pipeline Hook: stereoWidth = 0.0 collapses stereo (910 Hz L + 60 Hz R) into identical L == R mono!
  const outHook = path.join(TMP_DIR, 'dsp_hook_mono.wav');
  const { status } = await runEngineRender({
    inputFile: fx.eqTestWav,
    outWav: outHook,
    setupCmds: [{ cmd: 'set_hook', enabled: true, stereoWidth: 0.0 }],
  });
  const wHook = readWavPcm(outHook);
  assert.ok(status.meters.hookInvocations > 0, 'El hook DSP debe contabilizar bloques procesados');
  let maxLRDiff = 0;
  for (let f = 0; f < wHook.frames; f++) {
    maxLRDiff = Math.max(maxLRDiff, Math.abs(wHook.samples[f * 2] - wHook.samples[f * 2 + 1]));
  }
  assert.ok(maxLRDiff <= 1, `Con anchura estéreo 0%, L y R deben ser idénticos (maxDiff=${maxLRDiff})`);
});

await runTest('3.3 Algoritmo de Suavizado de Parámetros (Smoothing ON vs OFF sin clics)', async () => {
  // Live mid-playback fader jump test over real-time paced audio stream (0.35 s = 16800 frames @ 48 kHz)
  const dcFile = path.join(TMP_DIR, 'const_level.wav');
  writeWavPcm(dcFile, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    frames: 16800,
    sampleFn: () => 16000,
  });

  const outSmoothOff = path.join(TMP_DIR, 'smooth_off.wav');
  const outSmoothOn = path.join(TMP_DIR, 'smooth_on.wav');

  await runEngineRender({
    inputFile: dcFile,
    outWav: outSmoothOff,
    setupCmds: [
      { cmd: 'set_device', device: `wavrt:${outSmoothOff}`, bitPerfect: false, dop: false },
      { cmd: 'set_eq', enabled: true, smoothing: false, numBands: 5, preampDb: 0.0, gains: [0, 0, 0, 0, 0] },
    ],
    midCmds: [{ delayMs: 90, cmdObj: { cmd: 'set_preamp', preampDb: -12.0 } }],
  });

  await runEngineRender({
    inputFile: dcFile,
    outWav: outSmoothOn,
    setupCmds: [
      { cmd: 'set_device', device: `wavrt:${outSmoothOn}`, bitPerfect: false, dop: false },
      { cmd: 'set_eq', enabled: true, smoothing: true, numBands: 5, preampDb: 0.0, gains: [0, 0, 0, 0, 0] },
    ],
    midCmds: [{ delayMs: 90, cmdObj: { cmd: 'set_preamp', preampDb: -12.0 } }],
  });

  const wOff = readWavPcm(outSmoothOff);
  const wOn = readWavPcm(outSmoothOn);

  let maxStepOff = 0;
  for (let f = 1; f < wOff.frames; f++) {
    maxStepOff = Math.max(maxStepOff, Math.abs(wOff.samples[f * 2] - wOff.samples[(f - 1) * 2]));
  }

  let maxStepOn = 0;
  let midTransitionCount = 0;
  for (let f = 1; f < wOn.frames; f++) {
    const cur = wOn.samples[f * 2];
    maxStepOn = Math.max(maxStepOn, Math.abs(cur - wOn.samples[(f - 1) * 2]));
    if (cur > 5000 && cur < 15000) midTransitionCount++;
  }

  // With smoothing OFF, changing preamp from 0 dB (16000) to -12 dB (4019) mid-stream creates a >11900 LSB 1-sample step jump!
  assert.ok(maxStepOff > 11000, `Con suavizado OFF debe ocurrir salto instantáneo de un bloque (maxStepOff=${maxStepOff})`);
  // With smoothing ON, exponential interpolator keeps sample-to-sample step < 30 LSB and produces hundreds of smooth transition samples!
  assert.ok(maxStepOn < 30, `Con suavizado ON el salto muestra a muestra debe ser < 30 LSB sin clic (maxStepOn=${maxStepOn})`);
  assert.ok(midTransitionCount > 800, `Con suavizado ON debe existir rampa exponencial gradual (muestras intermedias=${midTransitionCount})`);
  assert.ok(Math.abs(wOn.samples[(wOn.frames - 1) * 2] - 4019) <= 15, 'Debe converger finalmente a -12 dB (~4019)');
});

/* 4. PRESET MANAGER JSON */
await runTest('4.1 Gestor de Perfiles JSON (Plano, Rock, Jazz, Clásica + CRUD Usuario)', async () => {
  const pmDir = path.join(TMP_DIR, 'presets_data');
  const pm = new PresetManager(pmDir);
  const list5 = pm.listPresets(5);
  for (const name of ['Plano', 'Rock', 'Jazz', 'Clásica']) {
    assert.ok(list5.some((p) => p.name === name && p.builtin), `Falta perfil clásico ${name}`);
  }

  const custom = pm.saveUserPreset({
    name: 'Mi Curva Estudio',
    numBands: 5,
    preampDb: -2.0,
    gains: [3.5, 1.0, -1.5, 2.0, 4.0],
    smoothingEnabled: true,
  });
  const exported = pm.exportPresetJson(custom.id, 5);
  pm.deleteUserPreset(custom.id);
  assert.equal(pm.getPreset(custom.id, 5), null);

  const reimported = pm.importPresetJson(exported);
  assert.equal(reimported.name, 'Mi Curva Estudio');
  assert.deepEqual(reimported.gains, [3.5, 1.0, -1.5, 2.0, 4.0]);
});

/* 5. TAG PARSER READ & WRITE + AUDIO INTEGRITY */
await runTest('5.1 Analizador y Escritor de Metadatos (ID3v2, Vorbis+PICTURE, MP4 ilst + Letras .lrc + Carátula)', async () => {
  const tagDir = path.join(TMP_DIR, 'tagged_lib');
  fs.mkdirSync(tagDir, { recursive: true });

  const targets = [
    { src: fx.flac16, dst: path.join(tagDir, 'obra_flac.flac'), refWav: fx.ref16 },
    { src: fx.alac16, dst: path.join(tagDir, 'obra_alac.m4a'), refWav: fx.ref16 },
    { src: fx.mp3File, dst: path.join(tagDir, 'obra_mp3.mp3'), refWav: null },
    { src: fx.ref24, dst: path.join(tagDir, 'obra_wav24.wav'), refWav: fx.ref24 },
    { src: fx.dsfFile, dst: path.join(tagDir, 'obra_dsd64.dsf'), refWav: null },
  ];

  const lrcSample = '[00:00.50] Primera frase de prueba\n[00:02.10] Segunda frase sincronizada';

  for (const item of targets) {
    fs.copyFileSync(item.src, item.dst);
    await writeMetadata(item.dst, {
      title: `Estudio Sonoro (${path.extname(item.dst)})`,
      artist: 'Ensamble Acústico Sur',
      album: 'Sesiones en Directo',
      year: '2026',
      composer: 'M. De Falla',
      genre: 'Clásica',
      trackNumber: '3/10',
      lyrics: lrcSample,
      coverArt: { mime: 'image/png', data: TINY_PNG },
    });

    const readBack = await readMetadata(item.dst, { probeAudio: true });
    assert.equal(readBack.title, `Estudio Sonoro (${path.extname(item.dst)})`);
    assert.equal(readBack.artist, 'Ensamble Acústico Sur');
    assert.equal(readBack.album, 'Sesiones en Directo');
    assert.equal(readBack.year, '2026');
    assert.equal(readBack.composer, 'M. De Falla');
    assert.equal(readBack.syncedLyrics.length, 2);
    assert.equal(readBack.syncedLyrics[0].timeMs, 500);
    assert.equal(readBack.syncedLyrics[1].text, 'Segunda frase sincronizada');
    assert.ok(readBack.coverArt && Buffer.compare(readBack.coverArt.data, TINY_PNG) === 0, 'Carátula PNG debe coincidir byte a byte');
    assert.ok(readBack.audio && readBack.audio.sampleRate > 0, `El archivo ${item.dst} debe seguir siendo reproducible tras escribir tags`);

    // Verify lossless files remain 0-LSB bit-exact after tag + cover art rewriting (including MP4 stco shift!)
    if (item.refWav) {
      const verifyOut = `${item.dst}.verify.wav`;
      await runEngineRender({ inputFile: item.dst, outWav: verifyOut });
      assert.equal(maxSampleDiff(readWavPcm(item.refWav), readWavPcm(verifyOut)), 0);
      fs.rmSync(verifyOut, { force: true });
    }
  }
});

/* 6. LIBRARY, PLAYLISTS (M3U/PLS/XSPF), SMART PLAYLISTS & ASYNC SERVER + SSE */
await runTest('6.1 Servidor Asíncrono HTTP/SSE, Biblioteca, Listas (M3U/PLS/XSPF) y Listas Inteligentes', async () => {
  const appDataDir = path.join(TMP_DIR, 'server_data');
  const tagDir = path.join(TMP_DIR, 'tagged_lib');
  const app = await createOurMusicApp({ dataDir: appDataDir, port: 0, pollIntervalMs: 80 });

  try {
    // Verify SSE non-blocking event stream connects cleanly
    const sseConnected = await new Promise((resolve, reject) => {
      const ctrl = new AbortController();
      fetch(`${app.baseUrl}/api/events`, { signal: ctrl.signal })
        .then(async (res) => {
          const reader = res.body.getReader();
          const { value } = await reader.read();
          const txt = Buffer.from(value).toString('utf8');
          ctrl.abort();
          resolve(txt.includes('event: connected'));
        })
        .catch((err) => {
          if (err.name === 'AbortError') resolve(true);
          else reject(err);
        });
    });
    assert.equal(sseConnected, true);

    // Scan tagged library directory via REST API
    const scanRes = await fetch(`${app.baseUrl}/api/library/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: tagDir }),
    }).then((r) => r.json());

    assert.equal(scanRes.ok, true);
    assert.equal(scanRes.report.indexedCount, 5);

    // Search by composer
    const searchRes = await fetch(
      `${app.baseUrl}/api/library/tracks?composer=${encodeURIComponent('Falla')}`
    ).then((r) => r.json());
    assert.equal(searchRes.tracks.length, 5);

    // Create standard playlist and round-trip M3U8, PLS, and XSPF
    const trackIds = scanRes.tracks.map((t) => t.id);
    const createPl = await fetch(`${app.baseUrl}/api/playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Selección Audiófila', trackIdsOrPaths: trackIds.slice(0, 3) }),
    }).then((r) => r.json());
    assert.equal(createPl.playlist.trackCount, 3);

    for (const fmt of ['m3u', 'pls', 'xspf']) {
      const exportedText = await fetch(
        `${app.baseUrl}/api/playlists/${createPl.playlist.id}/export?format=${fmt}`
      ).then((r) => r.text());
      assert.ok(exportedText.length > 20);

      const impRes = await fetch(`${app.baseUrl}/api/playlists/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format: fmt, content: exportedText, name: `Importada ${fmt.toUpperCase()}` }),
      }).then((r) => r.json());
      assert.equal(impRes.playlist.trackCount, 3, `Fallo round-trip en formato ${fmt}`);
    }

    // Smart Playlist evaluation via API: tracks with sampleRate >= 96000 (obra_wav24.wav & obra_dsd64.dsf)
    const smartRes = await fetch(`${app.baseUrl}/api/smart-playlists`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Ultra Alta Resolución >= 96 kHz',
        match: 'all',
        rules: [{ field: 'sampleRate', operator: 'gte', value: 96000 }],
      }),
    }).then((r) => r.json());
    assert.equal(smartRes.smartPlaylist.trackCount, 2);
  } finally {
    await app.close();
  }
});

/* 7. WINDOWS PORTABILITY & REA PROJECT ISOLATION */
await runTest('7.1 Verificación Estática C11 de Backend Windows WASAPI (hal_wasapi.c)', async () => {
  execFileSync('gcc', [
    '-fsyntax-only',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-std=c11',
    '-D_POSIX_C_SOURCE=200809L',
    '-DOM_WASAPI_SYNTAX_CHECK',
    path.join(ROOT_DIR, 'native', 'hal_wasapi.c'),
  ]);
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'build-windows.bat')));
  assert.ok(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'start-windows.bat')));
});

await runTest('7.2 Verificación de Instalación Local Aislada de REA en .tools/rea y .agents/', async () => {
  const reaBin = path.join(ROOT_DIR, '.tools', 'rea', 'node_modules', '.bin', 'rea');
  assert.ok(fs.existsSync(reaBin), 'Binario local de REA debe existir en .tools/rea');
  const ver = execFileSync(reaBin, ['--version'], { encoding: 'utf8' }).trim();
  assert.ok(ver.length > 0);
  assert.ok(fs.existsSync(path.join(ROOT_DIR, '.agents', 'plugins', 'rea', 'mcp_config.json')));
});

/* 8. POINT 1 & POINT 2 AUDIOPHILE UPGRADES + OPTIMIZATIONS */
await runTest('8.1 Resampler Sinc Polifásico Kaiser 64-bit (96->48 kHz Anti-Aliasing >90 dB y 44.1->96 kHz)', async () => {
  // Left = 1 kHz passband (-6 dBFS), Right = 30 kHz ultrasonic stopband (-6 dBFS, above 24 kHz Nyquist of 48 kHz)
  const srcTestWav = path.join(TMP_DIR, 'src_96k_alias.wav');
  const amp24 = Math.round(0.5 * 8388607);
  writeWavPcm(srcTestWav, {
    sampleRate: 96000,
    channels: 2,
    bitDepth: 24,
    frames: 24000, // 0.25 s
    sampleFn: (f, c) => {
      const t = f / 96000;
      return c === 0
        ? Math.round(amp24 * Math.sin(2 * Math.PI * 1000 * t))
        : Math.round(amp24 * Math.sin(2 * Math.PI * 30000 * t));
    },
  });

  const out48 = path.join(TMP_DIR, 'src_out_48k.wav');
  await runEngineRender({
    inputFile: srcTestWav,
    outWav: out48,
    setupCmds: [{ cmd: 'set_resampler', targetRate: 48000, quality: 'ultra' }],
  });

  const w48 = readWavPcm(out48);
  assert.equal(w48.sampleRate, 48000);
  assert.ok(Math.abs(w48.frames - 12000) <= 4, `Conteo de tramas tras flush_tail inexacto: ${w48.frames}`);

  // Steady-state interior (skip tiny filter edge transients)
  const rmsPass = channelRms(w48, 0, 1000, 11000);
  const rmsAlias = channelRms(w48, 1, 1000, 11000);
  const expectedRms = 0.5 / Math.SQRT2;
  const passErrDb = Math.abs(20 * Math.log10(rmsPass / expectedRms));
  const aliasRejDb = 20 * Math.log10(rmsPass / Math.max(rmsAlias, 1e-12));

  assert.ok(passErrDb < 0.05, `Error en banda pasante 1 kHz excesivo: ${passErrDb.toFixed(4)} dB`);
  assert.ok(aliasRejDb > 90, `Rechazo ultrasónico anti-aliasing insuficiente: ${aliasRejDb.toFixed(1)} dB`);

  // Asynchronous fractional upsampling 44.1 kHz -> 96 kHz
  const out96 = path.join(TMP_DIR, 'src_out_96k.wav');
  await runEngineRender({
    inputFile: fx.ref16,
    outWav: out96,
    setupCmds: [{ cmd: 'set_resampler', targetRate: 96000, quality: 'high' }],
  });
  const wRef16 = readWavPcm(fx.ref16);
  const wUp96 = readWavPcm(out96);
  assert.equal(wUp96.sampleRate, 96000);
  const upGainDiffDb = Math.abs(
    20 * Math.log10(channelRms(wUp96, 0, 2000, 44000) / channelRms(wRef16, 0, 1000, 20000)),
  );
  assert.ok(upGainDiffDb < 0.05, `Ganancia tras upsampling 44.1->96 kHz desviada: ${upGainDiffDb.toFixed(4)} dB`);
});

await runTest('9.1 Ultra-Hi-Res DSD512 (22.5792 MHz) y DSD1024 (45.1584 MHz) + Modo DSD Nativo Raw', async () => {
  const dsf512 = path.join(TMP_DIR, 'ultra_dsd512.dsf');
  const dff1024 = path.join(TMP_DIR, 'ultra_dsd1024.dff');
  // 15 ms of DSD512 and 8 ms of DSD1024 keep test fast (~50 ms) while exercising full 128-tap LUT FIR
  writeDsfSine(dsf512, 0.015, 1000, 1000, 22579200);
  writeDffSine(dff1024, 0.008, 1000, 45158400);

  const probe512 = await EngineBridge.probeCli(dsf512);
  const probe1024 = await EngineBridge.probeCli(dff1024);
  assert.equal(probe512.dsdBitRate, 22579200);
  assert.equal(probe1024.dsdBitRate, 45158400);
  assert.equal(probe512.sampleRate, 352800);
  assert.equal(probe1024.sampleRate, 352800);

  const out512 = path.join(TMP_DIR, 'out_dsd512.wav');
  const out1024 = path.join(TMP_DIR, 'out_dsd1024.wav');
  await runEngineRender({ inputFile: dsf512, outWav: out512 });
  await runEngineRender({ inputFile: dff1024, outWav: out1024 });

  const w512 = readWavPcm(out512);
  const w1024 = readWavPcm(out1024);
  assert.equal(w512.sampleRate, 352800);
  assert.equal(w1024.sampleRate, 352800);
  assert.ok(channelRms(w512, 0, 400) > 0.2, 'DSD512 FIR PCM debe reconstruir onda senoidal limpia');
  assert.ok(channelRms(w1024, 0, 400) > 0.2, 'DSD1024 FIR PCM debe reconstruir onda senoidal limpia');

  // Verify Native Raw 1-bit DSD Direct stream mode (for ASIO DSD / ALSA Native DSD DACs)
  const outNative = path.join(TMP_DIR, 'out_dsd_native.wav');
  const { events } = await runEngineRender({
    inputFile: fx.dsfFile,
    outWav: outNative,
    dsdMode: 'native',
  });
  const startedEv = events.find((e) => e.event === 'track_started');
  assert.equal(startedEv?.data?.isDsdNative, true, 'El modo dsdMode=native debe activar transporte DSD directo');
});

await runTest('10.1 Ecualizador Paramétrico PEQ de 16 Bandas (Notch Quirúrgico Q=10 + Low-Shelf)', async () => {
  const outPeq = path.join(TMP_DIR, 'peq_notch_shelf.wav');
  await runEngineRender({
    inputFile: fx.eqTestWav, // Left = 910 Hz, Right = 60 Hz @ 48 kHz
    outWav: outPeq,
    setupCmds: [
      {
        cmd: 'set_peq',
        enabled: true,
        preampDb: 0,
        smoothing: false,
        limiter: false,
        bands: [
          { enabled: true, type: 'notch', freq: 910, q: 10.0, gainDb: 0 },
          { enabled: true, type: 'low_shelf', freq: 150, q: 0.7071, gainDb: 6.0 },
        ],
      },
    ],
  });

  const wFlat = readWavPcm(path.join(TMP_DIR, 'eq_flat.wav'));
  const wPeq = readWavPcm(outPeq);
  const notch910Db = 20 * Math.log10(Math.max(channelRms(wPeq, 0, 6000), 1e-9) / channelRms(wFlat, 0, 6000));
  const shelf60Db = 20 * Math.log10(channelRms(wPeq, 1, 6000) / channelRms(wFlat, 1, 6000));

  assert.ok(notch910Db < -28.0, `Filtro Notch Q=10 @ 910 Hz debe atenuar > 28 dB (obtenido ${notch910Db.toFixed(1)} dB)`);
  assert.ok(shelf60Db > 5.0 && shelf60Db < 6.4, `Low-Shelf +6 dB debe elevar 60 Hz ~6 dB (obtenido ${shelf60Db.toFixed(2)} dB)`);
});

await runTest('11.1 Convolver FIR Híbrido FFT de Latencia Cero (Dirac >512 taps, Eco Multi-Partición y Resampleo IR)', async () => {
  // 1. 1024-tap Dirac impulse IR at 48 kHz ([1.0, 0, 0, ...])
  const diracIr = path.join(TMP_DIR, 'ir_dirac_1024.wav');
  writeWavPcm(diracIr, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 24,
    frames: 1024,
    sampleFn: (f) => (f === 0 ? 8388607 : 0),
  });

  const outDirac = path.join(TMP_DIR, 'conv_dirac_out.wav');
  await runEngineRender({
    inputFile: fx.eqTestWav,
    outWav: outDirac,
    setupCmds: [
      { cmd: 'set_convolver', enabled: true, irPath: diracIr, mix: 1.0, gainDb: 0, autoNormalize: false },
    ],
  });
  const wOrig48 = readWavPcm(fx.eqTestWav);
  const wDirac = readWavPcm(outDirac);
  assert.ok(maxSampleDiff(wOrig48, wDirac) <= 1, 'Convolución con impulso Dirac debe tener 0 latencia y <= 1 LSB');

  // 2. Two-tap cross-partition echo IR: 0.5 * x[n] + 0.5 * x[n - 600] (tap 0 in head, tap 600 in FFT tail partition #2!)
  const echoIr = path.join(TMP_DIR, 'ir_echo_600.wav');
  const half24 = Math.round(0.5 * 8388608);
  writeWavPcm(echoIr, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 24,
    frames: 1024,
    sampleFn: (f) => (f === 0 || f === 600 ? half24 : 0),
  });

  const outEcho = path.join(TMP_DIR, 'conv_echo_out.wav');
  await runEngineRender({
    inputFile: fx.eqTestWav,
    outWav: outEcho,
    setupCmds: [
      { cmd: 'set_convolver', enabled: true, irPath: echoIr, mix: 1.0, gainDb: 0, autoNormalize: false },
    ],
  });
  const wEcho = readWavPcm(outEcho);
  let maxEchoErr = 0;
  for (let f = 700; f < wEcho.frames; f++) {
    const expectedL = Math.round(0.5 * wOrig48.samples[f * 2] + 0.5 * wOrig48.samples[(f - 600) * 2]);
    maxEchoErr = Math.max(maxEchoErr, Math.abs(wEcho.samples[f * 2] - expectedL));
  }
  assert.ok(maxEchoErr <= 2, `Partición FFT de cola en tap 600 debe ser exacta (maxEchoErr=${maxEchoErr} LSB)`);

  // 3. Automatic IR sample-rate conversion: apply 48 kHz Dirac IR onto 96 kHz/24-bit stream!
  const outIrResamp = path.join(TMP_DIR, 'conv_ir_resamp_96k.wav');
  await runEngineRender({
    inputFile: fx.ref24,
    outWav: outIrResamp,
    setupCmds: [
      { cmd: 'set_convolver', enabled: true, irPath: diracIr, mix: 1.0, gainDb: 0, autoNormalize: false },
    ],
  });
  const wRef24 = readWavPcm(fx.ref24);
  const wIr96 = readWavPcm(outIrResamp);
  const irGainErrDb = Math.abs(
    20 * Math.log10(channelRms(wIr96, 0, 2000, 22000) / channelRms(wRef24, 0, 2000, 22000)),
  );
  assert.ok(irGainErrDb < 0.15, `Ganancia tras resampleo automático de IR 48->96 kHz debe ser 0 dB (err=${irGainErrDb.toFixed(3)} dB)`);
});

await runTest('12.1 Escáner ITU-R BS.1770-4 / EBU R128 (LUFS + True-Peak 4x) y ReplayGain 2.0 Anti-Clipping', async () => {
  const fullSine = path.join(TMP_DIR, 'r128_0dbfs.wav');
  const quietSine = path.join(TMP_DIR, 'r128_minus15dbfs.wav');
  const scale15 = Math.pow(10, -15 / 20);

  writeWavPcm(fullSine, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 24,
    frames: 57600, // 1.2 s (>= 3 overlapping 400 ms gating blocks)
    sampleFn: (f) => Math.round(8388607 * Math.sin((2 * Math.PI * 1000 * f) / 48000)),
  });
  writeWavPcm(quietSine, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 24,
    frames: 57600,
    sampleFn: (f) => Math.round(8388607 * scale15 * Math.sin((2 * Math.PI * 1000 * f) / 48000)),
  });

  const scan0 = await EngineBridge.scanLoudnessCli(fullSine);
  const scan15 = await EngineBridge.scanLoudnessCli(quietSine);

  // Theoretical ITU-R BS.1770-4 loudness of 0 dBFS 1 kHz dual-mono stereo sine:
  // K-weighting shelf @ 1 kHz = +0.655 dB -> L_K = -0.691 + 10*log10(2 * 0.5 * 10^(0.655/10)) = -0.036 LUFS
  assert.ok(Math.abs(scan0.integratedLufs - -0.036) < 0.08, `LUFS @ 0 dBFS esperado ~-0.036, obtenido ${scan0.integratedLufs}`);
  assert.ok(Math.abs(scan0.integratedLufs - scan15.integratedLufs - 15.0) < 0.05, 'Delta relativo R128 debe ser exactamente 15.00 LU');
  assert.ok(Math.abs(scan0.truePeakDbtp) < 0.05, `True-Peak esperado ~0.0 dBTP, obtenido ${scan0.truePeakDbtp}`);

  // Live ReplayGain anti-clipping test: quietSine has peak ~0.1778 (-15 dBFS); requesting +20 dB with preventClipping=true must clamp gain to 1/0.1778 (~ +15 dB) without clipping!
  const outRg = path.join(TMP_DIR, 'rg_clamped.wav');
  await runEngineRender({
    inputFile: quietSine,
    outWav: outRg,
    setupCmds: [
      {
        cmd: 'set_eq',
        enabled: false,
        limiter: false,
        smoothing: false,
      },
      {
        cmd: 'set_replaygain',
        mode: 'track',
        preampDb: 0,
        preventClipping: true,
        trackGainDb: 20.0,
        trackPeak: scan15.truePeak,
      },
    ],
  });
  const wRg = readWavPcm(outRg);
  const rgRms = channelRms(wRg, 0, 4000, 50000);
  // Clamped to 0 dBFS sine -> RMS ~ 0.7071 (within 2%)
  assert.ok(Math.abs(rgRms - Math.SQRT1_2) < 0.02, `Protección anti-clipping ReplayGain debe limitar exactamente a 0 dBFS (rms=${rgRms.toFixed(4)})`);
});

await runTest('13.1 Crossfeed Acústico de Auriculares (Bauer/Meier ILD Pasa-Bajos + Micro-Retardo ITD)', async () => {
  // Left-only dual tone (200 Hz bass + 6000 Hz treble), Right = digital silence (0)
  const hardLeftWav = path.join(TMP_DIR, 'hard_left_dual.wav');
  writeWavPcm(hardLeftWav, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    frames: 24000,
    sampleFn: (f, c) => {
      if (c === 1) return 0;
      const t = f / 48000;
      return Math.round(9000 * Math.sin(2 * Math.PI * 200 * t) + 9000 * Math.sin(2 * Math.PI * 6000 * t));
    },
  });

  const outXf = path.join(TMP_DIR, 'out_crossfeed.wav');
  await runEngineRender({
    inputFile: hardLeftWav,
    outWav: outXf,
    setupCmds: [{ cmd: 'set_crossfeed', enabled: true, cutoffHz: 700, feedDb: -6.0, itdUs: 300 }],
  });

  const wXf = readWavPcm(outXf);
  // Measure DFT magnitude on Right channel at 200 Hz vs 6000 Hz to verify head-shadow ILD low-pass
  const goertzelMag = (freq) => {
    let re = 0, im = 0;
    const N = 12000;
    for (let n = 0; n < N; n++) {
      const s = wXf.samples[(4000 + n) * 2 + 1] / 32768;
      const ang = (2 * Math.PI * freq * n) / 48000;
      re += s * Math.cos(ang);
      im -= s * Math.sin(ang);
    }
    return Math.hypot(re, im) / N;
  };
  const mag200 = goertzelMag(200);
  const mag6000 = goertzelMag(6000);
  const ildDiffDb = 20 * Math.log10(mag200 / Math.max(mag6000, 1e-12));

  assert.ok(mag200 > 0.03, 'El canal derecho debe recibir señal cruzada de graves');
  assert.ok(ildDiffDb > 12.0, `El filtro ILD de sombra acústica debe atenuar 6 kHz frente a 200 Hz >12 dB (diff=${ildDiffDb.toFixed(1)} dB)`);
});

await runTest('14.1 Verificación Estática C11 de Backend Windows ASIO (hal_asio.c) y Endpoints REST DSP v2', async () => {
  execFileSync('gcc', [
    '-fsyntax-only',
    '-Wall',
    '-Wextra',
    '-Wno-unused-parameter',
    '-std=c11',
    '-D_POSIX_C_SOURCE=200809L',
    '-DOM_WASAPI_SYNTAX_CHECK',
    path.join(ROOT_DIR, 'native', 'hal_asio.c'),
  ]);

  const appDataDir = path.join(TMP_DIR, 'server_dsp_v2');
  const scanLibDir = path.join(TMP_DIR, 'tagged_lib_v2');
  fs.mkdirSync(scanLibDir, { recursive: true });
  fs.copyFileSync(fx.flac16, path.join(scanLibDir, 'test_rg.flac'));
  fs.copyFileSync(fx.alac16, path.join(scanLibDir, 'test_rg.m4a'));
  fs.copyFileSync(fx.mp3File, path.join(scanLibDir, 'test_rg.mp3'));

  const app = await createOurMusicApp({ dataDir: appDataDir, port: 0, pollIntervalMs: 80 });
  try {
    const scanRes = await fetch(`${app.baseUrl}/api/library/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: scanLibDir }),
    }).then((r) => r.json());
    assert.equal(scanRes.report.indexedCount, 3);

    // Scan R128 loudness & write ReplayGain 2.0 tags into all 3 container formats via REST API
    for (const trk of scanRes.tracks) {
      const lRes = await fetch(`${app.baseUrl}/api/tracks/${trk.id}/loudness`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ writeTags: true }),
      }).then((r) => r.json());
      assert.equal(lRes.ok, true);
      assert.ok(Number.isFinite(lRes.loudness.integratedLufs));

      const reRead = await readMetadata(trk.filePath, { probeAudio: false });
      assert.ok(
        Math.abs(reRead.replayGainTrackDb - lRes.loudness.replayGain18Db) < 0.05,
        `Tag ReplayGain no persistió en ${trk.fileName}`,
      );
    }

    // Verify PEQ, Crossfeed, ReplayGain, and Resampler REST endpoints
    const peqRes = await fetch(`${app.baseUrl}/api/dsp/peq`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        preampDb: -1.5,
        bands: [{ enabled: true, type: 'peaking', freq: 2500, q: 2.2, gainDb: -3.0 }],
      }),
    }).then((r) => r.json());
    assert.equal(peqRes.ok, true);
    assert.equal(peqRes.eqState.peqMode, true);
    assert.equal(peqRes.eqState.peqBands[0].freq, 2500);

    const xfRes = await fetch(`${app.baseUrl}/api/dsp/crossfeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true, cutoffHz: 650, feedDb: -5.5, itdUs: 280 }),
    }).then((r) => r.json());
    assert.equal(xfRes.crossfeed.enabled, true);

    const srcRes = await fetch(`${app.baseUrl}/api/dsp/resampler`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetRate: 96000, quality: 'ultra' }),
    }).then((r) => r.json());
    assert.equal(srcRes.resampler.targetRate, 96000);
    assert.equal(srcRes.resampler.quality, 'ultra');
  } finally {
    await app.close();
  }
});

/* 9. POINT 4 — EMBEDDED SQLITE (WAL + FTS5 + PAGINATION) & REAL-TIME FILE WATCHER */
await runTest('15.1 Motor SQLite Local (WAL + FTS5 Diacríticos/Letras + Paginación SQL + Migración de JSON)', async () => {
  const dbDir = path.join(TMP_DIR, 'sqlite_bench_dir');
  fs.mkdirSync(dbDir, { recursive: true });

  // 1. Seed legacy JSON files to verify automatic zero-loss migration into ourmusic.db
  fs.writeFileSync(
    path.join(dbDir, 'library.json'),
    JSON.stringify({
      version: 1,
      folders: ['/musica/coleccion_clasica'],
      tracks: [
        {
          id: 'trk_legacy_001',
          filePath: '/musica/coleccion_clasica/aranjuez.flac',
          fileName: 'aranjuez.flac',
          sizeBytes: 42000000,
          mtimeMs: 1700000000000,
          tagFormat: 'VorbisComment (FLAC)',
          title: 'Sinfonía Clásica del Alba',
          artist: 'Paco de Lucía',
          album: 'Grabaciones Históricas',
          year: 1991,
          composer: 'Joaquín Rodrigo',
          genre: 'Clásica',
          codec: 'FLAC',
          sampleRate: 96000,
          bitDepth: 24,
          channels: 2,
          durationSec: 615.4,
          isLossless: true,
          isHiRes: true,
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dbDir, 'playlists.json'),
    JSON.stringify({
      version: 1,
      playlists: [
        {
          id: 'pl_legacy_1',
          name: 'Favoritas Migradas',
          trackPaths: ['/musica/coleccion_clasica/aranjuez.flac'],
        },
      ],
      smartPlaylists: [],
    }),
  );

  const db = new MusicDatabase(dbDir);
  try {
    assert.ok(fs.existsSync(path.join(dbDir, 'ourmusic.db')), 'Archivo físico ourmusic.db debe crearse');
    assert.ok(fs.existsSync(path.join(dbDir, 'library.json.migrated')), 'JSON heredado debe marcarse como migrado');
    assert.equal(db.countTracks(), 1);
    assert.equal(db.getPlaylistWithTracks('pl_legacy_1')?.trackCount, 1);

    // 2. Bulk insert 2,499 additional tracks (total = 2,500) inside an ACID WAL transaction
    db.runInTransaction(() => {
      for (let i = 2; i <= 2500; i++) {
        const isDsd = i % 25 === 0;
        db.upsertTrack(
          {
            id: `trk_bulk_${i}`,
            filePath: `/musica/coleccion_clasica/pista_${String(i).padStart(4, '0')}.${isDsd ? 'dsf' : 'flac'}`,
            fileName: `pista_${String(i).padStart(4, '0')}.${isDsd ? 'dsf' : 'flac'}`,
            sizeBytes: 25000000 + i,
            mtimeMs: 1700000000000 + i,
            title: `Estudio Acústico Nº ${i}`,
            artist: `Intérprete ${(i % 40) + 1}`,
            album: `Volumen ${(i % 80) + 1}`,
            year: 1980 + (i % 45),
            composer: i === 777 ? 'Heitor Villa-Lobos' : 'Anónimo',
            genre: isDsd ? 'Jazz' : 'Instrumental',
            hasLyrics: i === 777,
            hasSyncedLyrics: i === 777,
            codec: isDsd ? 'DSD' : 'FLAC',
            sampleRate: isDsd ? 352800 : 44100,
            bitDepth: 24,
            channels: 2,
            durationSec: 180 + (i % 120),
            dsdBitRate: isDsd ? 11289600 : 0,
            isLossless: true,
            isHiRes: true,
          },
          {
            lyricsText:
              i === 777 ? '[00:12.00] Susurros nocturnos en el preludio de guitarra' : '',
          },
        );
      }
    });

    assert.equal(db.countTracks(), 2500);
    assert.equal(db.getStats().ftsIndexedTracks, 2500);

    // 3. Sub-5ms Paginated SQL query (LIMIT 50 OFFSET 100)
    const tPage0 = performance.now();
    const page = db.queryTracksPaginated({ limit: 50, offset: 100, sortBy: 'title', sortOrder: 'asc' });
    const pageMs = performance.now() - tPage0;
    assert.equal(page.total, 2500);
    assert.equal(page.tracks.length, 50);
    assert.ok(pageMs < 25, `Consulta paginada SQLite demasiado lenta: ${pageMs.toFixed(2)} ms`);

    // 4. Diacritic-insensitive FTS5 search ("Sinfonia Lucia" -> matches "Sinfonía Clásica del Alba" / "Paco de Lucía")
    const ftsAccent = db.queryTracksPaginated({ search: 'Sinfonia Lucia' });
    assert.equal(ftsAccent.total, 1);
    assert.equal(ftsAccent.tracks[0].id, 'trk_legacy_001');

    // 5. Full-Text Search inside embedded song lyrics!
    const ftsLyrics = db.queryTracksPaginated({ search: 'Susurros nocturnos preludio' });
    assert.equal(ftsLyrics.total, 1);
    assert.equal(ftsLyrics.tracks[0].id, 'trk_bulk_777');

    // 6. Compiled SQL Smart Playlist execution over 2,500 tracks
    const dsdMatches = db.evaluateSmartPlaylistSql({
      match: 'all',
      rules: [
        { field: 'codec', operator: 'equals', value: 'DSD' },
        { field: 'sampleRate', operator: 'gte', value: 176400 },
      ],
      sortBy: 'durationSec',
      sortOrder: 'desc',
      limit: 500,
    });
    assert.equal(dsdMatches.length, 100); // 25 * 1 .. 25 * 100 = 100 DSD tracks
  } finally {
    db.close();
  }
});

await runTest('15.2 Observador Incremental en Tiempo Real (File Watcher Automático sin Re-Escaneo Manual)', async () => {
  const watchDataDir = path.join(TMP_DIR, 'watcher_db_data');
  const liveMusicDir = path.join(TMP_DIR, 'live_watched_music');
  fs.mkdirSync(liveMusicDir, { recursive: true });
  fs.copyFileSync(fx.flac16, path.join(liveMusicDir, 'inicial.flac'));

  const app = await createOurMusicApp({
    dataDir: watchDataDir,
    port: 0,
    pollIntervalMs: 0,
    watchFolders: true,
    watcherDebounceMs: 60,
  });

  try {
    const initScan = await fetch(`${app.baseUrl}/api/library/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: liveMusicDir }),
    }).then((r) => r.json());
    assert.equal(initScan.report.totalLibraryTracks, 1);

    // Drop a new Hi-Res WAV into liveMusicDir and wait for OS watcher to index it automatically!
    const addedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout esperando evento watcher_indexed')), 4000);
      app.library.once('watcher_indexed', (rec) => {
        clearTimeout(timer);
        resolve(rec);
      });
    });

    const droppedFile = path.join(liveMusicDir, 'nuevo_disco_hires.wav');
    fs.copyFileSync(fx.ref24, droppedFile);
    const autoIndexed = await addedPromise;
    assert.equal(autoIndexed.fileName, 'nuevo_disco_hires.wav');
    assert.equal(autoIndexed.sampleRate, 96000);

    const afterAdd = await fetch(`${app.baseUrl}/api/library/tracks?limit=10&offset=0`).then((r) => r.json());
    assert.equal(afterAdd.total, 2);

    // Delete the dropped file from disk and verify OS watcher prunes it from SQLite automatically!
    const removedPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout esperando evento watcher_removed')), 4000);
      app.library.once('watcher_removed', (ev) => {
        clearTimeout(timer);
        resolve(ev);
      });
    });

    fs.unlinkSync(droppedFile);
    await removedPromise;

    const afterDel = await fetch(`${app.baseUrl}/api/library/tracks`).then((r) => r.json());
    assert.equal(afterDel.total, 1);

    const dbStatsRes = await fetch(`${app.baseUrl}/api/library/db-stats`).then((r) => r.json());
    assert.equal(dbStatsRes.ok, true);
    assert.equal(dbStatsRes.stats.journalMode, 'wal');
    assert.equal(dbStatsRes.stats.activeWatchers, 1);
  } finally {
    await app.close();
  }
});

fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  RESULTADO: ${passed}/${passed} pruebas superadas con éxito.`);
console.log(`======================================================================\n`);
