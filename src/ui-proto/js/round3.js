/*
 * OurMusic — Renderizador de Bocetos Hi-Fi (Ronda 3 — Refinamiento y Flujos Completos)
 * Pantallas de la Ronda 3 (1440×900 y variante compacta 1280×720):
 *   R3-01: Inspector de Metadatos y Editor de Etiquetas (ID3v2 / Vorbis / MP4 ilst + Edición por lotes)
 *   R3-02: Menú Contextual de Clic Derecho + Tooltips con Atajos + Notificaciones Efímeras (Toasts)
 *   R3-03: Estados Vacíos y Onboarding Inicial («Añade tu primera carpeta de música local»)
 *   R3-04: Explorador de Carpetas Locales en Crudo con Migas de Pan Profundas
 *   R3-05: Hoja Modal de Atajos de Teclado (?) e Integración Multimedia (MPRIS / SMTC)
 */
import { icon } from './icons.js';
import { coverSvg, applyAccent } from './visuals.js';
import {
  ALBUMS,
  NOW_PLAYING,
  ALL_TRACKS,
  PLAYLISTS,
  SMART_LISTS,
  formatBadge,
  formatLong,
} from './data.js';
import { buildWindowHTML as buildRound1WindowHTML } from './round1.js';
import { buildRound2WindowHTML } from './round2.js';

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
            <span class="om-NavItem__count tnum">${activeNav === 'empty' ? '0' : it.count}</span>
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
        <div class="om-NavItem">
          <div class="om-NavItem__left">
            ${icon('dsp', { size: 18 })}
            <span class="om-NavItem__text">Consola DSP y EQ</span>
          </div>
          <span class="om-NavItem__count">Bypass</span>
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

function renderCleanNowPlayingBar({ showTooltip = false } = {}) {
  const pct = Math.round(NOW_PLAYING.progress * 100);

  return `
    <footer class="om-NowPlaying">
      ${
        showTooltip
          ? `
        <div class="om-TooltipBubble" style="left:50%;bottom:calc(var(--npbar-h) - 6px);transform:translateX(-50%)">
          <span>Pausar / Reanudar reproducción</span>
          <kbd class="om-Kbd">Espacio</kbd>
        </div>`
          : ''
      }
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
          <div class="om-SeekBar">
            <div class="om-SeekFill" style="width:${pct}%"></div>
            <div class="om-SeekThumb" style="left:${pct}%"></div>
          </div>
          <span class="om-Time is-end tnum">${NOW_PLAYING.duration}</span>
        </div>
      </div>

      <div class="om-NP__right">
        <div class="om-HiFiBadges">
          <span class="om-HiFiBadges__src tnum">${formatLong(NOW_PLAYING.album)}</span>
          <span class="om-HiFiBadges__out">
            <span class="om-Dot"></span>
            <span>${NOW_PLAYING.output} · Bit-Perfect</span>
          </span>
        </div>

        <div class="om-Volume">
          <button class="om-IconBtn" title="Volumen">${icon('volume', { size: 17 })}</button>
          <div class="om-VolTrack"><div class="om-VolFill"></div></div>
        </div>

        <div class="om-DrawerToggles">
          <button class="om-IconBtn" title="Letras sincronizadas (Ctrl+L)">${icon('lyrics', { size: 17 })}</button>
          <button class="om-IconBtn" title="Consola DSP / EQ (Ctrl+E)">${icon('dsp', { size: 17 })}</button>
          <button class="om-IconBtn" title="Cola de reproducción (Ctrl+Q)">${icon('queue', { size: 17 })}</button>
          <button class="om-IconBtn" title="Vista Ahora Suena a pantalla completa (F11)">${icon('expand', { size: 16 })}</button>
        </div>
      </div>
    </footer>
  `;
}

function renderBackgroundTrackRows(count = 10) {
  const rows = ALL_TRACKS.slice(0, count);
  return `
    <div class="om-Content">
      <div class="om-DataGridWrap">
        <table class="om-DataGrid">
          <thead>
            <tr>
              <th style="width:42px">#</th>
              <th>Título</th>
              <th>Artista</th>
              <th>Álbum</th>
              <th style="width:92px">Año</th>
              <th style="width:126px">Formato</th>
              <th style="width:76px;text-align:right">${icon('clock', { size: 14 })}</th>
            </tr>
          </thead>
          <tbody>
            ${rows
              .map((r) => {
                const b = formatBadge(r.album);
                const chip = r.album.codec === 'DSD' ? r.album.dsd : `${r.album.codec} ${b.label}`;
                return `
                  <tr class="${r.playing ? 'is-playing' : ''}">
                    <td class="tnum">${r.idx}</td>
                    <td>
                      <div class="om-TrackCell">
                        <div class="om-MiniThumb">${coverSvg(r.album)}</div>
                        <span class="om-TrackTitle">${r.title}</span>
                      </div>
                    </td>
                    <td>${r.artist}</td>
                    <td>${r.album.title}</td>
                    <td class="tnum">${r.year}</td>
                    <td><span class="om-FormatChip tnum ${b.hires ? 'is-hires' : ''}">${chip}</span></td>
                    <td class="tnum" style="text-align:right">${r.dur}</td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ---------------- R3-01: INSPECTOR DE METADATOS Y EDITOR DE ETIQUETAS ---------------- */
function renderTagInspectorModal() {
  const alb = NOW_PLAYING.album;
  return `
    <div class="om-ModalBackdrop">
      <section class="om-Modal" aria-label="Inspector de Metadatos y Editor de Etiquetas">
        <header class="om-Modal__head">
          <div class="om-Modal__title">
            ${icon('composer', { size: 18 })}
            <span>Inspector de Metadatos y Propiedades</span>
            <span class="om-Pill is-active" style="font-size:11px;padding:2px 9px">3 pistas seleccionadas (Edición por lotes)</span>
          </div>
          <div class="om-Segmented">
            <div class="om-Segmented__btn is-active"><span>Etiquetas</span></div>
            <div class="om-Segmented__btn"><span>Letras (.LRC)</span></div>
            <div class="om-Segmented__btn"><span>Carátula</span></div>
            <div class="om-Segmented__btn"><span>Archivo</span></div>
          </div>
        </header>

        <div class="om-Modal__body">
          <div class="om-FormGrid">
            <div class="om-Field is-full">
              <span class="om-Field__label"><span>Título de la pista</span><span style="color:var(--accent)">Valores distintos en el lote</span></span>
              <div class="om-Field__input is-mixed">&lt;varios — conservar individualmente&gt;</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>Artista del álbum</span><span>Vorbis ARTIST</span></span>
              <div class="om-Field__input">Lumen Atlas</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>Álbum</span><span>Vorbis ALBUM</span></span>
              <div class="om-Field__input">Nocturnes for Glass</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>Compositor</span><span>COMPOSER</span></span>
              <div class="om-Field__input">Erik Lindqvist</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>Género</span><span>GENRE</span></span>
              <div class="om-Field__input">Jazz Contemporáneo</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>Año</span><span>DATE</span></span>
              <div class="om-Field__input tnum">2019</div>
            </div>

            <div class="om-Field">
              <span class="om-Field__label"><span>N.º de Pista / Total</span><span>TRACKNUMBER</span></span>
              <div class="om-Field__input is-mixed tnum">&lt;varios (01..03 / 09)&gt;</div>
            </div>

            <div class="om-Field is-full">
              <span class="om-Field__label"><span>Ruta en disco local (solo lectura)</span><span>Inodo ext4 / NTFS</span></span>
              <div class="om-Field__input tnum" style="color:var(--text-2);font-size:12px">/home/emmanuel/Música/Hi-Res/Lumen Atlas - Nocturnes for Glass/03 - Tidal Lamps.flac</div>
            </div>
          </div>

          <aside class="om-TechCard">
            <div style="display:flex;align-items:center;gap:12px;padding-bottom:8px;border-bottom:1px solid var(--line-1)">
              <div class="om-MiniThumb" style="width:58px;height:58px;border-radius:8px">${coverSvg(alb)}</div>
              <div>
                <div style="font-size:12px;font-weight:700;color:var(--text-1)">PICTURE Incrustado</div>
                <div style="font-size:11px;color:var(--text-2)" class="tnum">JPEG · 1400 × 1400 px · 612 KB</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:3px">Cambiar o exportar…</div>
              </div>
            </div>

            <div class="om-TechRow"><span>Contenedor / Tags</span><strong class="tnum">FLAC · Vorbis Comments</strong></div>
            <div class="om-TechRow"><span>Resolución PCM</span><strong class="tnum">24-bit / 192,000 Hz</strong></div>
            <div class="om-TechRow"><span>Canales / Bitrate</span><strong class="tnum">2.0 Estéreo · 4,812 kbps</strong></div>
            <div class="om-TechRow"><span>Tamaño total</span><strong class="tnum">247.6 MB (Lote: 698 MB)</strong></div>
            <div class="om-TechRow"><span>Sonoridad BS.1770-4</span><strong class="tnum" style="color:var(--ok)">-14.1 LUFS · -1.2 dBTP</strong></div>
            <div class="om-TechRow"><span>ReplayGain 2.0</span><strong class="tnum">-3.9 dB (Álbum: -3.6 dB)</strong></div>
          </aside>
        </div>

        <footer class="om-Modal__foot">
          <span style="font-size:11px;color:var(--text-2)">Escritura directa en cabeceras sin recodificar el flujo de audio (0 LSB alterado)</span>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="om-BtnGhost">Cancelar (Esc)</button>
            <button class="om-BtnPrimary">${icon('check', { size: 14 })}<span>Guardar etiquetas en 3 archivos</span></button>
          </div>
        </footer>
      </section>
    </div>
  `;
}

/* ---------------- R3-02: MENÚ CONTEXTUAL + TOOLTIPS + TOASTS ---------------- */
function renderContextMenuAndToastsOverlay() {
  return `
    <div class="om-ContextMenu" style="top:198px;left:360px" aria-label="Menú contextual de pista">
      <div class="om-ContextItem is-active">
        <span style="display:flex;align-items:center;gap:8px">${icon('play', { size: 14 })} Reproducir ahora</span>
        <kbd class="om-Kbd">Enter</kbd>
      </div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('playNext', { size: 14 })} Reproducir a continuación</span>
        <kbd class="om-Kbd">Shift+Enter</kbd>
      </div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('addQueue', { size: 14 })} Añadir al final de la cola</span>
        <kbd class="om-Kbd">Q</kbd>
      </div>
      <div class="om-ContextSep"></div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('playlist', { size: 14 })} Añadir a una lista…</span>
        <span>▸</span>
      </div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('wave', { size: 14 })} Medir sonoridad ITU-R BS.1770-4</span>
        <span class="tnum" style="font-size:10px;color:var(--text-3)">R128</span>
      </div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('composer', { size: 14 })} Editar etiquetas ID3 / Vorbis…</span>
        <kbd class="om-Kbd">Ctrl+I</kbd>
      </div>
      <div class="om-ContextItem">
        <span style="display:flex;align-items:center;gap:8px">${icon('folder', { size: 14 })} Mostrar en explorador de archivos</span>
        <kbd class="om-Kbd">Ctrl+O</kbd>
      </div>
      <div class="om-ContextSep"></div>
      <div class="om-ContextItem is-danger">
        <span style="display:flex;align-items:center;gap:8px">${icon('trash', { size: 14 })} Quitar de la biblioteca SQLite</span>
        <kbd class="om-Kbd">Supr</kbd>
      </div>
    </div>

    <div class="om-ToastStack" aria-label="Notificaciones efímeras">
      <div class="om-Toast">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="om-Dot"></span>
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text-1)">Etiquetas FLAC guardadas en disco</div>
            <div style="font-size:11px;color:var(--text-2)">«Tidal Lamps» indexado en SQLite FTS5 en 1.8 ms</div>
          </div>
        </div>
        <button class="om-IconBtn" style="width:24px;height:24px">${icon('close', { size: 13 })}</button>
      </div>

      <div class="om-Toast" style="border-color:rgba(var(--accent-rgb),0.45)">
        <div style="display:flex;align-items:center;gap:10px">
          ${icon('playNext', { size: 16 })}
          <div>
            <div style="font-size:12px;font-weight:600;color:var(--text-1)">2 pistas añadidas a «A continuación»</div>
            <div style="font-size:11px;color:var(--text-2)">El álbum en reproducción continuará después</div>
          </div>
        </div>
        <span style="font-size:11px;font-weight:700;color:var(--accent);cursor:pointer">Deshacer</span>
      </div>
    </div>
  `;
}

/* ---------------- R3-03: ESTADO VACÍO Y ONBOARDING ---------------- */
function renderEmptyOnboardingContent() {
  return `
    <div class="om-EmptyHero">
      <div class="om-EmptyArt">${icon('disc', { size: 46 })}</div>
      <div>
        <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.025em">Tu sala de escucha local está lista</h1>
        <p style="font-size:14px;color:var(--text-2);max-width:520px;margin-top:6px">
          Vincula una carpeta de tu disco duro o NAS. OurMusic indexará tus metadatos en <strong>SQLite FTS5</strong> con 8 hilos paralelos y vigilará cambios en tiempo real sin subir nada a internet.
        </p>
      </div>

      <div style="display:flex;align-items:center;gap:10px">
        <button class="om-BtnPrimary" style="padding:9px 18px;font-size:13px">${icon('folder', { size: 16 })}<span>+ Añadir primera carpeta de música local</span></button>
        <button class="om-BtnGhost" style="padding:9px 16px;font-size:13px">${icon('playlist', { size: 16 })}<span>Importar lista (.M3U8 / .PLS / .XSPF)</span></button>
      </div>

      <div class="om-OnboardCards">
        <div class="om-OnboardCard">
          <div style="font-size:12px;font-weight:700;color:var(--accent)">1. Escaneo O(metadata)</div>
          <div style="font-size:11px;color:var(--text-2)">Lee cabeceras FLAC, ALAC, WAV, MP3 y DSD64–DSD1024 en milisegundos sin saturar la RAM.</div>
        </div>
        <div class="om-OnboardCard">
          <div style="font-size:12px;font-weight:700;color:var(--ok)">2. Salida Bit-Perfect Nativa</div>
          <div style="font-size:11px;color:var(--text-2)">Comunicación directa con ALSA Hardware (Linux) y WASAPI Exclusivo / ASIO (Windows).</div>
        </div>
        <div class="om-OnboardCard">
          <div style="font-size:12px;font-weight:700;color:var(--text-1)">3. Vigilancia Automática</div>
          <div style="font-size:11px;color:var(--text-2)">Cualquier disco nuevo que copies a tu carpeta aparecerá al instante sin reescanear.</div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- R3-04: EXPLORADOR DE CARPETAS LOCALES + MIGAS DE PAN ---------------- */
function renderFoldersExplorerContent({ isCompact = false } = {}) {
  const subfolders = [
    { name: 'CD1 - Studio Master (24-192)', files: '9 archivos FLAC', size: '1.84 GB' },
    { name: 'CD2 - Live at Oslo Opera', files: '6 archivos FLAC', size: '1.12 GB' },
    { name: 'Booklet & Scans (600 DPI)', files: '4 imágenes PNG', size: '48.2 MB' },
    { name: 'Impulse Responses (AutoEQ)', files: '2 archivos WAV', size: '3.4 MB' },
  ];
  const files = ALL_TRACKS.slice(0, isCompact ? 6 : 8);

  return `
    <div class="om-Content">
      <div class="om-SectionToolbar">
        <div class="om-SectionToolbar__title">
          <h1>Explorador de Carpetas Locales</h1>
          <span class="om-SectionToolbar__sub tnum">/home/emmanuel/Música/Hi-Res/Jazz/Lumen Atlas · Vigilancia inotify activa</span>
        </div>
        <div class="om-FilterPills">
          <span class="om-Pill is-active">${icon('plus', { size: 13 })}<span>Vincular carpeta</span></span>
          <span class="om-Pill">Reescanear carpeta actual</span>
        </div>
      </div>

      <div class="om-SubfolderRow">
        ${subfolders
          .map(
            (sf) => `
          <div class="om-SubfolderCard">
            <span style="color:var(--accent)">${icon('folder', { size: 22 })}</span>
            <div style="min-width:0">
              <div style="font-size:12px;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${sf.name}</div>
              <div style="font-size:11px;color:var(--text-2)" class="tnum">${sf.files} · ${sf.size}</div>
            </div>
          </div>`,
          )
          .join('')}
      </div>

      <div class="om-DataGridWrap">
        <table class="om-DataGrid">
          <thead>
            <tr>
              <th>Nombre de archivo en disco</th>
              <th>Título detectado</th>
              <th style="width:130px">Contenedor</th>
              <th style="width:110px">Tamaño</th>
              <th style="width:80px;text-align:right">Duración</th>
            </tr>
          </thead>
          <tbody>
            ${files
              .map((f, i) => {
                const ext = f.album.codec.toLowerCase() === 'dsd' ? 'dsf' : f.album.codec.toLowerCase();
                const fname = `${String(i + 1).padStart(2, '0')} - ${f.title}.${ext}`;
                const b = formatBadge(f.album);
                return `
                  <tr class="${f.playing ? 'is-playing' : ''}">
                    <td class="tnum" style="color:var(--text-1);font-weight:500">${fname}</td>
                    <td>${f.title} — ${f.artist}</td>
                    <td><span class="om-FormatChip tnum ${b.hires ? 'is-hires' : ''}">${f.album.codec} ${b.label}</span></td>
                    <td class="tnum">${(42.8 + i * 19.4).toFixed(1)} MB</td>
                    <td class="tnum" style="text-align:right">${f.dur}</td>
                  </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/* ---------------- R3-05: HOJA MODAL DE ATAJOS DE TECLADO (?) ---------------- */
function renderShortcutsModal() {
  const col1 = [
    ['Pausar / Reanudar reproducción', 'Espacio'],
    ['Pista siguiente / anterior', 'Ctrl + → / ←'],
    ['Adelantar / Retroceder 10 s', '→ / ←'],
    ['Subir / Bajar volumen (pasos de 2 %)', '↑ / ↓'],
    ['Silenciar salida (Mute)', 'M'],
    ['Alternar modo Aleatorio / Repetir', 'S / R'],
    ['Teclas Multimedia del Sistema', 'MPRIS2 / SMTC'],
  ];
  const col2 = [
    ['Enfocar Búsqueda Global Instantánea', 'Ctrl + F'],
    ['Abrir / Cerrar Cola de Reproducción', 'Ctrl + Q'],
    ['Abrir / Cerrar Consola DSP y EQ', 'Ctrl + E'],
    ['Abrir / Cerrar Letras Sincronizadas', 'Ctrl + L'],
    ['Modo Sala de Escucha (Pantalla completa)', 'F11'],
    ['Inspector de Metadatos / Etiquetas ID3', 'Ctrl + I'],
    ['Mostrar esta hoja de atajos', '?'],
  ];

  return `
    <div class="om-ModalBackdrop">
      <section class="om-Modal" style="width:760px" aria-label="Atajos de Teclado y Control Multimedia">
        <header class="om-Modal__head">
          <div class="om-Modal__title">
            ${icon('bolt', { size: 18 })}
            <span>Atajos de Teclado e Integración del Sistema</span>
          </div>
          <span class="om-SignalBadge">MPRIS D-Bus (Linux) · SMTC (Windows) Activos</span>
        </header>

        <div class="om-ShortcutsCols">
          <div>
            <div class="om-SearchGroup__title" style="margin-bottom:8px">Transporte y Audio</div>
            ${col1
              .map(
                ([label, kbd]) => `
              <div class="om-ShortcutRow">
                <span>${label}</span>
                <kbd class="om-Kbd tnum">${kbd}</kbd>
              </div>`,
              )
              .join('')}
          </div>

          <div>
            <div class="om-SearchGroup__title" style="margin-bottom:8px">Navegación, Vistas y Herramientas</div>
            ${col2
              .map(
                ([label, kbd]) => `
              <div class="om-ShortcutRow">
                <span>${label}</span>
                <kbd class="om-Kbd tnum">${kbd}</kbd>
              </div>`,
              )
              .join('')}
          </div>
        </div>

        <footer class="om-Modal__foot">
          <span style="font-size:11px;color:var(--text-2)">Las teclas físicas Play/Pause/Next de tu teclado funcionan incluso con la ventana en segundo plano</span>
          <button class="om-BtnPrimary">Entendido (Esc)</button>
        </footer>
      </section>
    </div>
  `;
}

export function buildRound3WindowHTML(screenId, size = '1440') {
  const isCompact = size === '1280';
  const sizeCls = isCompact ? 'is-1280' : '';
  const accentHex = NOW_PLAYING.album.palette[1];

  if (screenId === 'tag-inspector') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('tracks')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas', 'Inspector de Etiquetas'] })}
          ${renderBackgroundTrackRows(isCompact ? 7 : 10)}
          ${renderTagInspectorModal()}
        </main>
        ${renderCleanNowPlayingBar()}
      </div>
    `;
  }

  if (screenId === 'context-toasts') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('tracks')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas'] })}
          ${renderBackgroundTrackRows(isCompact ? 7 : 10)}
          ${renderContextMenuAndToastsOverlay()}
        </main>
        ${renderCleanNowPlayingBar({ showTooltip: true })}
      </div>
    `;
  }

  if (screenId === 'empty-onboarding') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('empty')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Bienvenida y Configuración Inicial'] })}
          ${renderEmptyOnboardingContent()}
        </main>
        ${renderCleanNowPlayingBar()}
      </div>
    `;
  }

  if (screenId === 'folders-breadcrumbs') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
        ${renderSidebar('folders')}
        <main class="om-Main">
          ${renderTopbar({
            crumbs: ['Carpetas locales', 'nvme0n1p2', 'Música Hi-Res', 'Jazz', 'Lumen Atlas'],
            viewMode: 'list',
            sortLabel: 'Archivo ↑',
          })}
          ${renderFoldersExplorerContent({ isCompact })}
        </main>
        ${renderCleanNowPlayingBar()}
      </div>
    `;
  }

  // shortcuts-modal
  return `
    <div class="om-Window ${sizeCls}" data-accent="${accentHex}">
      ${renderSidebar('tracks')}
      <main class="om-Main">
        ${renderTopbar({ crumbs: ['Biblioteca', 'Pistas', 'Atajos de Teclado'] })}
        ${renderBackgroundTrackRows(isCompact ? 7 : 10)}
        ${renderShortcutsModal()}
      </main>
      ${renderCleanNowPlayingBar()}
    </div>
  `;
}

const ROUND3_SCREENS = [
  { id: 'tag-inspector', code: 'R3-01', title: 'Inspector de Metadatos y Editor de Etiquetas ID3/Vorbis/MP4 (Edición por lotes)' },
  { id: 'context-toasts', code: 'R3-02', title: 'Menú Contextual de Clic Derecho + Tooltip de Atajo + Notificaciones (Toasts)' },
  { id: 'empty-onboarding', code: 'R3-03', title: 'Estado Vacío y Onboarding Inicial («Añade tu primera carpeta de música local»)' },
  { id: 'folders-breadcrumbs', code: 'R3-04', title: 'Explorador de Carpetas Locales en Crudo con Migas de Pan Profundas' },
  { id: 'shortcuts-modal', code: 'R3-05', title: 'Hoja Modal de Atajos de Teclado (?) e Integración Multimedia MPRIS / SMTC' },
];

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

export function mountFullProtoSuite(root) {
  let currentRound = 'r3'; // 'r3' | 'r2' | 'r1'
  let currentView = 'all';
  let currentSize = 'both'; // 'both' | '1440' | '1280'

  function render() {
    const activeList =
      currentRound === 'r3'
        ? ROUND3_SCREENS
        : currentRound === 'r2'
          ? ROUND2_SCREENS
          : ROUND1_SCREENS;

    const screensToRender =
      currentView === 'all' ? activeList : activeList.filter((s) => s.id === currentView);
    const sizesToRender = currentSize === 'both' ? ['1440', '1280'] : [currentSize];

    const artboards = [];
    for (const s of screensToRender) {
      for (const sz of sizesToRender) {
        const dim = sz === '1440' ? '1440 × 900 (Escritorio)' : '1280 × 720 (Compacto · Sidebar colapsada)';
        const html =
          currentRound === 'r3'
            ? buildRound3WindowHTML(s.id, sz)
            : currentRound === 'r2'
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
          <button class="proto-Tab ${currentRound === 'r3' ? 'is-active' : ''}" data-round="r3">Ronda 3 (5 pantallas)</button>
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
