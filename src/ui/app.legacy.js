const state = {
  tracks: [],
  filteredTracks: [],
  librarySummary: null,
  queueState: { queue: [], currentIndex: -1, currentTrack: null, repeatMode: 'off', shuffle: false },
  status: null,
  devices: [],
  deviceConfig: { device: 'default', bitPerfect: true, dop: false },
  eqState: null,
  presets: [],
  playlists: [],
  smartPlaylists: [],
  activeFilter: 'all',
  searchQuery: '',
  seeking: false,
  currentLyricsTrackId: null,
  currentSyncedLyrics: [],
  currentPlainLyrics: '',
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body,
  });
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Error HTTP ${res.status}`);
  }
  return data;
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('appToast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

function fmtFreq(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz % 1000 === 0 ? 0 : 1)}k` : `${hz}`;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- View Navigation ---------------- */
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`view-${btn.dataset.view}`).classList.add('active');
    if (btn.dataset.view === 'eq') drawEqCurve();
  });
});

/* ---------------- Library Rendering & Filtering ---------------- */
function applyLocalFilters() {
  const q = state.searchQuery.trim().toLowerCase();
  const f = state.activeFilter;

  state.filteredTracks = state.tracks.filter((t) => {
    if (f === 'hires' && !t.isHiRes) return false;
    if (f === 'lyrics' && !t.hasSyncedLyrics && !t.hasLyrics) return false;
    if (!['all', 'hires', 'lyrics'].includes(f) && t.codec !== f) return false;
    if (q) {
      const hay = `${t.title} ${t.artist} ${t.album} ${t.composer || ''} ${t.codec}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  renderLibraryTable();
}

function renderLibraryTable() {
  const tbody = document.getElementById('libraryTableBody');
  const empty = document.getElementById('libraryEmptyHint');
  const playingPath = state.status?.path || '';

  if (state.filteredTracks.length === 0) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = state.filteredTracks
    .map((t, i) => {
      const rateKhz = t.dsdBitRate
        ? `DSD${Math.round(t.dsdBitRate / 44100)} (${(t.dsdBitRate / 1e6).toFixed(2)} MHz)`
        : `${(t.sampleRate / 1000).toFixed(1)} kHz / ${t.bitDepth}-bit`;
      const isPlaying = playingPath && playingPath === t.filePath;
      return `
        <tr class="${isPlaying ? 'playing-row' : ''}" data-id="${t.id}">
          <td>${i + 1}</td>
          <td>
            <strong>${escapeHtml(t.title)}</strong>
            ${t.hasSyncedLyrics ? '<span class="badge" title="Letras sincronizadas">LRC</span>' : ''}
          </td>
          <td>${escapeHtml(t.artist)}</td>
          <td>${escapeHtml(t.album)}</td>
          <td>${escapeHtml(t.composer || '—')}</td>
          <td><span class="badge ${t.isHiRes ? 'hires' : ''}">${escapeHtml(t.codec)} · ${rateKhz}</span></td>
          <td>${fmtTime(t.durationSec)}</td>
          <td>
            <button class="btn primary small act-play" data-idx="${i}">▶</button>
            <button class="btn subtle small act-queue" data-id="${t.id}" title="Añadir a cola">+Cola</button>
            <button class="btn subtle small act-tags" data-id="${t.id}" title="Editar metadatos embebidos">Tags</button>
          </td>
        </tr>
      `;
    })
    .join('');
}

document.getElementById('libraryTableBody').addEventListener('click', async (e) => {
  const playBtn = e.target.closest('.act-play');
  const queueBtn = e.target.closest('.act-queue');
  const tagsBtn = e.target.closest('.act-tags');

  if (playBtn) {
    const idx = parseInt(playBtn.dataset.idx, 10);
    const ids = state.filteredTracks.map((t) => t.id);
    const res = await api('/api/player/play', {
      method: 'POST',
      body: { trackIds: ids, startIndex: idx },
    });
    state.queueState = res.queueState;
    renderQueue();
  } else if (queueBtn) {
    const res = await api('/api/queue/enqueue', {
      method: 'POST',
      body: { trackId: queueBtn.dataset.id },
    });
    state.queueState = res.queueState;
    renderQueue();
    showToast('Pista añadida a la cola Gapless');
  } else if (tagsBtn) {
    openTagEditor(tagsBtn.dataset.id);
  }
});

document.getElementById('playAllFilteredBtn').addEventListener('click', async () => {
  if (state.filteredTracks.length === 0) return;
  const res = await api('/api/player/play', {
    method: 'POST',
    body: { trackIds: state.filteredTracks.map((t) => t.id), startIndex: 0 },
  });
  state.queueState = res.queueState;
  renderQueue();
});

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.searchQuery = e.target.value;
  applyLocalFilters();
});

document.getElementById('codecFilterPills').addEventListener('click', (e) => {
  const pill = e.target.closest('.pill');
  if (!pill) return;
  document.querySelectorAll('#codecFilterPills .pill').forEach((p) => p.classList.remove('active'));
  pill.classList.add('active');
  state.activeFilter = pill.dataset.filter;
  applyLocalFilters();
});

document.getElementById('scanForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = document.getElementById('scanDirInput').value.trim();
  if (!dir) return;
  const btn = document.getElementById('scanSubmitBtn');
  btn.disabled = true;
  document.getElementById('scanProgressBar').classList.remove('hidden');
  try {
    const res = await api('/api/library/scan', { method: 'POST', body: { directory: dir } });
    state.tracks = res.tracks;
    state.librarySummary = res.summary;
    state.smartPlaylists = res.smartPlaylists;
    updateSummaryWidgets();
    applyLocalFilters();
    renderAlbums();
    renderSmartPlaylists();
    showToast(`Escaneo completado: ${res.report.indexedCount} pistas indexadas`);
  } catch (err) {
    showToast(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    document.getElementById('scanProgressBar').classList.add('hidden');
  }
});

function updateSummaryWidgets() {
  if (!state.librarySummary) return;
  document.getElementById('statTracks').textContent = state.librarySummary.totalTracks;
  document.getElementById('statHiRes').textContent = state.librarySummary.hiResCount;
}

function renderAlbums() {
  const grid = document.getElementById('albumsGrid');
  const albums = state.librarySummary?.albums || [];
  if (albums.length === 0) {
    grid.innerHTML = '<div class="empty-hint">No hay álbumes indexados todavía.</div>';
    return;
  }
  grid.innerHTML = albums
    .map(
      (alb) => `
      <div class="album-card" data-album="${escapeHtml(alb.album)}">
        <div class="album-art">
          ${
            alb.coverId
              ? `<img src="/api/covers/${encodeURIComponent(alb.coverId)}" alt="Carátula" />`
              : `<span>${escapeHtml(alb.album.slice(0, 2).toUpperCase())}</span>`
          }
        </div>
        <div class="album-title">${escapeHtml(alb.album)}</div>
        <div class="album-artist">${escapeHtml(alb.artist)} · ${alb.trackCount} pistas</div>
      </div>
    `
    )
    .join('');
}

document.getElementById('albumsGrid').addEventListener('click', async (e) => {
  const card = e.target.closest('.album-card');
  if (!card) return;
  const albumName = card.dataset.album;
  const albumTracks = state.tracks.filter((t) => t.album === albumName);
  if (albumTracks.length > 0) {
    const res = await api('/api/player/play', {
      method: 'POST',
      body: { trackIds: albumTracks.map((t) => t.id), startIndex: 0 },
    });
    state.queueState = res.queueState;
    renderQueue();
    showToast(`Reproduciendo álbum «${albumName}»`);
  }
});

/* ---------------- Equalizer, Biquad Response Curve & DSP Hook ---------------- */
function renderEqualizer() {
  const eq = state.eqState;
  if (!eq) return;

  document.getElementById('eqEnableToggle').checked = Boolean(eq.enabled);
  document.getElementById('eqBandModeSelect').value = String(eq.numBands);
  document.getElementById('smoothingToggle').checked = Boolean(eq.smoothingEnabled);
  document.getElementById('preampSlider').value = eq.preampDb;
  document.getElementById('preampValLabel').textContent = `${eq.preampDb >= 0 ? '+' : ''}${Number(eq.preampDb).toFixed(1)} dB`;
  document.getElementById('dspHookToggle').checked = Boolean(eq.customHookEnabled);
  document.getElementById('stereoWidthSlider').value = eq.stereoWidth;
  document.getElementById('stereoWidthVal').textContent = `${Math.round(eq.stereoWidth * 100)}%`;

  const presetSel = document.getElementById('presetSelect');
  presetSel.innerHTML = [
    ...state.presets.map(
      (p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}${p.builtin ? '' : ' (Usuario)'}</option>`
    ),
    '<option value="custom">Personalizado (Manual)</option>',
  ].join('');
  presetSel.value = state.presets.some((p) => p.id === eq.activePresetId) ? eq.activePresetId : 'custom';

  const container = document.getElementById('eqBandsContainer');
  container.innerHTML = eq.bandFreqs
    .map((hz, idx) => {
      const g = Number(eq.gains[idx] || 0);
      return `
        <div class="fader-col">
          <div class="fader-val" id="bandVal_${idx}">${g >= 0 ? '+' : ''}${g.toFixed(1)} dB</div>
          <div class="vslider-wrap">
            <input type="range" class="vslider band-slider" data-band="${idx}" min="-12" max="12" step="0.5" value="${g}" />
          </div>
          <div class="fader-freq">${fmtFreq(hz)} Hz</div>
        </div>
      `;
    })
    .join('');

  drawEqCurve();
}

function drawEqCurve() {
  const canvas = document.getElementById('eqCurveCanvas');
  if (!canvas || !state.eqState) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  // Grid lines (-12, -6, 0, +6, +12 dB)
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (const db of [-12, -6, 0, 6, 12]) {
    const y = H / 2 - (db / 16) * (H / 2 - 12);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
    ctx.stroke();
  }

  const eq = state.eqState;
  const fs = 48000;
  const q = eq.numBands === 10 ? 1.414 : 1.0;

  // Compute RBJ peaking biquad coefficients for curve preview
  const filters = eq.bandFreqs.map((f0, idx) => {
    const db = eq.enabled ? Number(eq.gains[idx] || 0) : 0;
    if (Math.abs(db) < 0.01) return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
    const A = Math.pow(10, db / 40);
    const w0 = (2 * Math.PI * f0) / fs;
    const alpha = Math.sin(w0) / (2 * q);
    const cw = Math.cos(w0);
    const a0 = 1 + alpha / A;
    return {
      b0: (1 + alpha * A) / a0,
      b1: (-2 * cw) / a0,
      b2: (1 - alpha * A) / a0,
      a1: (-2 * cw) / a0,
      a2: (1 - alpha / A) / a0,
    };
  });

  ctx.strokeStyle = eq.enabled ? '#38bdf8' : '#10b981';
  ctx.lineWidth = 2.4;
  ctx.beginPath();

  for (let x = 0; x < W; x++) {
    const norm = x / (W - 1);
    const freq = 20 * Math.pow(20000 / 20, norm);
    const w = (2 * Math.PI * freq) / fs;
    const cos1 = Math.cos(w);
    const sin1 = Math.sin(w);
    const cos2 = Math.cos(2 * w);
    const sin2 = Math.sin(2 * w);

    let totalDb = eq.enabled ? Number(eq.preampDb || 0) : 0;
    for (const flt of filters) {
      const nr = flt.b0 + flt.b1 * cos1 + flt.b2 * cos2;
      const ni = -(flt.b1 * sin1 + flt.b2 * sin2);
      const dr = 1 + flt.a1 * cos1 + flt.a2 * cos2;
      const di = -(flt.a1 * sin1 + flt.a2 * sin2);
      const magSq = (nr * nr + ni * ni) / (dr * dr + di * di + 1e-18);
      totalDb += 10 * Math.log10(magSq);
    }

    const clamped = Math.max(-16, Math.min(16, totalDb));
    const y = H / 2 - (clamped / 16) * (H / 2 - 12);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

document.getElementById('eqBandsContainer').addEventListener('input', async (e) => {
  const slider = e.target.closest('.band-slider');
  if (!slider) return;
  const band = parseInt(slider.dataset.band, 10);
  const val = parseFloat(slider.value);
  state.eqState.gains[band] = val;
  state.eqState.activePresetId = 'custom';
  document.getElementById(`bandVal_${band}`).textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
  document.getElementById('presetSelect').value = 'custom';
  drawEqCurve();
  await api('/api/eq/band', { method: 'POST', body: { band, gainDb: val } });
});

document.getElementById('preampSlider').addEventListener('input', async (e) => {
  const val = parseFloat(e.target.value);
  state.eqState.preampDb = val;
  document.getElementById('preampValLabel').textContent = `${val >= 0 ? '+' : ''}${val.toFixed(1)} dB`;
  drawEqCurve();
  await api('/api/eq/preamp', { method: 'POST', body: { preampDb: val } });
});

document.getElementById('eqEnableToggle').addEventListener('change', async (e) => {
  const res = await api('/api/eq', { method: 'POST', body: { enabled: e.target.checked } });
  state.eqState = res.eqState;
  drawEqCurve();
});

document.getElementById('eqBandModeSelect').addEventListener('change', async (e) => {
  const nb = parseInt(e.target.value, 10);
  const res = await api('/api/eq', { method: 'POST', body: { numBands: nb } });
  state.eqState = res.eqState;
  state.presets = res.presets;
  renderEqualizer();
});

document.getElementById('smoothingToggle').addEventListener('change', async (e) => {
  const res = await api('/api/eq/smoothing', { method: 'POST', body: { enabled: e.target.checked } });
  state.eqState = res.eqState;
  showToast(
    e.target.checked
      ? 'Suavizado exponencial activado (15 ms anti-click)'
      : 'Suavizado desactivado (cambio instantáneo)'
  );
});

document.getElementById('presetSelect').addEventListener('change', async (e) => {
  const id = e.target.value;
  if (id === 'custom') return;
  const res = await api('/api/eq/presets/apply', {
    method: 'POST',
    body: { id, numBands: state.eqState.numBands },
  });
  state.eqState = res.eqState;
  renderEqualizer();
});

document.getElementById('resetFlatBtn').addEventListener('click', async () => {
  const res = await api('/api/eq/presets/apply', {
    method: 'POST',
    body: { id: 'flat', numBands: state.eqState.numBands },
  });
  state.eqState = res.eqState;
  renderEqualizer();
});

document.getElementById('savePresetBtn').addEventListener('click', async () => {
  const name = window.prompt('Nombre para guardar el perfil JSON del ecualizador:');
  if (!name) return;
  const res = await api('/api/eq/presets', {
    method: 'POST',
    body: {
      name,
      numBands: state.eqState.numBands,
      preampDb: state.eqState.preampDb,
      gains: state.eqState.gains,
      smoothingEnabled: state.eqState.smoothingEnabled,
    },
  });
  state.eqState = res.eqState;
  state.presets = res.presets;
  renderEqualizer();
  showToast(`Preset «${res.preset.name}» guardado en JSON`);
});

document.getElementById('exportPresetBtn').addEventListener('click', () => {
  const id = state.eqState.activePresetId;
  if (!id || id === 'custom') {
    showToast('Guarda primero el preset personalizado para exportarlo');
    return;
  }
  window.open(`/api/eq/presets/${encodeURIComponent(id)}/export`, '_blank');
});

document.getElementById('importPresetBtn').addEventListener('click', async () => {
  const raw = window.prompt('Pega el JSON del preset de ecualizador:');
  if (!raw) return;
  try {
    const res = await api('/api/eq/presets/import', { method: 'POST', body: { json: raw } });
    state.presets = res.presets;
    renderEqualizer();
    showToast(`Preset «${res.preset.name}» importado`);
  } catch (err) {
    showToast(`Error al importar preset: ${err.message}`);
  }
});

document.getElementById('deletePresetBtn').addEventListener('click', async () => {
  const id = state.eqState.activePresetId;
  const preset = state.presets.find((p) => p.id === id);
  if (!preset || preset.builtin) {
    showToast('Solo se pueden eliminar presets personalizados de usuario');
    return;
  }
  const res = await api(`/api/eq/presets/${encodeURIComponent(id)}`, { method: 'DELETE' });
  state.eqState = res.eqState;
  state.presets = res.presets;
  renderEqualizer();
  showToast('Preset eliminado');
});

document.getElementById('dspHookToggle').addEventListener('change', async (e) => {
  const res = await api('/api/eq/hook', {
    method: 'POST',
    body: { enabled: e.target.checked, stereoWidth: parseFloat(document.getElementById('stereoWidthSlider').value) },
  });
  state.eqState = res.eqState;
});

document.getElementById('stereoWidthSlider').addEventListener('input', async (e) => {
  const w = parseFloat(e.target.value);
  document.getElementById('stereoWidthVal').textContent = `${Math.round(w * 100)}%`;
  const res = await api('/api/eq/hook', {
    method: 'POST',
    body: { enabled: document.getElementById('dspHookToggle').checked, stereoWidth: w },
  });
  state.eqState = res.eqState;
});

/* ---------------- Queue, Playlists & Smart Playlists ---------------- */
function renderQueue() {
  const ul = document.getElementById('activeQueueList');
  const q = state.queueState.queue || [];
  if (q.length === 0) {
    ul.innerHTML = '<li><span class="muted">La cola está vacía</span></li>';
    return;
  }
  ul.innerHTML = q
    .map(
      (t, idx) => `
      <li class="${idx === state.queueState.currentIndex ? 'active-queue-item' : ''}">
        <span>${idx + 1}. <strong>${escapeHtml(t.title)}</strong> — ${escapeHtml(t.artist || '')}</span>
        <div class="btn-row">
          <button class="btn subtle small q-play" data-idx="${idx}">▶</button>
          <button class="btn danger small q-del" data-idx="${idx}">✕</button>
        </div>
      </li>
    `
    )
    .join('');

  document.getElementById('shuffleBtn').classList.toggle('active', Boolean(state.queueState.shuffle));
  const repMap = { off: 'Rep: Off', all: 'Rep: Todo', one: 'Rep: 1' };
  document.getElementById('repeatBtn').textContent = repMap[state.queueState.repeatMode] || 'Rep: Off';
  document.getElementById('repeatBtn').classList.toggle('active', state.queueState.repeatMode !== 'off');
}

document.getElementById('activeQueueList').addEventListener('click', async (e) => {
  const pBtn = e.target.closest('.q-play');
  const dBtn = e.target.closest('.q-del');
  if (pBtn) {
    const res = await api('/api/player/play', {
      method: 'POST',
      body: { queueIndex: parseInt(pBtn.dataset.idx, 10) },
    });
    state.queueState = res.queueState;
    renderQueue();
  } else if (dBtn) {
    const res = await api(`/api/queue/${dBtn.dataset.idx}`, { method: 'DELETE' });
    state.queueState = res.queueState;
    renderQueue();
  }
});

document.getElementById('clearQueueBtn').addEventListener('click', async () => {
  const res = await api('/api/queue', { method: 'DELETE' });
  state.queueState = res.queueState;
  renderQueue();
});

function renderStandardPlaylists() {
  const ul = document.getElementById('standardPlaylistsList');
  if (state.playlists.length === 0) {
    ul.innerHTML = '<li><span class="muted">Sin listas guardadas. Puedes guardar la cola actual o importar M3U/PLS/XSPF.</span></li>';
    return;
  }
  ul.innerHTML = state.playlists
    .map(
      (pl) => `
      <li>
        <span><strong>${escapeHtml(pl.name)}</strong> (${pl.trackCount} pistas)</span>
        <div class="btn-row">
          <button class="btn primary small pl-play" data-id="${pl.id}">▶</button>
          <button class="btn subtle small pl-exp" data-id="${pl.id}" data-fmt="m3u">M3U</button>
          <button class="btn subtle small pl-exp" data-id="${pl.id}" data-fmt="pls">PLS</button>
          <button class="btn subtle small pl-exp" data-id="${pl.id}" data-fmt="xspf">XSPF</button>
          <button class="btn danger small pl-del" data-id="${pl.id}">✕</button>
        </div>
      </li>
    `
    )
    .join('');
}

document.getElementById('standardPlaylistsList').addEventListener('click', async (e) => {
  const playB = e.target.closest('.pl-play');
  const expB = e.target.closest('.pl-exp');
  const delB = e.target.closest('.pl-del');

  if (playB) {
    const pl = state.playlists.find((p) => p.id === playB.dataset.id);
    if (pl && pl.tracks.length > 0) {
      const res = await api('/api/player/play', {
        method: 'POST',
        body: { trackIds: pl.tracks.map((t) => t.id || t.filePath), startIndex: 0 },
      });
      state.queueState = res.queueState;
      renderQueue();
    }
  } else if (expB) {
    window.open(
      `/api/playlists/${encodeURIComponent(expB.dataset.id)}/export?format=${expB.dataset.fmt}`,
      '_blank'
    );
  } else if (delB) {
    const res = await api(`/api/playlists/${encodeURIComponent(delB.dataset.id)}`, {
      method: 'DELETE',
    });
    state.playlists = res.playlists;
    renderStandardPlaylists();
  }
});

document.getElementById('newPlaylistBtn').addEventListener('click', async () => {
  const name = window.prompt('Nombre de la lista (se creará con las pistas de la cola o vista actual):');
  if (!name) return;
  const sourceTracks =
    state.queueState.queue.length > 0 ? state.queueState.queue : state.filteredTracks;
  const res = await api('/api/playlists', {
    method: 'POST',
    body: { name, trackIdsOrPaths: sourceTracks.map((t) => t.filePath) },
  });
  state.playlists = res.playlists;
  renderStandardPlaylists();
  showToast(`Lista «${name}» creada (${res.playlist.trackCount} pistas)`);
});

/* Import Playlist Modal */
document.getElementById('importPlaylistModalBtn').addEventListener('click', () => {
  document.getElementById('importPlaylistBackdrop').classList.remove('hidden');
});
document.getElementById('closeImportPlaylistBtn').addEventListener('click', () => {
  document.getElementById('importPlaylistBackdrop').classList.add('hidden');
});
document.getElementById('importPlaylistForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const filePath = document.getElementById('importPlaylistPath').value.trim();
  const content = document.getElementById('importPlaylistContent').value.trim();
  try {
    const res = await api('/api/playlists/import', {
      method: 'POST',
      body: { format: 'auto', filePath, content },
    });
    state.playlists = res.playlists;
    state.tracks = res.tracks;
    applyLocalFilters();
    renderStandardPlaylists();
    document.getElementById('importPlaylistBackdrop').classList.add('hidden');
    showToast(`Importada «${res.playlist.name}» (${res.playlist.trackCount} pistas)`);
  } catch (err) {
    showToast(`Error al importar: ${err.message}`);
  }
});

/* Smart Playlists */
function renderSmartPlaylists() {
  const box = document.getElementById('smartPlaylistsContainer');
  box.innerHTML = state.smartPlaylists
    .map(
      (sp) => `
      <div class="smart-card">
        <div class="card-row-between">
          <strong>${escapeHtml(sp.name)}</strong>
          <span class="badge hires">${sp.trackCount} pistas</span>
        </div>
        <div class="muted small">
          Modo: ${sp.match === 'any' ? 'Cualquier regla' : 'Todas las reglas'} (${sp.rules.length} reglas)
        </div>
        <div class="btn-row">
          <button class="btn primary small sp-play" data-id="${sp.id}">▶ Reproducir</button>
          <button class="btn danger small sp-del" data-id="${sp.id}">Eliminar</button>
        </div>
      </div>
    `
    )
    .join('');
}

document.getElementById('smartPlaylistsContainer').addEventListener('click', async (e) => {
  const playB = e.target.closest('.sp-play');
  const delB = e.target.closest('.sp-del');
  if (playB) {
    const sp = state.smartPlaylists.find((s) => s.id === playB.dataset.id);
    if (sp && sp.tracks.length > 0) {
      const res = await api('/api/player/play', {
        method: 'POST',
        body: { trackIds: sp.tracks.map((t) => t.id), startIndex: 0 },
      });
      state.queueState = res.queueState;
      renderQueue();
      showToast(`Reproduciendo «${sp.name}»`);
    } else {
      showToast('Ninguna pista de la biblioteca coincide todavía con esta lista inteligente');
    }
  } else if (delB) {
    const res = await api(`/api/smart-playlists/${encodeURIComponent(delB.dataset.id)}`, {
      method: 'DELETE',
    });
    state.smartPlaylists = res.smartPlaylists;
    renderSmartPlaylists();
  }
});

function addSmartRuleRow(field = 'codec', operator = 'equals', value = 'FLAC') {
  const row = document.createElement('div');
  row.className = 'smart-rule-row';
  row.innerHTML = `
    <select class="select-input sr-field">
      <option value="codec">Formato (Codec)</option>
      <option value="sampleRate">Frecuencia Muestreo (Hz)</option>
      <option value="bitDepth">Profundidad de Bits</option>
      <option value="artist">Artista</option>
      <option value="album">Álbum</option>
      <option value="composer">Compositor</option>
      <option value="genre">Género</option>
      <option value="year">Año</option>
      <option value="hasSyncedLyrics">Tiene Letras Sincronizadas</option>
    </select>
    <select class="select-input sr-op">
      <option value="contains">Contiene</option>
      <option value="equals">Es igual a</option>
      <option value="gt">Mayor que (&gt;)</option>
      <option value="gte">Mayor o igual (&gt;=)</option>
      <option value="lt">Menor que (&lt;)</option>
      <option value="is_true">Es Verdadero</option>
    </select>
    <input type="text" class="sr-val" value="${escapeHtml(value)}" placeholder="Valor" />
    <button type="button" class="btn danger small sr-rm">✕</button>
  `;
  row.querySelector('.sr-field').value = field;
  row.querySelector('.sr-op').value = operator;
  row.querySelector('.sr-rm').addEventListener('click', () => row.remove());
  document.getElementById('smartRulesContainer').appendChild(row);
}

document.getElementById('newSmartPlaylistBtn').addEventListener('click', () => {
  const form = document.getElementById('smartBuilderForm');
  form.classList.remove('hidden');
  const box = document.getElementById('smartRulesContainer');
  if (box.children.length === 0) addSmartRuleRow('sampleRate', 'gte', '88200');
});
document.getElementById('addSmartRuleBtn').addEventListener('click', () => addSmartRuleRow());
document.getElementById('cancelSmartBuilderBtn').addEventListener('click', () => {
  document.getElementById('smartBuilderForm').classList.add('hidden');
});
document.getElementById('smartBuilderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rules = Array.from(document.querySelectorAll('.smart-rule-row')).map((r) => ({
    field: r.querySelector('.sr-field').value,
    operator: r.querySelector('.sr-op').value,
    value: r.querySelector('.sr-val').value,
  }));
  const res = await api('/api/smart-playlists', {
    method: 'POST',
    body: {
      name: document.getElementById('smartNameInput').value.trim(),
      match: document.getElementById('smartMatchSelect').value,
      sortBy: document.getElementById('smartSortSelect').value,
      rules,
    },
  });
  state.smartPlaylists = res.smartPlaylists;
  renderSmartPlaylists();
  document.getElementById('smartBuilderForm').classList.add('hidden');
  document.getElementById('smartNameInput').value = '';
  showToast('Lista inteligente guardada');
});

/* ---------------- Tag Editor Modal ---------------- */
async function openTagEditor(trackId) {
  const res = await api(`/api/tracks/${encodeURIComponent(trackId)}`);
  const t = res.track;
  document.getElementById('tagTrackId').value = t.id;
  document.getElementById('tagModalFormatBadge').textContent = t.tagFormat || t.codec;
  document.getElementById('tagTitle').value = t.title || '';
  document.getElementById('tagArtist').value = t.artist === 'Artista Desconocido' ? '' : t.artist || '';
  document.getElementById('tagAlbum').value = t.album === 'Álbum Desconocido' ? '' : t.album || '';
  document.getElementById('tagComposer').value = t.composer || '';
  document.getElementById('tagYear').value = t.year || '';
  document.getElementById('tagGenre').value = t.genre || '';
  document.getElementById('tagTrackNum').value = t.trackNumber || '';
  document.getElementById('tagLyrics').value = t.lyrics || '';
  document.getElementById('tagCoverFile').value = '';
  document.getElementById('tagModalBackdrop').classList.remove('hidden');
}

document.getElementById('closeTagModalBtn').addEventListener('click', () => {
  document.getElementById('tagModalBackdrop').classList.add('hidden');
});

document.getElementById('tagEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const trackId = document.getElementById('tagTrackId').value;
  const patch = {
    title: document.getElementById('tagTitle').value,
    artist: document.getElementById('tagArtist').value,
    album: document.getElementById('tagAlbum').value,
    composer: document.getElementById('tagComposer').value,
    year: document.getElementById('tagYear').value,
    genre: document.getElementById('tagGenre').value,
    trackNumber: document.getElementById('tagTrackNum').value,
    lyrics: document.getElementById('tagLyrics').value,
  };

  const fileInput = document.getElementById('tagCoverFile');
  if (fileInput.files && fileInput.files[0]) {
    const file = fileInput.files[0];
    const buf = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    patch.coverArt = { mime: file.type || 'image/jpeg', data: btoa(binary) };
  }

  try {
    const res = await api(`/api/tracks/${encodeURIComponent(trackId)}/tags`, {
      method: 'PUT',
      body: patch,
    });
    const idx = state.tracks.findIndex((x) => x.id === trackId);
    if (idx >= 0) state.tracks[idx] = res.track;
    state.librarySummary = res.summary;
    state.smartPlaylists = res.smartPlaylists;
    applyLocalFilters();
    renderAlbums();
    renderSmartPlaylists();
    if (state.currentLyricsTrackId === trackId) {
      state.currentLyricsTrackId = null;
      loadLyricsForActiveTrack(res.track);
    }
    document.getElementById('tagModalBackdrop').classList.add('hidden');
    showToast('Metadatos escritos directamente en el archivo de audio');
  } catch (err) {
    showToast(`Error al escribir tags: ${err.message}`);
  }
});

/* ---------------- Output HAL Devices ---------------- */
function renderDevices() {
  const sel = document.getElementById('deviceSelect');
  sel.innerHTML = state.devices
    .map(
      (d) =>
        `<option value="${escapeHtml(d.id)}">${escapeHtml(d.name)}${d.exclusiveCapable ? ' [Direct/Exclusive]' : ''}</option>`
    )
    .join('');
  if (state.deviceConfig.device) sel.value = state.deviceConfig.device;
  document.getElementById('bitPerfectToggle').checked = Boolean(state.deviceConfig.bitPerfect);
  document.getElementById('dopToggle').checked = Boolean(state.deviceConfig.dop);
}

document.getElementById('applyDeviceBtn').addEventListener('click', async () => {
  const payload = {
    device: document.getElementById('deviceSelect').value,
    bitPerfect: document.getElementById('bitPerfectToggle').checked,
    dop: document.getElementById('dopToggle').checked,
  };
  const res = await api('/api/devices', { method: 'POST', body: payload });
  state.deviceConfig = res.deviceConfig;
  showToast('Configuración de hardware HAL actualizada');
});

/* ---------------- Transport & Synchronized Lyrics ---------------- */
document.getElementById('playPauseBtn').addEventListener('click', async () => {
  if (!state.status || state.status.state === 'stopped') {
    if (state.queueState.queue.length > 0) {
      await api('/api/player/play', {
        method: 'POST',
        body: { queueIndex: Math.max(0, state.queueState.currentIndex) },
      });
    } else if (state.filteredTracks.length > 0) {
      const res = await api('/api/player/play', {
        method: 'POST',
        body: { trackIds: state.filteredTracks.map((t) => t.id), startIndex: 0 },
      });
      state.queueState = res.queueState;
      renderQueue();
    }
  } else {
    const pause = state.status.state === 'playing';
    await api('/api/player/pause', { method: 'POST', body: { paused: pause } });
  }
});

document.getElementById('stopBtn').addEventListener('click', () =>
  api('/api/player/stop', { method: 'POST' })
);
document.getElementById('nextBtn').addEventListener('click', async () => {
  const res = await api('/api/player/next', { method: 'POST' });
  state.queueState = res.queueState;
  renderQueue();
});
document.getElementById('prevBtn').addEventListener('click', async () => {
  const res = await api('/api/player/previous', { method: 'POST' });
  state.queueState = res.queueState;
  renderQueue();
});

document.getElementById('shuffleBtn').addEventListener('click', async () => {
  const res = await api('/api/player/modes', {
    method: 'POST',
    body: { shuffle: !state.queueState.shuffle },
  });
  state.queueState = res.queueState;
  renderQueue();
});

document.getElementById('repeatBtn').addEventListener('click', async () => {
  const order = ['off', 'all', 'one'];
  const nextMode = order[(order.indexOf(state.queueState.repeatMode) + 1) % order.length];
  const res = await api('/api/player/modes', {
    method: 'POST',
    body: { repeatMode: nextMode },
  });
  state.queueState = res.queueState;
  renderQueue();
});

const seekSlider = document.getElementById('seekSlider');
seekSlider.addEventListener('mousedown', () => (state.seeking = true));
seekSlider.addEventListener('change', async () => {
  if (state.status && state.status.durationSec > 0) {
    const targetSec = (parseFloat(seekSlider.value) / 1000) * state.status.durationSec;
    await api('/api/player/seek', { method: 'POST', body: { seconds: targetSec } });
  }
  state.seeking = false;
});

document.getElementById('volumeSlider').addEventListener('input', async (e) => {
  await api('/api/player/volume', {
    method: 'POST',
    body: { value: parseFloat(e.target.value) },
  });
});

async function loadLyricsForActiveTrack(trackObj) {
  if (!trackObj || !trackObj.id || state.currentLyricsTrackId === trackObj.id) return;
  state.currentLyricsTrackId = trackObj.id;
  try {
    const res = await api(`/api/tracks/${encodeURIComponent(trackObj.id)}`);
    state.currentSyncedLyrics = res.track.syncedLyrics || [];
    state.currentPlainLyrics = res.track.lyrics || '';
    document.getElementById('lyricsTrackSubtitle').textContent = `${res.track.title} — ${res.track.artist}`;
    renderLyricsStage(-1);
  } catch {
    state.currentSyncedLyrics = [];
    state.currentPlainLyrics = '';
  }
}

function renderLyricsStage(activeIndex) {
  const box = document.getElementById('lyricsContainer');
  if (state.currentSyncedLyrics.length > 0) {
    box.innerHTML = state.currentSyncedLyrics
      .map(
        (line, idx) =>
          `<div class="lyric-line ${idx === activeIndex ? 'active' : ''}" data-ms="${line.timeMs}">${escapeHtml(line.text || '♪')}</div>`
      )
      .join('');
    const activeEl = box.querySelector('.lyric-line.active');
    if (activeEl) activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (state.currentPlainLyrics) {
    box.innerHTML = state.currentPlainLyrics
      .split(/\r?\n/)
      .map((l) => `<div class="lyric-line">${escapeHtml(l)}</div>`)
      .join('');
  } else {
    box.innerHTML = '<div class="empty-hint">Esta pista no contiene letras embebidas ni archivo .lrc asociado. Puedes añadirlas desde el botón Tags.</div>';
  }
}

document.getElementById('lyricsContainer').addEventListener('click', async (e) => {
  const line = e.target.closest('.lyric-line[data-ms]');
  if (!line) return;
  const sec = parseInt(line.dataset.ms, 10) / 1000;
  await api('/api/player/seek', { method: 'POST', body: { seconds: sec } });
});

/* ---------------- Live Telemetry Rendering ---------------- */
let lastActiveLyricIdx = -2;

function renderTelemetry(st) {
  state.status = st;
  if (!st) return;

  document.getElementById('playPauseBtn').textContent = st.state === 'playing' ? '⏸' : '▶';
  document.getElementById('posTimeLabel').textContent = fmtTime(st.positionSec);
  document.getElementById('durTimeLabel').textContent = fmtTime(st.durationSec);

  if (!state.seeking && st.durationSec > 0) {
    seekSlider.value = Math.min(1000, Math.round((st.positionSec / st.durationSec) * 1000));
  }

  // VU Peak meters
  const pL = Math.min(100, Math.round(Math.pow(st.meters?.peakL || 0, 0.55) * 100));
  const pR = Math.min(100, Math.round(Math.pow(st.meters?.peakR || 0, 0.55) * 100));
  document.getElementById('vuBarL').style.width = st.state === 'playing' ? `${pL}%` : '0%';
  document.getElementById('vuBarR').style.width = st.state === 'playing' ? `${pR}%` : '0%';

  document.getElementById('hookBlocksCount').textContent = st.meters?.hookInvocations ?? 0;
  document.getElementById('clippedSamplesCount').textContent = st.meters?.clippedSamples ?? 0;

  // Match track metadata
  const trk = state.tracks.find((t) => t.filePath === st.path) || state.queueState.currentTrack;
  if (trk && st.path) {
    document.getElementById('npTitle').textContent = trk.title;
    document.getElementById('npArtist').textContent = trk.artist || '';
    const coverBox = document.getElementById('playerCoverBox');
    if (trk.coverId && !coverBox.dataset.cid?.includes(trk.coverId)) {
      coverBox.dataset.cid = trk.coverId;
      coverBox.innerHTML = `<img src="/api/covers/${encodeURIComponent(trk.coverId)}" alt="Carátula" />`;
    } else if (!trk.coverId && coverBox.dataset.cid) {
      coverBox.dataset.cid = '';
      coverBox.innerHTML = `<div class="cover-placeholder">OM</div>`;
    }
    loadLyricsForActiveTrack(trk);
  }

  if (st.sampleRate > 0) {
    const fmtText = st.dsdBitRate
      ? `${st.codec} ${(st.dsdBitRate / 1e6).toFixed(2)} MHz ${st.isDoP ? '(DoP)' : '(PCM FIR)'}`
      : `${st.codec} ${(st.sampleRate / 1000).toFixed(1)} kHz / ${st.bitDepth}-bit`;
    document.getElementById('npFormatBadge').textContent =
      `${fmtText} · Gapless: ${st.gaplessTransitions}`;
    document.getElementById('chainSource').textContent = fmtText;
  }

  // Signal path badge
  const dot = document.getElementById('signalDot');
  const modeLbl = document.getElementById('signalModeLabel');
  const detailLbl = document.getElementById('signalDetailText');

  dot.className = 'signal-dot';
  if (st.state === 'stopped') {
    modeLbl.textContent = 'EN ESPERA';
    detailLbl.textContent = 'Motor C11 listo';
  } else if (st.bitPerfect) {
    dot.classList.add('bitperfect');
    modeLbl.textContent = 'BIT-PERFECT ACTIVO';
    detailLbl.textContent = `${st.halBackend} · ${(st.halRate / 1000).toFixed(1)} kHz nativo sin remuestreo`;
  } else {
    dot.classList.add('dsp');
    modeLbl.textContent = st.eqEnabled || st.customHookEnabled ? 'DSP 64-BIT ACTIVO' : 'SALIDA DIRECTA';
    detailLbl.textContent = `${st.halBackend} · ${(st.halRate / 1000).toFixed(1)} kHz / ${st.halBitDepth}-bit`;
  }

  document.getElementById('chainDsp').textContent =
    st.eqEnabled || st.customHookEnabled
      ? `Activo (${st.numBands} bandas${st.smoothingEnabled ? ', suavizado ON' : ', suavizado OFF'})`
      : 'Bypass Bit-Perfect';
  document.getElementById('chainHal').textContent = st.halOpen
    ? `${st.halBackend} (${st.halRate} Hz / ${st.halBitDepth}-bit)`
    : 'Cerrado';

  // Update active synced lyric line
  if (state.currentSyncedLyrics.length > 0 && st.state === 'playing') {
    const curMs = st.positionSec * 1000;
    let idx = -1;
    for (let i = 0; i < state.currentSyncedLyrics.length; i++) {
      if (curMs >= state.currentSyncedLyrics[i].timeMs) idx = i;
      else break;
    }
    if (idx !== lastActiveLyricIdx) {
      lastActiveLyricIdx = idx;
      const lines = document.querySelectorAll('#lyricsContainer .lyric-line');
      lines.forEach((el, i) => el.classList.toggle('active', i === idx));
      if (idx >= 0 && lines[idx]) {
        lines[idx].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }
}

/* ---------------- Bootstrap & Non-Blocking SSE Connection ---------------- */
async function initApp() {
  const boot = await api('/api/bootstrap');
  document.getElementById('platformBadge').textContent =
    `Motor C11 · ${boot.audioApi} (${boot.platform === 'win32' ? 'Windows' : 'Linux'})`;

  state.tracks = boot.tracks;
  state.librarySummary = boot.librarySummary;
  state.queueState = boot.queueState;
  state.devices = boot.devices;
  state.deviceConfig = boot.deviceConfig;
  state.eqState = boot.eqState;
  state.presets = boot.presets;
  state.playlists = boot.playlists;
  state.smartPlaylists = boot.smartPlaylists;

  updateSummaryWidgets();
  applyLocalFilters();
  renderAlbums();
  renderEqualizer();
  renderQueue();
  renderStandardPlaylists();
  renderSmartPlaylists();
  renderDevices();
  renderTelemetry(boot.status);

  const es = new EventSource('/api/events');
  es.addEventListener('telemetry', (ev) => renderTelemetry(JSON.parse(ev.data)));
  es.addEventListener('queue_updated', (ev) => {
    state.queueState = JSON.parse(ev.data);
    renderQueue();
    renderLibraryTable();
  });
  es.addEventListener('eq_updated', (ev) => {
    state.eqState = JSON.parse(ev.data);
    renderEqualizer();
  });
  es.addEventListener('scan_progress', (ev) => {
    const p = JSON.parse(ev.data);
    const bar = document.getElementById('scanProgressBar');
    bar.classList.remove('hidden');
    document.getElementById('scanProgressText').textContent =
      `Indexando (${p.scanned}/${p.total}): ${p.currentFile}`;
  });
}

initApp().catch((err) => showToast(`Error al iniciar UI: ${err.message}`));
