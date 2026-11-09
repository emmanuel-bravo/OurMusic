/*
 * OurMusic — Suite E2E del Frontend (clics, arrastres y teclado reales)
 *
 * Levanta el servidor con una biblioteca de prueba aislada (datos temporales,
 * salida de audio "null" para no sonar por los altavoces), abre la UI en un
 * navegador Chromium headless (Opera / Chrome / Chromium) mediante el
 * DevTools Protocol y ejecuta interacciones reales de ratón y teclado.
 * Cada acción se verifica contra el estado real del backend (motor C11 / API).
 *
 * Uso:  node tests/ui_e2e.mjs            (todas las pruebas)
 *       node tests/ui_e2e.mjs dsp        (solo pruebas cuyo nombre contenga "dsp")
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOurMusicApp } from '../src/server.mjs';
import { writeWavPcm } from './generate_fixtures.mjs';
import { writeMetadata } from '../src/tags/tagParser.mjs';

const FILTER = (process.argv[2] || '').toLowerCase();
const HUMAN_CLICK_MS = 80; // tiempo entre mousedown y mouseup (como un clic humano)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* 1. Biblioteca de prueba aislada                                     */
/* ------------------------------------------------------------------ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'om-ui-e2e-'));
const MUSIC_DIR = path.join(TMP, 'music');
const DATA_DIR = path.join(TMP, 'data');
const BROWSER_DIR = path.join(TMP, 'browser');

const ALBUMS = [
  { album: 'Alpha Sessions', artist: 'Aurora Test', freqs: [220, 330, 440] },
  { album: 'Beta Horizons', artist: 'Boreal Ensemble', freqs: [523, 659, 784] },
];

async function buildFixtures() {
  for (const alb of ALBUMS) {
    const dir = path.join(MUSIC_DIR, alb.album);
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < alb.freqs.length; i++) {
      const f = path.join(dir, `0${i + 1} - Track ${i + 1}.wav`);
      const freq = alb.freqs[i];
      writeWavPcm(f, {
        sampleRate: 44100,
        channels: 2,
        bitDepth: 16,
        frames: 44100 * 40,
        sampleFn: (n) => Math.sin((2 * Math.PI * freq * n) / 44100) * 0.3,
      });
      await writeMetadata(f, {
        title: `${alb.album.split(' ')[0]} Track ${i + 1}`,
        artist: alb.artist,
        album: alb.album,
        trackNumber: String(i + 1),
        year: '2024',
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* 2. Navegador headless + DevTools Protocol                           */
/* ------------------------------------------------------------------ */
function findBrowser() {
  const c = [
    process.env.OM_E2E_BROWSER,
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/opera',
    '/usr/bin/brave-browser',
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p)) || null;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(fn) {
    this.listeners.push(fn);
  }
}

async function launchBrowser() {
  const bin = findBrowser();
  if (!bin) throw new Error('No se encontró un navegador Chromium (Chrome/Chromium/Opera) para las pruebas E2E');
  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-extensions',
      '--mute-audio',
      `--user-data-dir=${BROWSER_DIR}`,
      '--remote-debugging-port=0',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );
  const portFile = path.join(BROWSER_DIR, 'DevToolsActivePort');
  const t0 = Date.now();
  while (!fs.existsSync(portFile)) {
    if (Date.now() - t0 > 20000) throw new Error('El navegador headless no abrió el puerto DevTools');
    await sleep(100);
  }
  await sleep(150);
  const [port, wsPath] = fs.readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  return { proc, cdp: new Cdp(ws), bin };
}

/* ------------------------------------------------------------------ */
/* 3. Página bajo prueba                                               */
/* ------------------------------------------------------------------ */
class Page {
  constructor(cdp, sessionId, baseUrl) {
    this.cdp = cdp;
    this.sid = sessionId;
    this.baseUrl = baseUrl;
    this.errors = [];
    cdp.on((msg) => {
      if (msg.sessionId !== this.sid) return;
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(`Excepción JS: ${d.exception?.description || d.text}`);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const txt = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.errors.push(`console.error: ${txt}`);
      }
    });
  }
  send(m, p) {
    return this.cdp.send(m, p, this.sid);
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`Error evaluando en página: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }
  async waitFor(expression, { timeout = 5000, msg = expression } = {}) {
    const t0 = Date.now();
    let last;
    while (Date.now() - t0 < timeout) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch {
        // reintentar
      }
      await sleep(60);
    }
    throw new Error(`Tiempo agotado esperando: ${msg}`);
  }
  async locate(sel, { index = 0, fx = 0.5, fy = 0.5 } = {}) {
    const r = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(sel)})[${index}];
      if (!el) return { err: 'no existe el elemento' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) return { err: 'el elemento no es visible (tamaño 0)' };
      const x = b.left + b.width * ${fx}, y = b.top + b.height * ${fy};
      const hit = document.elementFromPoint(x, y);
      const ok = !!hit && (hit === el || el.contains(hit));
      const desc = hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') + '.' + String(hit.className?.baseVal ?? hit.className ?? '').trim().split(/\\s+/).join('.') : 'nada';
      return { x, y, ok, hit: desc };
    })()`);
    if (r.err) throw new Error(`${sel}: ${r.err}`);
    if (!r.ok) throw new Error(`${sel}: el clic quedaría bloqueado por otro elemento encima (${r.hit})`);
    return r;
  }
  async mouse(type, x, y, button = 'left', clickCount = 1) {
    await this.send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button,
      buttons: type === 'mouseReleased' ? 0 : button === 'right' ? 2 : 1,
      clickCount,
    });
  }
  async click(sel, opts = {}) {
    const { x, y } = await this.locate(sel, opts);
    const button = opts.button || 'left';
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.mouse('mousePressed', x, y, button);
    await sleep(HUMAN_CLICK_MS);
    await this.mouse('mouseReleased', x, y, button);
    await sleep(60);
  }
  async drag(sel, dx, dy, opts = {}) {
    const { x, y } = await this.locate(sel, opts);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.mouse('mousePressed', x, y);
    const steps = 10;
    for (let i = 1; i <= steps; i++) {
      await this.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x + (dx * i) / steps,
        y: y + (dy * i) / steps,
        button: 'left',
        buttons: 1,
      });
      await sleep(30);
    }
    await this.mouse('mouseReleased', x + dx, y + dy);
    await sleep(80);
  }
  async type(text) {
    await this.send('Input.insertText', { text });
  }
  async key(key, { code = key, keyCode = 0, modifiers = 0 } = {}) {
    const base = { key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: key.length === 1 ? key : undefined });
    await sleep(30);
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(60);
  }
  text(sel) {
    return this.eval(`(document.querySelector(${JSON.stringify(sel)})?.textContent || '').trim()`);
  }
  count(sel) {
    return this.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
  }
}

/* ------------------------------------------------------------------ */
/* 4. Helpers del backend                                              */
/* ------------------------------------------------------------------ */
let BASE = '';
async function api(p) {
  const r = await fetch(BASE + p);
  return r.json();
}
async function engineStatus() {
  return (await api('/api/player/status')).status;
}
async function waitBackend(fn, { timeout = 5000, msg = 'condición del backend' } = {}) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(80);
  }
  throw new Error(`Tiempo agotado esperando ${msg}`);
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/* ------------------------------------------------------------------ */
/* 5. Pruebas                                                          */
/* ------------------------------------------------------------------ */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('arranque: la UI renderiza sidebar, topbar, barra de reproducción y álbumes', async (pg) => {
  await pg.waitFor(`document.querySelectorAll('.om-AlbumCard').length === ${ALBUMS.length}`, {
    msg: `${ALBUMS.length} tarjetas de álbum`,
  });
  assert((await pg.text('#nav-count-tracks')) === '6', 'el contador de pistas del sidebar debería ser 6');
  assert((await pg.text('#crumb-current')) === 'Álbumes', 'la miga de pan debería decir Álbumes');
  assert((await pg.text('#np-title')).length > 0, 'la barra de reproducción no tiene texto');
  assert((await pg.count('.om-Scrim')) === 0, 'hay un velo (scrim) de búsqueda bloqueando la interfaz al arrancar');
});

test('álbum: abrir detalle, reproducir pista con clic y volver', async (pg) => {
  await pg.click('[data-nav="albums"]');
  await pg.waitFor(`document.querySelectorAll('.om-AlbumCard').length > 0`);
  await pg.click('.om-AlbumCard .om-AlbumCard__title', { index: 0 });
  await pg.waitFor(`document.querySelectorAll('#hero-tracks-tbody tr[data-track-id]').length === 3`, {
    msg: '3 pistas en el detalle del álbum',
  });
  await pg.click('#hero-tracks-tbody tr[data-track-id]', { index: 1 });
  const st = await waitBackend(async () => {
    const s = await engineStatus();
    return s.state === 'playing' && /Track 2\.wav$/.test(s.currentPath || '') ? s : null;
  }, { msg: 'que el motor reproduzca la pista 2' });
  assert(st, 'el motor no está reproduciendo');
  await pg.waitFor(`document.querySelector('#np-title').textContent.includes('Track 2')`, {
    msg: 'el título en la barra de reproducción',
  });
  await pg.click('#hero-back-btn');
  await pg.waitFor(`document.querySelectorAll('.om-AlbumCard').length === ${ALBUMS.length}`);
});

test('transporte: play/pausa responde a 6 clics seguidos mientras llega telemetría', async (pg) => {
  let s = await engineStatus();
  if (s.state !== 'playing') {
    await pg.click('#np-play-btn');
    await waitBackend(async () => (await engineStatus()).state === 'playing', { msg: 'playing' });
  }
  for (let i = 0; i < 6; i++) {
    const want = i % 2 === 0 ? 'paused' : 'playing';
    await pg.click('#np-play-btn');
    await waitBackend(async () => (await engineStatus()).state === want, {
      timeout: 3000,
      msg: `que el clic #${i + 1} en play/pausa cambie el estado a ${want}`,
    });
    await sleep(250);
  }
});

test('transporte: siguiente y anterior cambian de pista', async (pg) => {
  await pg.click('[data-nav="albums"]');
  await pg.waitFor(`document.querySelectorAll('.om-AlbumCard').length > 0`);
  await pg.click('.om-AlbumCard .om-AlbumCard__play', { index: 0 });
  await waitBackend(async () => {
    const q = await api('/api/queue');
    return q.queueState.queue.length === 3 && (await engineStatus()).state === 'playing';
  }, { msg: 'que el botón play del álbum encole 3 pistas y reproduzca' });
  const p0 = (await engineStatus()).currentPath;
  await pg.click('#np-next-btn');
  const p1 = await waitBackend(async () => {
    const s = await engineStatus();
    return s.currentPath !== p0 ? s.currentPath : null;
  }, { msg: 'cambio de pista con Siguiente' });
  await pg.click('#np-prev-btn');
  await waitBackend(async () => (await engineStatus()).currentPath === p0, { msg: 'volver con Anterior' });
  assert(p1, 'siguiente no cambió la pista');
});

test('barra de reproducción: el tiempo avanza, seek al 50% y volumen al 25%', async (pg) => {
  const s0 = await engineStatus();
  if (s0.state !== 'playing') await pg.click('#np-play-btn');
  const t1 = await pg.text('#np-time-cur');
  await sleep(1300);
  const t2 = await pg.text('#np-time-cur');
  assert(t1 !== t2, `el contador de tiempo no avanza (${t1} → ${t2})`);

  await pg.click('#np-seek-bar', { fx: 0.5 });
  await waitBackend(async () => {
    const s = await engineStatus();
    return s.durationSec > 0 && Math.abs(s.positionSec - s.durationSec / 2) < 4;
  }, { msg: 'que el seek lleve la posición a la mitad' });

  await pg.click('#np-vol-track', { fx: 0.25 });
  await waitBackend(async () => {
    const s = await engineStatus();
    return Math.abs((s.volume ?? -1) - 0.25) < 0.08;
  }, { msg: 'volumen ≈ 0.25 en el motor' });
});

test('modos: aleatorio y repetir se activan desde los botones', async (pg) => {
  await pg.click('#np-shuffle-btn');
  await waitBackend(async () => (await api('/api/queue')).queueState.shuffle === true, { msg: 'shuffle=true' });
  await pg.click('#np-repeat-btn');
  await waitBackend(async () => (await api('/api/queue')).queueState.repeatMode === 'all', { msg: 'repeat=all' });
  await pg.click('#np-shuffle-btn');
  await waitBackend(async () => (await api('/api/queue')).queueState.shuffle === false, { msg: 'shuffle=false' });
});

test('pistas: tabla, filtros Hi-Res/Todas y menú contextual "añadir a la cola"', async (pg) => {
  await pg.click('[data-nav="tracks"]');
  await pg.waitFor(`document.querySelectorAll('#tracks-table-body tr[data-track-id]').length === 6`, {
    msg: '6 filas en la tabla de pistas',
  });
  await pg.click('.om-FilterPills [data-filter="hires"]');
  await pg.waitFor(`document.querySelectorAll('#tracks-table-body tr[data-track-id]').length === 0`, {
    msg: 'filtro Hi-Res sin resultados (fixtures 16-bit/44.1k)',
  });
  await pg.click('.om-FilterPills [data-filter="all"]');
  await pg.waitFor(`document.querySelectorAll('#tracks-table-body tr[data-track-id]').length === 6`);

  const before = (await api('/api/queue')).queueState.queue.length;
  await pg.click('#tracks-table-body tr[data-track-id]', { index: 4, button: 'right' });
  await pg.waitFor(`!!document.querySelector('.om-ContextMenu')`, { msg: 'menú contextual visible' });
  await pg.click('#ctx-add-queue');
  await waitBackend(async () => (await api('/api/queue')).queueState.queue.length === before + 1, {
    msg: 'que la pista se añada a la cola',
  });
  assert((await pg.count('.om-ContextMenu')) === 0, 'el menú contextual no se cerró');
});

test('búsqueda: escribir, reproducir resultado y que la interfaz siga clicable', async (pg) => {
  await pg.click('#global-search-input');
  await pg.type('Beta');
  await pg.waitFor(`document.querySelectorAll('.om-SearchDropdown [data-search-track-id]').length > 0`, {
    msg: 'resultados de búsqueda',
  });
  await pg.click('.om-SearchDropdown [data-search-track-id]', { index: 0 });
  await waitBackend(async () => /Beta Horizons/.test((await engineStatus()).currentPath || ''), {
    msg: 'que se reproduzca un resultado de "Beta"',
  });
  await pg.waitFor(`document.querySelectorAll('.om-Scrim').length === 0`, { msg: 'que se cierre el velo de búsqueda' });
  await pg.click('[data-nav="albums"]');
  await pg.waitFor(`document.querySelectorAll('.om-AlbumCard').length === ${ALBUMS.length}`);
  assert((await pg.eval(`document.getElementById('global-search-input').value`)) === '', 'la caja de búsqueda no se limpió');
});

test('cola: abrir, reproducir un elemento y cerrar (3 veces) mientras suena', async (pg) => {
  for (let round = 0; round < 3; round++) {
    await pg.click('#toggle-queue');
    await pg.waitFor(`!!document.querySelector('.om-Drawer[aria-label="Cola de reproducción"]')`, {
      msg: `drawer de cola abierto (vuelta ${round + 1})`,
    });
    await sleep(700); // dejar que llegue telemetría mientras el panel está abierto
    if (round === 0 && (await pg.count('.queue-item-click')) > 0) {
      const p0 = (await engineStatus()).currentPath;
      await pg.click('.queue-item-click', { index: 0 });
      await waitBackend(async () => (await engineStatus()).currentPath !== p0, {
        msg: 'que el clic en un elemento de la cola cambie la pista',
      });
    }
    await pg.click('#queue-close-btn');
    await pg.waitFor(`!document.querySelector('.om-Drawer[aria-label="Cola de reproducción"]')`, {
      msg: `drawer de cola cerrado (vuelta ${round + 1})`,
    });
  }
});

test('dsp: el ecualizador muestra 10 bandas y arrastrar un fader cambia la ganancia en el motor', async (pg) => {
  await pg.click('#toggle-dsp');
  await pg.waitFor(`document.querySelectorAll('.fader-track').length === 11`, {
    msg: '11 faders (preamp + 10 bandas)',
  });
  await pg.drag('.fader-track[data-index="5"]', 0, -45);
  await waitBackend(async () => {
    const eq = (await api('/api/eq')).eqState;
    return eq.numBands === 10 && eq.gains.length === 10 && eq.gains[5] > 2 && eq.enabled === true;
  }, { msg: 'que la banda 1k quede con ganancia > +2 dB, 10 bandas y EQ activo' });
  const label = Number(await pg.text('#gain-label-5'));
  assert(label > 2, `la etiqueta del fader debería ser > 2 dB (es ${label})`);
  assert((await pg.count('.fader-track')) === 11, 'los faders desaparecieron tras arrastrar');
});

test('dsp: preset Rock, bypass, suavizado y pestaña avanzada (crossfeed)', async (pg) => {
  if ((await pg.count('.fader-track')) === 0) await pg.click('#toggle-dsp');
  await pg.waitFor(`!!document.querySelector('#eq-preset-select')`);
  await pg.eval(`(() => { const s = document.querySelector('#eq-preset-select'); s.value = 'rock'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitBackend(async () => (await api('/api/eq')).eqState.gains[0] === 5, { msg: 'preset Rock aplicado (banda 0 = +5 dB)' });
  await pg.waitFor(`document.querySelector('#gain-label-0')?.textContent === '+5.0'`, { msg: 'fader 31 Hz en +5.0' });

  const en0 = (await api('/api/eq')).eqState.enabled;
  await pg.click('#eq-bypass-wrap');
  await waitBackend(async () => (await api('/api/eq')).eqState.enabled === !en0, { msg: 'bypass alternado' });
  await pg.click('#eq-bypass-wrap');
  await waitBackend(async () => (await api('/api/eq')).eqState.enabled === en0, { msg: 'bypass restaurado' });

  const sm0 = (await api('/api/eq')).eqState.smoothingEnabled;
  await pg.click('#eq-smoothing-row');
  await waitBackend(async () => (await api('/api/eq')).eqState.smoothingEnabled === !sm0, { msg: 'suavizado alternado' });

  await pg.click('#tab-adv-btn');
  await pg.waitFor(`!!document.querySelector('#adv-crossfeed-toggle')`);
  const cf0 = (await api('/api/eq')).eqState.crossfeed.enabled;
  await pg.click('#adv-crossfeed-toggle');
  await waitBackend(async () => (await api('/api/eq')).eqState.crossfeed.enabled === !cf0, { msg: 'crossfeed alternado' });
  await pg.waitFor(`document.querySelector('#adv-crossfeed-toggle').classList.contains('is-on') === ${!cf0}`, {
    msg: 'el interruptor de crossfeed refleja el estado real',
  });
  await pg.click('#tab-eq-btn');
  await pg.click('#dsp-close-btn');
  await pg.waitFor(`document.querySelectorAll('.fader-track').length === 0`, { msg: 'drawer DSP cerrado' });
});

test('modo inmersivo: abrir con botón, cerrar con botón y con Escape', async (pg) => {
  await pg.click('#toggle-lyrics');
  await pg.waitFor(`!!document.querySelector('.om-Immersive')`, { msg: 'vista inmersiva abierta' });
  await pg.click('#immersive-exit-btn');
  await pg.waitFor(`!document.querySelector('.om-Immersive')`, { msg: 'vista inmersiva cerrada con botón' });
  await pg.click('#toggle-fullscreen');
  await pg.waitFor(`!!document.querySelector('.om-Immersive')`);
  await pg.key('Escape', { code: 'Escape', keyCode: 27 });
  await pg.waitFor(`!document.querySelector('.om-Immersive')`, { msg: 'vista inmersiva cerrada con Escape' });
});

test('vistas: artistas (clic navega a pistas), carpetas y modal de atajos', async (pg) => {
  await pg.click('[data-nav="artists"]');
  await pg.waitFor(`document.querySelectorAll('.artist-card').length === 2`, { msg: '2 artistas' });
  await pg.click('.artist-card', { index: 0 });
  await pg.waitFor(`document.querySelector('#crumb-current').textContent === 'Pistas'`, { msg: 'navegó a Pistas' });
  await pg.eval(`document.getElementById('global-search-input').blur()`);
  await pg.key('Escape', { code: 'Escape', keyCode: 27 });

  await pg.click('[data-nav="folders"]');
  await pg.waitFor(`document.querySelectorAll('.folder-track-row').length > 0`, { msg: 'filas en el explorador de carpetas' });

  await pg.click('[data-action="open-settings"]');
  await pg.waitFor(`!!document.querySelector('.om-ModalBackdrop')`, { msg: 'modal de atajos abierto' });
  await pg.click('#shortcuts-close-btn');
  await pg.waitFor(`!document.querySelector('.om-ModalBackdrop')`, { msg: 'modal de atajos cerrado' });
});

test('teclado: Espacio pausa/reanuda y "2" cambia a la vista de pistas', async (pg) => {
  await pg.eval(`document.activeElement?.blur?.()`);
  let s = await engineStatus();
  if (s.state !== 'playing') {
    await pg.click('#np-play-btn');
    await waitBackend(async () => (await engineStatus()).state === 'playing');
  }
  await pg.key(' ', { code: 'Space', keyCode: 32 });
  await waitBackend(async () => (await engineStatus()).state === 'paused', { msg: 'Espacio → pausa' });
  await pg.key(' ', { code: 'Space', keyCode: 32 });
  await waitBackend(async () => (await engineStatus()).state === 'playing', { msg: 'Espacio → reproducir' });
  await pg.key('2', { code: 'Digit2', keyCode: 50 });
  await pg.waitFor(`document.querySelector('#crumb-current').textContent === 'Pistas'`, { msg: 'tecla 2 → Pistas' });
});

test('rendimiento: navegar 20 veces entre vistas no acumula suscripciones (fugas)', async (pg) => {
  await pg.click('[data-nav="albums"]');
  await sleep(200);
  const base = await pg.eval(`window.__omStore.listeners.size`);
  const views = ['tracks', 'artists', 'folders', 'albums'];
  for (let i = 0; i < 20; i++) {
    await pg.click(`[data-nav="${views[i % views.length]}"]`);
    await sleep(40);
  }
  await pg.click('[data-nav="albums"]');
  await sleep(200);
  const after = await pg.eval(`window.__omStore.listeners.size`);
  assert(after <= base + 1, `las suscripciones del store crecieron de ${base} a ${after} (fuga de memoria / lentitud)`);
});

/* ------------------------------------------------------------------ */
/* 6. Ejecución                                                        */
/* ------------------------------------------------------------------ */
async function main() {
  console.log('\n======================================================================');
  console.log('  OurMusic — Suite E2E del Frontend (interacciones reales)');
  console.log('======================================================================\n');

  await buildFixtures();
  const app = await createOurMusicApp({ dataDir: DATA_DIR, port: 0, watchFolders: false });
  BASE = app.baseUrl;
  await app.engine.setDevice({ device: 'null' }).catch(() => {});
  await app.library.scanDirectory(MUSIC_DIR);

  let browser;
  let failed = 0;
  let ran = 0;
  try {
    browser = await launchBrowser();
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pg = new Page(cdp, sessionId, BASE);
    await pg.send('Runtime.enable');
    await pg.send('Page.enable');
    await pg.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await pg.send('Page.navigate', { url: BASE });
    await pg.waitFor(`!!window.__omStore && document.querySelectorAll('.om-NavItem').length > 0`, {
      timeout: 10000,
      msg: 'que cargue la aplicación',
    });

    for (const t of tests) {
      if (FILTER && !t.name.toLowerCase().includes(FILTER)) continue;
      ran++;
      const errBefore = pg.errors.length;
      const t0 = Date.now();
      process.stdout.write(`  [UI] ${t.name} ... `);
      try {
        await t.fn(pg);
        const newErrs = pg.errors.slice(errBefore);
        if (newErrs.length > 0) throw new Error(newErrs.join(' | '));
        console.log(`OK (${Date.now() - t0} ms)`);
      } catch (err) {
        failed++;
        console.log(`FALLO (${Date.now() - t0} ms)\n        → ${err.message}`);
      }
    }
  } finally {
    try {
      browser?.proc.kill('SIGKILL');
    } catch {
      // ignorar
    }
    await app.close().catch(() => {});
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log('\n======================================================================');
  console.log(`  RESULTADO UI: ${ran - failed}/${ran} pruebas superadas.`);
  console.log('======================================================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[E2E] Error fatal:', err);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
});
