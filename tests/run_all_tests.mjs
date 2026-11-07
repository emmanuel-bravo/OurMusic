import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateAllFixtures, readWavPcm, writeWavPcm } from './generate_fixtures.mjs';
import { PresetManager } from '../src/dsp/presetManager.mjs';
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
function runEngineRender({ inputFile, nextFile = '', outWav, setupCmds = [], midCmds = [], dop = false }) {
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
          send({ cmd: 'set_device', device: `wav:${outWav}`, bitPerfect: true, dop });
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

fs.rmSync(TMP_DIR, { recursive: true, force: true });

console.log(`\n======================================================================`);
console.log(`  RESULTADO: ${passed}/${passed} pruebas superadas con éxito.`);
console.log(`======================================================================\n`);
