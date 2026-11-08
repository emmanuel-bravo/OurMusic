/*
 * OurMusic — Renderizador de Bocetos Hi-Fi (Ronda 2)
 * Nota aplicada: Barra de progreso lineal limpia (sin forma de onda/ondulaciones)
 * en la Now Playing Bar y en la vista inmersiva Ahora Suena.
 *
 * Pantallas de la Ronda 2 (1440×900 y variante compacta 1280×720):
 *   R2-01: Vista de Tabla de Pistas + Personalizador de Columnas
 *   R2-02: Cola de Reproducción en Dos Bloques (Panel Derecho Deslizable)
 *   R2-03: Consola DSP / EQ — Pestaña «EQ» (10 Faders + Curva + Pre-amp + Suavizado)
 *   R2-04: Consola DSP / EQ — Pestaña «Avanzado» (PEQ 16 + Crossfeed + ReplayGain + Convolver)
 *   R2-05: Vista Inmersiva «Ahora Suena» a Pantalla Completa con Letras Sincronizadas (.LRC)
 *   R2-06: Cuadrícula de Artistas (Avatares de Iniciales) y Géneros Locales
 */
import { icon } from './icons.js';
import { coverSvg, applyAccent, avatarColor, initials } from './visuals.js';
import {
  ALBUMS,
  NOW_PLAYING,
  ALL_TRACKS,
  QUEUE_UP_NEXT,
  QUEUE_CONTEXT,
  EQ_10_BANDS,
  PEQ_NODES,
  SYNCED_LYRICS,
  ARTISTS_LIST,
  GENRES_LIST,
  PLAYLISTS,
  SMART_LISTS,
  formatBadge,
  formatLong,
} from './data.js';
import { buildWindowHTML as buildRound1WindowHTML } from './round1.js';

function renderSidebar(activeNav = 'tracks') {
  const libItems = [
    { id: 'tracks', icon: 'note', label: 'Pistas', count: '2,480' },
    { id: 'albums', icon: 'disc', label: 'Álbumes', count: '186' },
    { id: 'artists', icon: 'artist', label: 'Artistas', count: '94' },
    { id: 'genres', icon: 'genre', label: 'Géneros', count: '18' },
    { id: 'composers', icon: 'composer', label: 'Compositores', count: '42' },
    { id: 'folders', icon: 'folder', label: 'Carpetas locales', count: '3' },
  ];

  return `
    <aside class="om-Sidebar">
      <div class="om-Brand">
        <div class="om-Brand__left">
          <div class="om-LogoSlot" title="Espacio reservado para tu logotipo">LOGO</div>
          <span class="om-Brand__title">OurMusic</span>
        </div>
        <button class="om-IconBtn" title="Colapsar barra lateral (Ctrl+B)">${icon('sidebar', { size: 17 })}</button>
      </div>

      <nav class="om-NavGroup">
        <div class="om-NavGroup__label"><span>Biblioteca</span></div>
        ${libItems
          .map(
            (it) => `
          <div class="om-NavItem ${activeNav === it.id ? 'is-active' : ''}">
            <div class="om-NavItem__left">
              ${icon(it.icon, { size: 18 })}
              <span class="om-NavItem__text">${it.label}</span>
            </div>
            <span class="om-NavItem__count tnum">${it.count}</span>
          </div>`,
          )
          .join('')}
      </nav>

      <nav class="om-NavGroup">
        <div class="om-NavGroup__label">
          <span>Listas Inteligentes</span>
          ${icon('plus', { size: 14 })}
        </div>
        ${SMART_LISTS.map(
          (name) => `
          <div class="om-NavItem">
            <div class="om-NavItem__left">
              ${icon('smart', { size: 17 })}
              <span class="om-NavItem__text">${name}</span>
            </div>
          </div>`,
        ).join('')}
      </nav>

      <nav class="om-NavGroup">
        <div class="om-NavGroup__label">
          <span>Mis Listas</span>
          ${icon('plus', { size: 14 })}
        </div>
        ${PLAYLISTS.map(
          (name) => `
          <div class="om-NavItem">
            <div class="om-NavItem__left">
              ${icon('playlist', { size: 17 })}
              <span class="om-NavItem__text">${name}</span>
            </div>
          </div>`,
        ).join('')}
      </nav>

      <div class="om-Sidebar__footer">
        <div class="om-WatcherPill">
          <span class="om-Dot"></span>
          <span>SQLite WAL · Vigilancia activa</span>
        </div>
        <div class="om-NavItem ${activeNav === 'dsp' ? 'is-active' : ''}">
          <div class="om-NavItem__left">
            ${icon('dsp', { size: 18 })}
            <span class="om-NavItem__text">Consola DSP y EQ</span>
          </div>
          <span class="om-NavItem__count">${activeNav === 'dsp' ? 'Activo' : 'Bypass'}</span>
        </div>
        <div class="om-NavItem">
          <div class="om-NavItem__left">
            ${icon('settings', { size: 18 })}
            <span class="om-NavItem__text">Ajustes de Audio</span>
          </div>
        </div>
      </div>
    </aside>
  `;
}

function renderTopbar({ crumbs, viewMode = 'list', sortLabel = 'Título ↑' }) {
  const crumbHtml = crumbs
    .map((c, idx) => {
      const isLast = idx === crumbs.length - 1;
      return `<span class="om-Crumb ${isLast ? 'is-current' : ''}">${c}</span>${
        !isLast ? '<span class="om-CrumbSep">/</span>' : ''
      }`;
    })
    .join('');

  return `
    <header class="om-Topbar">
      <div class="om-Breadcrumbs">
        <div class="om-HistoryBtns">
          <button class="om-IconBtn" title="Atrás (Alt+←)">${icon('chevronLeft', { size: 17 })}</button>
          <button class="om-IconBtn" title="Adelante (Alt+→)">${icon('chevronRight', { size: 17 })}</button>
        </div>
        ${crumbHtml}
      </div>

      <div class="om-SearchBox">
        ${icon('search', { size: 16 })}
        <div class="om-SearchBox__input">
          <span class="om-SearchBox__placeholder">Buscar pistas, álbumes, artistas o letras…</span>
        </div>
        <kbd class="om-Kbd">Ctrl+F</kbd>
      </div>

      <div class="om-Topbar__right">
        <div class="om-Segmented">
          <div class="om-Segmented__btn ${viewMode === 'grid' ? 'is-active' : ''}">${icon('grid', { size: 15 })}<span>Cuadrícula</span></div>
          <div class="om-Segmented__btn ${viewMode === 'list' ? 'is-active' : ''}">${icon('listView', { size: 15 })}<span>Tabla</span></div>
        </div>
        <div class="om-Pill">${icon('sort', { size: 14 })}<span>${sortLabel}</span></div>
      </div>
    </header>
  `;
}

/**
 * Now Playing Bar actualizada en Ronda 2:
 * Usa la barra de progreso lineal limpia (`.om-SeekBar`) sin ondulaciones/waveform.
 */
function renderCleanNowPlayingBar({ activeDrawer = '', dspActive = false } = {}) {
  const pct = Math.round(NOW_PLAYING.progress * 100);

  return `
    <footer class="om-NowPlaying">
      <div class="om-NP__track">
        <div class="om-NP__art">${coverSvg(NOW_PLAYING.album)}</div>
        <div class="om-NP__meta">
          <div class="om-NP__titleRow">
            <span class="om-NP__title">${NOW_PLAYING.title}</span>
            <button class="om-IconBtn" title="Favorito">${icon('heartFill', { size: 15 })}</button>
          </div>
          <div class="om-NP__artist">${NOW_PLAYING.artist} · ${NOW_PLAYING.album.title}</div>
        </div>
      </div>

      <div class="om-NP__center">
        <div class="om-Transport">
          <button class="om-IconBtn" title="Aleatorio (S)">${icon('shuffle', { size: 16 })}</button>
          <button class="om-IconBtn" title="Anterior (Ctrl+←)">${icon('prev', { size: 18 })}</button>
          <button class="om-PlayBtn" title="Pausar (Espacio)">${icon('pause', { size: 18 })}</button>
          <button class="om-IconBtn" title="Siguiente (Ctrl+→)">${icon('next', { size: 18 })}</button>
          <button class="om-IconBtn" title="Repetir (R)">${icon('repeat', { size: 16 })}</button>
        </div>
        <div class="om-SeekRow">
          <span class="om-Time tnum">${NOW_PLAYING.elapsed}</span>
          <div class="om-SeekBar" title="Barra de progreso lineal limpia">
            <div class="om-SeekFill" style="width:${pct}%"></div>
            <div class="om-SeekThumb" style="left:${pct}%"></div>
          </div>
          <span class="om-Time is-end tnum">${NOW_PLAYING.duration}</span>
        </div>
      </div>

      <div class="om-NP__right">
        <div class="om-HiFiBadges" title="Clic para inspeccionar Ruta de Señal">
          <span class="om-HiFiBadges__src tnum">${formatLong(NOW_PLAYING.album)}</span>
          <span class="om-HiFiBadges__out" style="${dspActive ? 'color:var(--warn)' : ''}">
            <span class="om-Dot" style="${dspActive ? 'background:var(--warn);box-shadow:0 0 8px var(--warn)' : ''}"></span>
            <span>${dspActive ? `${NOW_PLAYING.output} · DSP 64-bit` : `${NOW_PLAYING.output} · Bit-Perfect`}</span>
          </span>
        </div>

        <div class="om-Volume">
          <button class="om-IconBtn" title="Volumen">${icon('volume', { size: 17 })}</button>
          <div class="om-VolTrack"><div class="om-VolFill"></div></div>
        </div>

        <div class="om-DrawerToggles">
          <button class="om-IconBtn" style="${activeDrawer === 'lyrics' ? 'background:var(--accent-soft);color:var(--accent)' : ''}" title="Letras sincronizadas (Ctrl+L)">${icon('lyrics', { size: 17 })}</button>
          <button class="om-IconBtn" style="${activeDrawer === 'dsp' ? 'background:var(--accent-soft);color:var(--accent)' : ''}" title="Consola DSP / EQ (Ctrl+E)">${icon('dsp', { size: 17 })}</button>
          <button class="om-IconBtn" style="${activeDrawer === 'queue' ? 'background:var(--accent-soft);color:var(--accent)' : ''}" title="Cola de reproducción (Ctrl+Q)">${icon('queue', { size: 17 })}</button>
          <button class="om-IconBtn" title="Vista Ahora Suena a pantalla completa (F11)">${icon('expand', { size: 16 })}</button>
        </div>
      </div>
    </footer>
  `;
}

/* ---------------- R2-01: TABLA DE PISTAS + SELECTOR DE COLUMNAS ---------------- */
function renderTracksTableView({ isCompact = false, showColPicker = true } = {}) {
  const rows = isCompact ? ALL_TRACKS.slice(0, 9) : ALL_TRACKS;
  const cols = [
    { name: 'Título y Carátula', on: true },
    { name: 'Artista', on: true },
    { name: 'Álbum', on: true },
    { name: 'Formato (Bits / kHz)', on: true },
    { name: 'Duración', on: true },
    { name: 'Año', on: true },
    { name: 'Sonoridad (LUFS)', on: !isCompact },
    { name: 'Género', on: false },
    { name: 'Compositor', on: false },
    { name: 'Bitrate (kbps)', on: false },
    { name: 'Ruta de archivo', on: false },
  ];

  return `
    <div class="om-Content">
      <div class="om-SectionToolbar">
        <div class="om-SectionToolbar__title">
          <h1>Todas las pistas</h1>
          <span class="om-SectionToolbar__sub tnum">2,480 pistas indexadas en SQLite · Paginación O(1)</span>
        </div>
        <div class="om-FilterPills">
          <span class="om-Pill is-active">Todas (2,480)</span>
          <span class="om-Pill">Hi-Res / DSD (642)</span>
          <span class="om-Pill">Lossless (2,110)</span>
          <span class="om-Pill">${icon('columns', { size: 14 })}<span>Columnas</span></span>
        </div>
      </div>

      <div class="om-DataGridWrap">
        <table class="om-DataGrid">
          <thead>
            <tr>
              <th style="width:42px">#</th>
              <th class="is-sorted">Título ↓</th>
              <th>Artista</th>
              <th>Álbum</th>
              <th style="width:92px">Año</th>
              <th style="width:126px">Formato</th>
              ${!isCompact ? '<th style="width:108px">LUFS</th>' : ''}
              <th style="width:76px;text-align:right">${icon('clock', { size: 14 })}</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const b = formatBadge(r.album);
                const chipLabel =
                  r.album.codec === 'DSD'
                    ? r.album.dsd
                    : `${r.album.codec} ${b.label}`;
                return `
                  <tr class="${r.playing ? 'is-playing' : ''}">
                    <td class="tnum">${r.playing ? icon('bars', { size: 15 }) : r.idx}</td>
                    <td>
                      <div class="om-TrackCell">
                        <div class="om-MiniThumb">${coverSvg(r.album)}</div>
                        <span class="om-TrackTitle">${r.title}</span>
                        ${r.lyrics ? '<span class="om-TagMini">LRC</span>' : ''}
                      </div>
                    </td>
                    <td>${r.artist}</td>
                    <td>${r.album.title}</td>
                    <td class="tnum">${r.year}</td>
                    <td><span class="om-FormatChip tnum ${b.hires ? 'is-hires' : ''}">${chipLabel}</span></td>
                    ${!isCompact ? `<td class="tnum">${r.lufs} LUFS</td>` : ''}
                    <td class="tnum" style="text-align:right">${r.dur}</td>
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>

        ${
          showColPicker
            ? `
          <aside class="om-ColPicker" aria-label="Columnas visibles (clic derecho en cabecera)">
            <div class="om-ColPicker__title">Columnas de la tabla</div>
            ${cols
              .map(
                (c) => `
              <div class="om-ColPicker__item ${c.on ? 'is-checked' : ''}">
                <span>${c.name}</span>
                <span class="om-CheckBox">${c.on ? icon('check', { size: 11 }) : ''}</span>
              </div>`,
              )
              .join('')}
          </aside>
        `
            : ''
        }
      </div>
    </div>
  `;
}

/* ---------------- R2-02: COLA DE REPRODUCCIÓN EN DOS BLOQUES ---------------- */
function renderQueueDrawer() {
  return `
    <aside class="om-Drawer" aria-label="Cola de reproducción">
      <div class="om-Drawer__head">
        <div class="om-Drawer__title">
          ${icon('queue', { size: 18 })}
          <span>Cola de Reproducción</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <span class="om-Pill" style="padding:3px 9px;font-size:11px">Historial (4) ▾</span>
          <button class="om-IconBtn" title="Cerrar panel">${icon('close', { size: 16 })}</button>
        </div>
      </div>

      <div class="om-Drawer__body">
        <div class="om-QueueSection">
          <div class="om-QueueSection__head">
            <span>Reproduciendo ahora</span>
            <span class="tnum">Pista 3 de 9</span>
          </div>
          <div class="om-QueueItem is-current">
            <div class="om-MiniThumb" style="width:36px;height:36px">${coverSvg(NOW_PLAYING.album)}</div>
            <div class="om-QueueItem__meta">
              <div class="om-QueueItem__title">${NOW_PLAYING.title}</div>
              <div class="om-QueueItem__sub">${NOW_PLAYING.artist} · FLAC 24/192</div>
            </div>
            <span class="tnum" style="font-size:11px;color:var(--accent);font-weight:600">${NOW_PLAYING.elapsed} / ${NOW_PLAYING.duration}</span>
          </div>
        </div>

        <div class="om-QueueSection">
          <div class="om-QueueSection__head">
            <span>A continuación (Prioridad)</span>
            <span class="om-QueueSection__badge">2 añadidas · Limpiar</span>
          </div>
          ${QUEUE_UP_NEXT.map(
            (q, i) => `
            <div class="om-QueueItem ${i === 0 ? 'is-dragging' : ''}">
              <span class="om-QueueItem__grip" title="Arrastrar para reordenar">${icon('grip', { size: 15 })}</span>
              <div class="om-MiniThumb">${coverSvg(q.album)}</div>
              <div class="om-QueueItem__meta">
                <div class="om-QueueItem__title">${q.title}</div>
                <div class="om-QueueItem__sub">${q.artist} · <span style="color:var(--accent)">${q.source}</span></div>
              </div>
              <span class="tnum" style="font-size:11px;color:var(--text-3)">${q.dur}</span>
              <button class="om-IconBtn" style="width:24px;height:24px" title="Quitar de la cola">${icon('close', { size: 13 })}</button>
            </div>`,
          ).join('')}
        </div>

        <div class="om-QueueSection">
          <div class="om-QueueSection__head">
            <span>Siguiente de: Nocturnes for Glass</span>
            <span class="tnum">5 pistas</span>
          </div>
          ${QUEUE_CONTEXT.map(
            (q) => `
            <div class="om-QueueItem">
              <span class="om-QueueItem__grip">${icon('grip', { size: 15 })}</span>
              <div class="om-MiniThumb">${coverSvg(q.album)}</div>
              <div class="om-QueueItem__meta">
                <div class="om-QueueItem__title">${q.title}</div>
                <div class="om-QueueItem__sub">${q.artist} · FLAC ${q.badge}</div>
              </div>
              <span class="tnum" style="font-size:11px;color:var(--text-3)">${q.dur}</span>
              <button class="om-IconBtn" style="width:24px;height:24px" title="Quitar">${icon('close', { size: 13 })}</button>
            </div>`,
          ).join('')}
        </div>
      </div>
    </aside>
  `;
}

/* ---------------- R2-03 y R2-04: CONSOLA DSP / ECUALIZADOR ---------------- */
function renderFaderColumn({ label, gain, isPreamp = false }) {
  // Mapeo de -12..+12 dB a 0..100% (50% = 0 dB)
  const clamped = Math.max(-12, Math.min(12, gain));
  const pctFromTop = 50 - (clamped / 12) * 42;
  const fillTop = Math.min(50, pctFromTop);
  const fillHeight = Math.abs(50 - pctFromTop);
  const sign = gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1);

  return `
    <div class="om-FaderCol ${isPreamp ? 'is-preamp' : ''}">
      <span class="om-FaderGain tnum">${sign}</span>
      <div class="om-FaderTrack">
        <div class="om-FaderZero"></div>
        <div class="om-FaderFill" style="top:${fillTop}%;height:${fillHeight}%"></div>
        <div class="om-FaderKnob" style="top:${pctFromTop}%"></div>
      </div>
      <span class="om-FaderFreq tnum">${label}</span>
    </div>
  `;
}

function renderDspDrawer({ tab = 'eq' } = {}) {
  return `
    <aside class="om-Drawer" aria-label="Consola DSP de 64 bits">
      <div class="om-Drawer__head">
        <div class="om-Drawer__title">
          ${icon('dsp', { size: 18 })}
          <span>Consola DSP 64-bit</span>
        </div>
        <div class="om-Segmented">
          <div class="om-Segmented__btn ${tab === 'eq' ? 'is-active' : ''}"><span>EQ 10 Bandas</span></div>
          <div class="om-Segmented__btn ${tab === 'adv' ? 'is-active' : ''}"><span>Avanzado</span></div>
        </div>
      </div>

      ${
        tab === 'eq'
          ? `
        <div class="om-Drawer__body">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
            <div class="om-Pill is-active">Perfil: Jazz Cálido ▾</div>
            <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2)">
              <span>Bypass</span>
              <span class="om-Toggle"></span>
            </div>
          </div>

          <div class="om-EqCurveBox">
            <div class="om-EqCurveBox__head">
              <span>Respuesta Biquad RBJ (64-bit float)</span>
              <span class="tnum" style="color:var(--accent)">Pre-amp: -2.5 dB</span>
            </div>
            <svg class="om-EqCurveSvg" viewBox="0 0 340 86" preserveAspectRatio="none">
              <defs>
                <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stop-color="rgba(227,168,107,0.38)" />
                  <stop offset="1" stop-color="rgba(227,168,107,0.0)" />
                </linearGradient>
              </defs>
              <line x1="0" y1="43" x2="340" y2="43" stroke="rgba(255,238,214,0.14)" stroke-dasharray="3 3" />
              <path d="M 0 30 C 35 20, 75 24, 115 47 C 155 56, 195 36, 245 25 C 285 22, 315 28, 340 33 L 340 86 L 0 86 Z" fill="url(#eqFill)" />
              <path d="M 0 30 C 35 20, 75 24, 115 47 C 155 56, 195 36, 245 25 C 285 22, 315 28, 340 33" fill="none" stroke="var(--accent)" stroke-width="2.2" />
            </svg>
          </div>

          <div class="om-FadersGrid">
            ${renderFaderColumn({ label: 'Pre', gain: -2.5, isPreamp: true })}
            ${EQ_10_BANDS.map((b) => renderFaderColumn({ label: b.freq, gain: b.gain })).join('')}
          </div>

          <div class="om-DspSwitchRow">
            <div>
              <div style="font-weight:600;color:var(--text-1)">Suavizado de Parámetros (Smoothing)</div>
              <div style="font-size:11px;color:var(--text-2)"> Rampa exponencial τ = 15 ms libre de clics</div>
            </div>
            <span class="om-Toggle is-on"></span>
          </div>

          <div class="om-DspSwitchRow">
            <div>
              <div style="font-weight:600;color:var(--text-1)">Limitador Suave Padé Anti-Clipping</div>
              <div style="font-size:11px;color:var(--text-2)">Protege picos > -0.1 dBFS tras ecualización</div>
            </div>
            <span class="om-Toggle is-on"></span>
          </div>
        </div>
      `
          : `
        <div class="om-Drawer__body">
          <div class="om-DspModuleCard">
            <div class="om-DspModuleCard__head">
              <span>PEQ Paramétrico de 16 Bandas</span>
              <span class="om-Toggle is-on"></span>
            </div>
            <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">
              ${PEQ_NODES.map(
                (n) => `
                <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;padding:4px 6px;background:var(--bg-1);border-radius:5px">
                  <span><strong>#${n.idx}</strong> · ${n.type}</span>
                  <span class="tnum" style="color:var(--accent)">${n.freq} · ${n.gain} · Q=${n.q}</span>
                </div>`,
              ).join('')}
            </div>
          </div>

          <div class="om-DspModuleCard">
            <div class="om-DspModuleCard__head">
              <span>${icon('headphones', { size: 15 })} Crossfeed Bauer / Meier (Auriculares)</span>
              <span class="om-Toggle is-on"></span>
            </div>
            <div class="om-DspModuleCard__sub tnum">
              <span>Corte ILD: 650 Hz · Nivel: 4.5 dB</span>
              <span>Retardo ITD: 320 µs</span>
            </div>
          </div>

          <div class="om-DspModuleCard">
            <div class="om-DspModuleCard__head">
              <span>Convolver FIR Híbrido FFT (Latencia Cero)</span>
              <span class="om-Toggle is-on"></span>
            </div>
            <div class="om-DspModuleCard__sub tnum">
              <span>IR: Sennheiser_HD650_LinearPhase.wav</span>
              <span>Mezcla: 100 %</span>
            </div>
          </div>

          <div class="om-DspModuleCard">
            <div class="om-DspModuleCard__head">
              <span>ReplayGain 2.0 (ITU-R BS.1770-4 / R128)</span>
              <span class="om-Toggle is-on"></span>
            </div>
            <div class="om-DspModuleCard__sub tnum">
              <span>Modo: Álbum (-18 LUFS)</span>
              <span>True-Peak Guard 4x</span>
            </div>
          </div>

          <div class="om-DspModuleCard">
            <div class="om-DspModuleCard__head">
              <span>Resampler Polifásico Kaiser-Sinc 64-bit</span>
              <span class="om-SignalBadge" style="padding:1px 7px;font-size:10px">Bypass Nativo</span>
            </div>
            <div class="om-DspModuleCard__sub tnum">
              <span>1024 ramas · > 130 dB stop-band</span>
              <span>Tasa objetivo: Nativa</span>
            </div>
          </div>
        </div>
      `
      }
    </aside>
  `;
}

/* ---------------- R2-05: VISTA INMERSIVA AHORA SUENA + LETRAS (.LRC) ---------------- */
function renderImmersiveLyricsView() {
  const alb = NOW_PLAYING.album;
  const pct = Math.round(NOW_PLAYING.progress * 100);

  return `
    <div class="om-Immersive">
      <header class="om-Immersive__top">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="om-LogoSlot">LOGO</div>
          <div>
            <div style="font-size:12px;font-weight:700;color:var(--text-1)">Ahora Suena · Modo Sala de Escucha</div>
            <div style="font-size:11px;color:var(--text-2)" class="tnum">${formatLong(alb)} · ${NOW_PLAYING.output} · Bit-Perfect</div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <span class="om-Pill is-active">Letras Sincronizadas (.LRC)</span>
          <button class="om-BtnGhost">${icon('close', { size: 14 })}<span>Salir de pantalla completa (Esc)</span></button>
        </div>
      </header>

      <div class="om-Immersive__stage">
        <div class="om-Immersive__vinyl">
          <div class="om-Immersive__art">${coverSvg(alb)}</div>
          <div>
            <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.025em">${NOW_PLAYING.title}</h1>
            <div style="font-size:15px;color:var(--text-2);margin-top:4px">${NOW_PLAYING.artist} — ${alb.title} (${alb.year})</div>
          </div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
            <div class="om-SeekRow" style="max-width:100%">
              <span class="om-Time tnum">${NOW_PLAYING.elapsed}</span>
              <div class="om-SeekBar">
                <div class="om-SeekFill" style="width:${pct}%"></div>
                <div class="om-SeekThumb" style="left:${pct}%"></div>
              </div>
              <span class="om-Time is-end tnum">${NOW_PLAYING.duration}</span>
            </div>
            <div class="om-Transport" style="justify-content:center;margin-top:4px">
              <button class="om-IconBtn">${icon('shuffle', { size: 17 })}</button>
              <button class="om-IconBtn">${icon('prev', { size: 20 })}</button>
              <button class="om-PlayBtn" style="width:44px;height:44px">${icon('pause', { size: 20 })}</button>
              <button class="om-IconBtn">${icon('next', { size: 20 })}</button>
              <button class="om-IconBtn">${icon('repeat', { size: 17 })}</button>
            </div>
          </div>
        </div>

        <div class="om-LyricsStage" aria-label="Letras sincronizadas">
          ${SYNCED_LYRICS.map(
            (line) => `
            <div class="om-LyricLine ${line.state === 'past' ? 'is-past' : line.state === 'active' ? 'is-active' : ''}">
              <span>${line.text}</span>
              <span class="om-LyricTime tnum">${line.time}</span>
            </div>`,
          ).join('')}
        </div>
      </div>

      <footer style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-3)">
        <span>Haz clic en cualquier verso para saltar exactamente a su marca de tiempo</span>
        <span class="tnum">Color Thievery AA · Contraste verificado ≥ 4.5:1</span>
      </footer>
    </div>
  `;
}

/* ---------------- R2-06: ARTISTAS (AVATARES DE INICIALES) Y GÉNEROS ---------------- */
function renderArtistsAndGenresContent({ isCompact = false } = {}) {
  const artists = isCompact ? ARTISTS_LIST.slice(0, 6) : ARTISTS_LIST;
  return `
    <div class="om-Content">
      <div class="om-SectionToolbar">
        <div class="om-SectionToolbar__title">
          <h1>Artistas y Géneros</h1>
          <span class="om-SectionToolbar__sub tnum">94 artistas · Avatares generados con iniciales (100 % offline)</span>
        </div>
        <div class="om-FilterPills">
          <span class="om-Pill is-active">Artistas del álbum</span>
          <span class="om-Pill">Compositores (42)</span>
          <span class="om-Pill">Géneros (18)</span>
        </div>
      </div>

      <div class="om-ArtistGrid">
        ${artists
          .map(
            (ar) => `
          <article class="om-ArtistCard">
            <div class="om-ArtistCard__avatar" style="background:${avatarColor(ar.name)}">${initials(ar.name)}</div>
            <div class="om-AlbumCard__title">${ar.name}</div>
            <div class="om-AlbumCard__sub tnum" style="justify-content:center">
              <span>${ar.albums} álb · ${ar.tracks} pistas</span>
            </div>
            <span class="om-FormatChip tnum" style="font-size:10px">${ar.badge}</span>
          </article>`,
          )
          .join('')}
      </div>

      <div class="om-SectionToolbar" style="margin-top:4px">
        <div class="om-SectionToolbar__title">
          <h2 style="font-size:18px;font-weight:700">Géneros en tu Biblioteca</h2>
        </div>
      </div>

      <div class="om-GenreGrid">
        ${GENRES_LIST.map(
          (g) => `
          <div class="om-GenreCard" style="background:linear-gradient(135deg, ${g.color}33, var(--bg-2));border-color:${g.color}66">
            <div>
              <div style="font-size:15px;font-weight:700;color:var(--text-1)">${g.name}</div>
              <div style="font-size:12px;color:var(--text-2);margin-top:2px" class="tnum">${g.albums} álbumes · ${g.tracks} pistas</div>
            </div>
            <span class="om-IconBtn" style="background:rgba(0,0,0,0.28);color:var(--text-1)">${icon('play', { size: 15 })}</span>
          </div>`,
        ).join('')}
      </div>
    </div>
  `;
}

export function buildRound2WindowHTML(screenId, size = '1440') {
  const isCompact = size === '1280';
  const sizeCls = isCompact ? 'is-1280' : '';
  const accentHex = NOW_PLAYING.album.palette[1];

  if (screenId === 'tracks-table') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('tracks')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas'], viewMode: 'list', sortLabel: 'Título ↓' })}
          ${renderTracksTableView({ isCompact, showColPicker: true })}
        </main>
        ${renderCleanNowPlayingBar()}
      </div>
    `;
  }

  if (screenId === 'queue-drawer') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('tracks')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas'], viewMode: 'list' })}
          <div class="om-MainSplit">
            ${renderTracksTableView({ isCompact: true, showColPicker: false })}
            ${renderQueueDrawer()}
          </div>
        </main>
        ${renderCleanNowPlayingBar({ activeDrawer: 'queue' })}
      </div>
    `;
  }

  if (screenId === 'dsp-eq') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('dsp')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas'], viewMode: 'list' })}
          <div class="om-MainSplit">
            ${renderTracksTableView({ isCompact: true, showColPicker: false })}
            ${renderDspDrawer({ tab: 'eq' })}
          </div>
        </main>
        ${renderCleanNowPlayingBar({ activeDrawer: 'dsp', dspActive: true })}
      </div>
    `;
  }

  if (screenId === 'dsp-adv') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('dsp')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas'], viewMode: 'list' })}
          <div class="om-MainSplit">
            ${renderTracksTableView({ isCompact: true, showColPicker: false })}
            ${renderDspDrawer({ tab: 'adv' })}
          </div>
        </main>
        ${renderCleanNowPlayingBar({ activeDrawer: 'dsp', dspActive: true })}
      </div>
    `;
  }

  if (screenId === 'immersive-lyrics') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderImmersiveLyricsView()}
      </div>
    `;
  }

  // artists-genres
  return `
    <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
      ${renderSidebar('artists')}
      <main class="om-Main">
        ${renderTopbar({ crumbs: ['Biblioteca', 'Artistas y Géneros'], viewMode: 'grid', sortLabel: 'Nombre ↑' })}
        ${renderArtistsAndGenresContent({ isCompact })}
      </main>
      ${renderCleanNowPlayingBar()}
    </div>
  `;
}

const ROUND2_SCREENS = [
  { id: 'tracks-table', code: 'R2-01', title: 'Vista de Tabla de Pistas + Personalizador de Columnas' },
  { id: 'queue-drawer', code: 'R2-02', title: 'Cola de Reproducción en Dos Bloques (Panel Derecho Deslizable)' },
  { id: 'dsp-eq', code: 'R2-03', title: 'Consola DSP / EQ — Pestaña «EQ 10 Bandas» (Faders + Curva + Pre-amp)' },
  { id: 'dsp-adv', code: 'R2-04', title: 'Consola DSP / EQ — Pestaña «Avanzado» (PEQ 16 + Crossfeed + Convolver + R128)' },
  { id: 'immersive-lyrics', code: 'R2-05', title: 'Vista Inmersiva «Ahora Suena» a Pantalla Completa con Letras Sincronizadas (.LRC)' },
  { id: 'artists-genres', code: 'R2-06', title: 'Cuadrícula de Artistas (Avatares de Iniciales) y Géneros Locales' },
];

const ROUND1_SCREENS = [
  { id: 'albums', code: 'R1-01', title: 'Álbumes en Cuadrícula + Sidebar + Now Playing Bar' },
  { id: 'search', code: 'R1-02', title: 'Búsqueda Global Instantánea Desplegada (SQLite FTS5 + Letras)' },
  { id: 'album-detail', code: 'R1-03', title: 'Vista Detallada de Álbum (Hero + Color Thievery + Pistas)' },
  { id: 'signal-path', code: 'R1-04', title: 'Popover «Ruta de Señal» Bit-Perfect sobre Reproductor' },
];

export function mountProtoSuite(root) {
  let currentRound = 'r2'; // 'r2' | 'r1'
  let currentView = 'all';
  let currentSize = 'both'; // 'both' | '1440' | '1280'

  function render() {
    const activeList = currentRound === 'r2' ? ROUND2_SCREENS : ROUND1_SCREENS;
    const screensToRender =
      currentView === 'all' ? activeList : activeList.filter((s) => s.id === currentView);
    const sizesToRender = currentSize === 'both' ? ['1440', '1280'] : [currentSize];

    const artboards = [];
    for (const s of screensToRender) {
      for (const sz of sizesToRender) {
        const dim = sz === '1440' ? '1440 × 900 (Escritorio)' : '1280 × 720 (Compacto · Sidebar colapsada)';
        const html =
          currentRound === 'r2'
            ? buildRound2WindowHTML(s.id, sz)
            : buildRound1WindowHTML(s.id, sz);
        artboards.push(`
          <section class="artboard-Wrap">
            <div class="artboard-Header">
              <span><strong>${s.code} (${sz}w)</strong> — ${s.title}</span>
              <span class="artboard-Meta tnum">${dim}</span>
            </div>
            ${html}
          </section>
        `);
      }
    }

    root.innerHTML = `
      <header class="proto-Dock">
        <div class="proto-Dock__brand">
          <span>OurMusic — Bocetos Hi-Fi</span>
          <button class="proto-Tab ${currentRound === 'r2' ? 'is-active' : ''}" data-round="r2">Ronda 2 (6 pantallas)</button>
          <button class="proto-Tab ${currentRound === 'r1' ? 'is-active' : ''}" data-round="r1">Ronda 1 (4 pantallas)</button>
        </div>

        <div class="proto-Dock__tabs">
          <button class="proto-Tab ${currentView === 'all' ? 'is-active' : ''}" data-view="all">Todas (${activeList.length})</button>
          ${activeList
            .map(
              (s) => `
            <button class="proto-Tab ${currentView === s.id ? 'is-active' : ''}" data-view="${s.id}">
              ${s.code}
            </button>`,
            )
            .join('')}
        </div>

        <div class="proto-Dock__sizes">
          <button class="proto-Tab ${currentSize === 'both' ? 'is-active' : ''}" data-size="both">1440 + 1280</button>
          <button class="proto-Tab ${currentSize === '1440' ? 'is-active' : ''}" data-size="1440">Solo 1440×900</button>
          <button class="proto-Tab ${currentSize === '1280' ? 'is-active' : ''}" data-size="1280">Solo 1280×720</button>
        </div>
      </header>

      <main class="proto-Canvas">
        ${artboards.join('')}
      </main>
    `;

    root.querySelectorAll('.om-Window[data-accent]').forEach((win) => {
      applyAccent(win, win.getAttribute('data-accent'));
    });

    root.querySelectorAll('[data-round]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentRound = btn.getAttribute('data-round');
        currentView = 'all';
        render();
      });
    });

    root.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentView = btn.getAttribute('data-view');
        render();
      });
    });

    root.querySelectorAll('[data-size]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentSize = btn.getAttribute('data-size');
        render();
      });
    });
  }

  render();
}
