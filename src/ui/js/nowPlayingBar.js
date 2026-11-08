/*
 * OurMusic — Componente de la Barra de Reproducción Persistente (Now Playing Bar)
 * Implementa la barra lineal limpia (sin forma de onda) con seek interactivo,
 * control de volumen, metadata, y popover de Ruta de Señal Hi-Fi.
 */
import { icon } from './icons.js';
import { coverSvg, applyAccent } from './visuals.js';
import { ApiClient } from './api.js';

function formatTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class NowPlayingBar {
  constructor({ container, store }) {
    this.container = container;
    this.store = store;
    this.isSeeking = false;
    this.showSignalPopover = false;

    this.render();
    this.bindEvents();

    this.store.subscribe((state, keys) => {
      if (keys.includes('playback') || keys.includes('showSignalPopover') || keys.includes('activeDrawer')) {
        this.update(state);
      }
    });
  }

  render() {
    this.container.innerHTML = `
      <footer class="om-NowPlaying" id="np-bar">
        <!-- Izquierda: Portada y Metadatos -->
        <div class="om-NP__track">
          <div class="om-NP__art" id="np-cover-wrap">
            <div class="om-MiniThumb" style="width:56px;height:56px;background:var(--bg-2);display:flex;align-items:center;justify-content:center;color:var(--text-4)">
              ${icon('disc', { size: 28 })}
            </div>
          </div>
          <div class="om-NP__meta">
            <div class="om-NP__titleRow">
              <span class="om-NP__title" id="np-title">Sin reproducción</span>
              <button class="om-IconBtn" id="np-fav-btn" title="Favorito">${icon('heart', { size: 15 })}</button>
            </div>
            <div class="om-NP__artist" id="np-artist">Selecciona un álbum o pista</div>
          </div>
        </div>

        <!-- Centro: Transporte y Barra de Progreso Lineal Limpia -->
        <div class="om-NP__center">
          <div class="om-Transport">
            <button class="om-IconBtn" id="np-shuffle-btn" title="Modo Aleatorio (S)">${icon('shuffle', { size: 16 })}</button>
            <button class="om-IconBtn" id="np-prev-btn" title="Pista anterior (Ctrl+←)">${icon('prev', { size: 18 })}</button>
            <button class="om-PlayBtn" id="np-play-btn" title="Reproducir / Pausar (Espacio)">${icon('play', { size: 18 })}</button>
            <button class="om-IconBtn" id="np-next-btn" title="Pista siguiente (Ctrl+→)">${icon('next', { size: 18 })}</button>
            <button class="om-IconBtn" id="np-repeat-btn" title="Modo Repetir (R)">${icon('repeat', { size: 16 })}</button>
          </div>
          <div class="om-SeekRow">
            <span class="om-Time tnum" id="np-time-cur">0:00</span>
            <div class="om-SeekBar" id="np-seek-bar" title="Buscar posición">
              <div class="om-SeekFill" id="np-seek-fill" style="width:0%"></div>
              <div class="om-SeekThumb" id="np-seek-thumb" style="left:0%"></div>
            </div>
            <span class="om-Time is-end tnum" id="np-time-end">0:00</span>
          </div>
        </div>

        <!-- Derecha: Insignia Hi-Fi, Volumen y Acceso a Paneles -->
        <div class="om-NP__right">
          <div class="om-HiFiBadges" id="np-signal-btn" title="Clic para inspeccionar Ruta de Señal de Audio">
            <span class="om-HiFiBadges__src tnum" id="np-format-src">-- kHz / -- bit</span>
            <span class="om-HiFiBadges__out" id="np-format-out">
              <span class="om-Dot"></span>
              <span id="np-output-text">Bit-Perfect</span>
            </span>
          </div>

          <div class="om-Volume">
            <button class="om-IconBtn" id="np-vol-icon" title="Silenciar / Activar audio">${icon('volume', { size: 17 })}</button>
            <div class="om-VolTrack" id="np-vol-track" style="cursor:pointer">
              <div class="om-VolFill" id="np-vol-fill" style="width:80%"></div>
            </div>
          </div>

          <div class="om-DrawerToggles">
            <button class="om-IconBtn" id="toggle-lyrics" title="Letras Sincronizadas (Ctrl+L)">${icon('lyrics', { size: 17 })}</button>
            <button class="om-IconBtn" id="toggle-dsp" title="Consola DSP y EQ (Ctrl+E)">${icon('dsp', { size: 17 })}</button>
            <button class="om-IconBtn" id="toggle-queue" title="Cola de Reproducción (Ctrl+Q)">${icon('queue', { size: 17 })}</button>
            <button class="om-IconBtn" id="toggle-fullscreen" title="Pantalla Completa / Modo Inmersivo (F11)">${icon('expand', { size: 16 })}</button>
          </div>
        </div>
      </footer>

      <!-- Popover de Ruta de Señal Hi-Fi -->
      <div id="signal-popover-slot"></div>
    `;
  }

  bindEvents() {
    const playBtn = this.container.querySelector('#np-play-btn');
    playBtn.addEventListener('click', async () => {
      const { playback } = this.store.state;
      if (playback.state === 'playing') {
        await ApiClient.pause().catch(console.error);
      } else {
        await ApiClient.play().catch(console.error);
      }
    });

    this.container.querySelector('#np-prev-btn').addEventListener('click', () => {
      ApiClient.previous().catch(console.error);
    });

    this.container.querySelector('#np-next-btn').addEventListener('click', () => {
      ApiClient.next().catch(console.error);
    });

    this.container.querySelector('#np-shuffle-btn').addEventListener('click', async () => {
      const { playback } = this.store.state;
      await ApiClient.setModes({ shuffle: !playback.shuffle }).catch(console.error);
    });

    this.container.querySelector('#np-repeat-btn').addEventListener('click', async () => {
      const { playback } = this.store.state;
      const modes = ['off', 'all', 'one'];
      const nextIdx = (modes.indexOf(playback.repeat) + 1) % modes.length;
      await ApiClient.setModes({ repeat: modes[nextIdx] }).catch(console.error);
    });

    // Seek interactivo con click y arrastre
    const seekBar = this.container.querySelector('#np-seek-bar');
    const handleSeek = async (e) => {
      const rect = seekBar.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const pct = clickX / rect.width;
      const { playback } = this.store.state;
      const targetSec = pct * (playback.durationSec || 0);

      this.updateSeekVisuals(pct, targetSec);
      await ApiClient.seek(targetSec).catch(console.error);
    };

    seekBar.addEventListener('click', handleSeek);

    // Control de volumen interactivo
    const volTrack = this.container.querySelector('#np-vol-track');
    volTrack.addEventListener('click', async (e) => {
      const rect = volTrack.getBoundingClientRect();
      const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      const vol = Math.max(0, Math.min(1, clickX / rect.width));
      await ApiClient.setVolume(vol).catch(console.error);
      this.store.setState({ playback: { volume: vol } });
    });

    // Toggle de Popover de Ruta de Señal
    const sigBtn = this.container.querySelector('#np-signal-btn');
    sigBtn.addEventListener('click', () => {
      this.showSignalPopover = !this.showSignalPopover;
      this.renderSignalPopover();
    });

    // Drawer Toggles
    const setupDrawerToggle = (btnId, drawerName) => {
      const btn = this.container.querySelector(`#${btnId}`);
      if (btn) {
        btn.addEventListener('click', () => {
          const cur = this.store.state.activeDrawer;
          this.store.setState({ activeDrawer: cur === drawerName ? null : drawerName });
        });
      }
    };
    setupDrawerToggle('toggle-queue', 'queue');
    setupDrawerToggle('toggle-dsp', 'dsp');

    const toggleImmersive = () => {
      this.store.setState({ immersiveOpen: !this.store.state.immersiveOpen });
    };

    const lyricsBtn = this.container.querySelector('#toggle-lyrics');
    if (lyricsBtn) lyricsBtn.addEventListener('click', toggleImmersive);

    const fullBtn = this.container.querySelector('#toggle-fullscreen');
    if (fullBtn) fullBtn.addEventListener('click', toggleImmersive);
  }

  updateSeekVisuals(pct, sec) {
    const fill = this.container.querySelector('#np-seek-fill');
    const thumb = this.container.querySelector('#np-seek-thumb');
    const curTime = this.container.querySelector('#np-time-cur');
    const pct100 = (pct * 100).toFixed(2);
    if (fill) fill.style.width = `${pct100}%`;
    if (thumb) thumb.style.left = `${pct100}%`;
    if (curTime) curTime.textContent = formatTime(sec);
  }

  update(state) {
    const { playback } = state;
    const trk = playback.track;

    // Transporte (Play/Pause Icon)
    const playBtn = this.container.querySelector('#np-play-btn');
    if (playBtn) {
      playBtn.innerHTML = playback.state === 'playing' ? icon('pause', { size: 18 }) : icon('play', { size: 18 });
    }

    // Shuffle / Repeat
    const shufBtn = this.container.querySelector('#np-shuffle-btn');
    if (shufBtn) {
      shufBtn.style.color = playback.shuffle ? 'var(--accent)' : 'var(--text-2)';
    }

    const repBtn = this.container.querySelector('#np-repeat-btn');
    if (repBtn) {
      repBtn.style.color = playback.repeat !== 'off' ? 'var(--accent)' : 'var(--text-2)';
      repBtn.title = `Modo Repetir: ${playback.repeat}`;
    }

    // Tiempos y barra de progreso limpia
    if (!this.isSeeking) {
      this.updateSeekVisuals(playback.progress, playback.positionSec);
      const endTime = this.container.querySelector('#np-time-end');
      if (endTime) endTime.textContent = formatTime(playback.durationSec);
    }

    // Volumen
    const volFill = this.container.querySelector('#np-vol-fill');
    if (volFill) {
      volFill.style.width = `${Math.round((playback.volume ?? 0.8) * 100)}%`;
    }

    // Metadatos de la pista actual
    const titleEl = this.container.querySelector('#np-title');
    const artistEl = this.container.querySelector('#np-artist');
    const coverWrap = this.container.querySelector('#np-cover-wrap');

    if (trk) {
      if (titleEl) titleEl.textContent = trk.title || trk.fileName;
      if (artistEl) artistEl.textContent = `${trk.artist || 'Artista Desconocido'} · ${trk.album || 'Álbum Desconocido'}`;

      if (coverWrap) {
        if (trk.coverId) {
          coverWrap.innerHTML = `<img src="/api/covers/${encodeURIComponent(trk.coverId)}" class="cover-svg" style="width:100%;height:100%;object-fit:cover" alt="Cover" />`;
        } else {
          coverWrap.innerHTML = coverSvg({ title: trk.title || '', artist: trk.artist || '', palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'], style: 'waves' });
        }
      }

      // Aplicar Color Thievery dinámico a la ventana si hay acento
      const win = document.querySelector('.om-Window');
      if (win) {
        applyAccent(win, '#e8a25c');
      }

      // Insignia Hi-Fi
      const srcEl = this.container.querySelector('#np-format-src');
      if (srcEl) {
        if (trk.codec === 'DSD') {
          srcEl.textContent = `DSD · ${(trk.sampleRate / 1000).toFixed(1)} kHz`;
        } else {
          srcEl.textContent = `${trk.codec || 'PCM'} · ${trk.bitDepth || 16}-bit / ${((trk.sampleRate || 44100) / 1000).toFixed(1)} kHz`;
        }
      }
    } else {
      if (titleEl) titleEl.textContent = 'Sin reproducción';
      if (artistEl) artistEl.textContent = 'Selecciona una canción o carpeta';
    }

    // Output Mode
    const outText = this.container.querySelector('#np-output-text');
    const dot = this.container.querySelector('.om-HiFiBadges__out .om-Dot');
    if (outText && dot) {
      const isDsp = playback.outputMode && playback.outputMode.includes('DSP');
      outText.textContent = `${playback.outputMode || 'Bit-Perfect'}`;
      if (isDsp) {
        outText.style.color = 'var(--warn)';
        dot.style.background = 'var(--warn)';
        dot.style.boxShadow = '0 0 8px var(--warn)';
      } else {
        outText.style.color = 'var(--ok)';
        dot.style.background = 'var(--ok)';
        dot.style.boxShadow = '0 0 8px var(--ok)';
      }
    }

    // Drawer Toggles Active States
    const syncActiveToggle = (id, name) => {
      const el = this.container.querySelector(`#${id}`);
      if (el) {
        if (state.activeDrawer === name) {
          el.style.background = 'var(--accent-soft)';
          el.style.color = 'var(--accent)';
        } else {
          el.style.background = '';
          el.style.color = '';
        }
      }
    };
    syncActiveToggle('toggle-queue', 'queue');
    syncActiveToggle('toggle-dsp', 'dsp');

    const lyBtn = this.container.querySelector('#toggle-lyrics');
    if (lyBtn) {
      lyBtn.style.background = state.immersiveOpen ? 'var(--accent-soft)' : '';
      lyBtn.style.color = state.immersiveOpen ? 'var(--accent)' : '';
    }
    const fsBtn = this.container.querySelector('#toggle-fullscreen');
    if (fsBtn) {
      fsBtn.style.background = state.immersiveOpen ? 'var(--accent-soft)' : '';
      fsBtn.style.color = state.immersiveOpen ? 'var(--accent)' : '';
    }
  }

  renderSignalPopover() {
    const slot = this.container.querySelector('#signal-popover-slot');
    if (!slot) return;
    if (!this.showSignalPopover) {
      slot.innerHTML = '';
      return;
    }

    const { playback } = this.store.state;
    const trk = playback.track || {
      codec: 'FLAC',
      bitDepth: 24,
      sampleRate: 192000,
      channels: 2,
    };

    slot.innerHTML = `
      <aside class="om-SignalPopover" style="position:fixed;right:24px;bottom:calc(var(--npbar-h) + 12px);z-index:100" aria-label="Ruta de señal de audio">
        <div class="om-SignalPopover__head">
          <div>
            <div class="om-SignalPopover__title">Ruta de Señal Hi-Fi</div>
            <div style="font-size:11px;color:var(--text-2)">Salida de Audio en Tiempo Real</div>
          </div>
          <span class="om-SignalBadge">
            <span class="om-Dot"></span>
            <span>${playback.outputMode || 'Bit-Perfect'}</span>
          </span>
        </div>

        <div class="om-SignalChain">
          <div class="om-SignalNode">
            <div class="om-SignalNode__icon">${icon('file', { size: 17 })}</div>
            <div class="om-SignalNode__body">
              <div class="om-SignalNode__name">
                <span>1. Archivo Fuente</span>
                <span class="om-SignalNode__tag tnum">${trk.codec || 'PCM'}</span>
              </div>
              <div class="om-SignalNode__detail tnum">${trk.bitDepth || 16}-bit / ${((trk.sampleRate || 44100) / 1000).toFixed(1)} kHz · ${trk.channels || 2} canales</div>
            </div>
          </div>

          <div class="om-SignalNode">
            <div class="om-SignalNode__icon">${icon('chip', { size: 17 })}</div>
            <div class="om-SignalNode__body">
              <div class="om-SignalNode__name">
                <span>2. Decodificador C11</span>
                <span class="om-SignalNode__tag">Zero-Copy</span>
              </div>
              <div class="om-SignalNode__detail">Motor nativo OurMusic C11 · Anillo en RAM 64 bloques</div>
            </div>
          </div>

          <div class="om-SignalNode">
            <div class="om-SignalNode__icon">${icon('dsp', { size: 17 })}</div>
            <div class="om-SignalNode__body">
              <div class="om-SignalNode__name">
                <span>3. Procesamiento DSP</span>
                <span class="om-SignalNode__tag">${playback.outputMode?.includes('DSP') ? 'Procesando' : 'Bypass'}</span>
              </div>
              <div class="om-SignalNode__detail">${playback.outputMode?.includes('DSP') ? 'EQ / Biquad activo' : 'Paso directo sin alteración (0 LSB error)'}</div>
            </div>
          </div>

          <div class="om-SignalNode">
            <div class="om-SignalNode__icon">${icon('output', { size: 17 })}</div>
            <div class="om-SignalNode__body">
              <div class="om-SignalNode__name">
                <span>4. Salida de Hardware</span>
                <span class="om-SignalNode__tag">Hardware</span>
              </div>
              <div class="om-SignalNode__detail tnum">${playback.device || 'ALSA / WASAPI'}</div>
            </div>
          </div>
        </div>
      </aside>
    `;
  }
}
