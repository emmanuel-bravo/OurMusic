/*
 * OurMusic — Renderizador de Bocetos Hi-Fi (Ronda 1 — Base Visual)
 * Pantallas incluidas (a 1440×900 y variante compacta 1280×720):
 *   1. Álbumes en Cuadrícula + Sidebar + Now Playing Bar con Waveform
 *   2. Búsqueda Global Instantánea Desplegada (SQLite FTS5 + Letras)
 *   3. Vista Detallada de Álbum (Hero con Color Thievery + Pistas)
 *   4. Popover «Ruta de Señal» Bit-Perfect (Archivo → C11 → DSP → Salida)
 */
import { icon } from './icons.js';
import { coverSvg, applyAccent, avatarColor, initials, mockPeaks } from './visuals.js';
import {
  ALBUMS,
  NOW_PLAYING,
  ALBUM_TRACKS,
  PLAYLISTS,
  SMART_LISTS,
  formatBadge,
  formatLong,
} from './data.js';

function renderSidebar(activeNav = 'albums') {
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
        <div class="om-WatcherPill" title="Vigilancia incremental inotify / ReadDirectoryChangesW activa">
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

function renderTopbar({ crumbs, searchQuery = '', searchFocused = false }) {
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

      <div class="om-SearchBox ${searchFocused ? 'is-focused' : ''}">
        ${icon('search', { size: 16 })}
        <div class="om-SearchBox__input">
          ${
            searchQuery
              ? `<span>${searchQuery}</span>`
              : `<span class="om-SearchBox__placeholder">Buscar pistas, álbumes, artistas o letras…</span>`
          }
        </div>
        <kbd class="om-Kbd">Ctrl+F</kbd>
      </div>

      <div class="om-Topbar__right">
        <div class="om-Segmented">
          <div class="om-Segmented__btn is-active">${icon('grid', { size: 15 })}<span>Cuadrícula</span></div>
          <div class="om-Segmented__btn">${icon('listView', { size: 15 })}<span>Tabla</span></div>
        </div>
        <div class="om-Pill">${icon('sort', { size: 14 })}<span>Año ↓</span></div>
      </div>
    </header>
  `;
}

function renderNowPlayingBar({ signalActive = false } = {}) {
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
        <div class="om-HiFiBadges ${signalActive ? 'is-active' : ''}" title="Clic para inspeccionar Ruta de Señal">
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

function renderAlbumGridContent({ isCompact = false } = {}) {
  const visibleCount = isCompact ? 12 : 12;
  const list = ALBUMS.slice(0, visibleCount);

  return `
    <div class="om-Content">
      <div class="om-SectionToolbar">
        <div class="om-SectionToolbar__title">
          <h1>Álbumes</h1>
          <span class="om-SectionToolbar__sub tnum">186 álbumes · 2,480 pistas locales</span>
        </div>
        <div class="om-FilterPills">
          <span class="om-Pill is-active">Todos</span>
          <span class="om-Pill">Hi-Res (24-bit / DSD)</span>
          <span class="om-Pill">Lossless</span>
          <span class="om-Pill">Con letras .LRC</span>
        </div>
      </div>

      <div class="om-AlbumGrid">
        ${list
          .map((alb, idx) => {
            const b = formatBadge(alb);
            const stateCls = idx === 0 ? 'is-playing' : idx === 1 ? 'is-hovered' : '';
            return `
              <article class="om-AlbumCard ${stateCls}">
                <div class="om-AlbumCard__art">
                  ${coverSvg(alb)}
                  <span class="om-AlbumCard__badge tnum ${b.hires ? 'is-hires' : ''}">${b.label}</span>
                  <div class="om-AlbumCard__play">${icon(idx === 0 ? 'bars' : 'play', { size: 16 })}</div>
                </div>
                <div class="om-AlbumCard__title">${alb.title}</div>
                <div class="om-AlbumCard__sub">
                  <span>${alb.artist}</span>
                  <span class="tnum">${alb.year}</span>
                </div>
              </article>
            `;
          })
          .join('')}
      </div>
    </div>
  `;
}

function renderSearchOverlay() {
  const topAlbum = ALBUMS[0];
  return `
    <div class="om-Scrim"></div>
    <section class="om-SearchDropdown" aria-label="Resultados instantáneos FTS5">
      <div class="om-SearchDropdown__head">
        <span>Índice invertido <strong>SQLite FTS5</strong> (insensible a tildes y mayúsculas)</span>
        <span class="om-SearchDropdown__perf tnum">14 resultados en 1.4 ms</span>
      </div>

      <div class="om-SearchDropdown__body">
        <div class="om-TopHit">
          <span class="om-TopHit__label">Mejor resultado</span>
          <div class="om-TopHit__art">${coverSvg(topAlbum)}</div>
          <div>
            <div class="om-TopHit__title"><span class="om-Highlight">Lumen</span> Atlas</div>
            <div class="om-TopHit__sub">Artista · 2 álbumes · 17 pistas · FLAC 24/192</div>
          </div>
          <div class="om-TopHit__actions">
            <button class="om-BtnPrimary">${icon('play', { size: 14 })}<span>Reproducir</span></button>
            <button class="om-BtnGhost">${icon('addQueue', { size: 14 })}<span>A la cola</span></button>
          </div>
        </div>

        <div class="om-SearchGroups">
          <div>
            <div class="om-SearchGroup__title">Pistas (5)</div>
            <div class="om-SearchRow is-selected">
              <div class="om-SearchRow__left">
                <div class="om-MiniThumb">${coverSvg(ALBUMS[0])}</div>
                <div>
                  <div class="om-TrackTitle">Tidal Lamps — <span class="om-Highlight">Lumen</span> Atlas</div>
                </div>
              </div>
              <span class="om-ArtboardMeta tnum">FLAC 24/192 · 7:41</span>
            </div>
            <div class="om-SearchRow">
              <div class="om-SearchRow__left">
                <div class="om-MiniThumb">${coverSvg(ALBUMS[14])}</div>
                <div>
                  <div class="om-TrackTitle">Harbor Reflections — <span class="om-Highlight">Lumen</span> Atlas</div>
                </div>
              </div>
              <span class="om-ArtboardMeta tnum">FLAC 24/96 · 5:18</span>
            </div>
          </div>

          <div>
            <div class="om-SearchGroup__title">Álbumes (2) y Artistas (2)</div>
            <div class="om-SearchRow">
              <div class="om-SearchRow__left">
                <div class="om-MiniThumb">${coverSvg(ALBUMS[0])}</div>
                <span><strong>Nocturnes for Glass</strong> · <span class="om-Highlight">Lumen</span> Atlas (2019)</span>
              </div>
              <span class="tnum">9 pistas</span>
            </div>
            <div class="om-SearchRow">
              <div class="om-SearchRow__left">
                <span class="om-AvatarInitials" style="background:${avatarColor('Lumen Atlas')}">${initials('Lumen Atlas')}</span>
                <span><strong><span class="om-Highlight">Lumen</span> Atlas</strong> · Artista local</span>
              </div>
              <span class="tnum">2 álbumes</span>
            </div>
          </div>

          <div>
            <div class="om-SearchGroup__title">Coincidencias en letras sincronizadas (3)</div>
            <div class="om-SearchRow">
              <div class="om-SearchRow__left">
                ${icon('lyrics', { size: 15 })}
                <div>
                  <div class="om-TrackTitle">Fog Signals · Nocturnes for Glass</div>
                  <div class="om-LyricSnippet">«…bajo el faro de <span class="om-Highlight">lumen</span> pálido regresa la marea…»</div>
                </div>
              </div>
              <span class="tnum">02:14.80</span>
            </div>
          </div>
        </div>
      </div>

      <div class="om-SearchDropdown__foot">
        <span>Usa <kbd class="om-Kbd">↑</kbd> <kbd class="om-Kbd">↓</kbd> para navegar · <kbd class="om-Kbd">Enter</kbd> para reproducir</span>
        <span class="om-SearchDropdown__link">Ver los 14 resultados para «lumen» →</span>
      </div>
    </section>
  `;
}

function renderAlbumHeroDetail({ isCompact = false } = {}) {
  const alb = ALBUMS[0];
  const tracks = isCompact ? ALBUM_TRACKS.slice(0, 6) : ALBUM_TRACKS;

  return `
    <section class="om-AlbumHero">
      <div class="om-AlbumHero__cover">${coverSvg(alb)}</div>
      <div class="om-AlbumHero__info">
        <div class="om-AlbumHero__eyebrow">
          <span>Álbum Local · Sin Pérdida</span>
          <span>•</span>
          <span class="tnum">${formatLong(alb)}</span>
        </div>
        <h1 class="om-AlbumHero__title">${alb.title}</h1>
        <div class="om-AlbumHero__meta">
          <span class="om-AvatarInitials" style="background:${avatarColor(alb.artist)};width:22px;height:22px;font-size:10px">${initials(alb.artist)}</span>
          <strong>${alb.artist}</strong>
          <span>•</span>
          <span class="tnum">${alb.year}</span>
          <span>•</span>
          <span>${alb.genre}</span>
          <span>•</span>
          <span class="tnum">9 pistas, 54 min 31 s</span>
          <span>•</span>
          <span class="tnum">DR13 · -14.2 LUFS</span>
        </div>
        <div class="om-AlbumHero__actions">
          <button class="om-BtnPrimary">${icon('play', { size: 15 })}<span>Reproducir álbum</span></button>
          <button class="om-BtnGhost">${icon('playNext', { size: 15 })}<span>Reproducir a continuación</span></button>
          <button class="om-BtnGhost">${icon('addQueue', { size: 15 })}<span>Añadir a la cola</span></button>
          <button class="om-IconBtn" title="Más acciones (clic derecho)">${icon('more', { size: 17 })}</button>
        </div>
      </div>
    </section>

    <div class="om-Content" style="padding-top:12px">
      <table class="om-TrackTable">
        <thead>
          <tr>
            <th style="width:44px">#</th>
            <th>Título</th>
            <th style="width:160px">Formato</th>
            <th style="width:110px">Sonoridad</th>
            <th style="width:72px;text-align:right">${icon('clock', { size: 14 })}</th>
          </tr>
        </thead>
        <tbody>
          ${tracks
            .map(
              (t) => `
            <tr class="${t.playing ? 'is-playing' : ''}">
              <td class="tnum">${t.playing ? icon('bars', { size: 15 }) : t.n}</td>
              <td>
                <span class="om-TrackTitle">${t.title}</span>
                ${t.lyrics ? '<span class="om-TagMini">LRC</span>' : ''}
              </td>
              <td class="tnum">FLAC 24-bit/192 kHz</td>
              <td class="tnum">-14.1 LUFS</td>
              <td class="tnum" style="text-align:right">${t.dur}</td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderSignalPathPopover() {
  return `
    <aside class="om-SignalPopover" aria-label="Ruta de señal de audio">
      <div class="om-SignalPopover__head">
        <div>
          <div class="om-SignalPopover__title">Ruta de Señal</div>
          <div style="font-size:11px;color:var(--text-2)">Integridad verificada · 0 LSB de error</div>
        </div>
        <span class="om-SignalBadge">
          <span class="om-Dot"></span>
          <span>Bit-Perfect</span>
        </span>
      </div>

      <div class="om-SignalChain">
        <div class="om-SignalNode">
          <div class="om-SignalNode__icon">${icon('file', { size: 17 })}</div>
          <div class="om-SignalNode__body">
            <div class="om-SignalNode__name">
              <span>1. Archivo Fuente Local</span>
              <span class="om-SignalNode__tag tnum">4,812 kbps</span>
            </div>
            <div class="om-SignalNode__detail tnum">FLAC · 24-bit / 192.0 kHz · 2.0 canales</div>
          </div>
        </div>

        <div class="om-SignalNode">
          <div class="om-SignalNode__icon">${icon('chip', { size: 17 })}</div>
          <div class="om-SignalNode__body">
            <div class="om-SignalNode__name">
              <span>2. Decodificador Nativo C11</span>
              <span class="om-SignalNode__tag">Zero-Copy</span>
            </div>
            <div class="om-SignalNode__detail">dec_flac.c (RFC 9639) · Anillo en RAM de 64 bloques</div>
          </div>
        </div>

        <div class="om-SignalNode">
          <div class="om-SignalNode__icon">${icon('dsp', { size: 17 })}</div>
          <div class="om-SignalNode__body">
            <div class="om-SignalNode__name">
              <span>3. Pipeline DSP de 64 bits</span>
              <span class="om-SignalNode__tag">Bypass</span>
            </div>
            <div class="om-SignalNode__detail">EQ, Convolver FIR y Crossfeed inactivos (paso directo)</div>
          </div>
        </div>

        <div class="om-SignalNode">
          <div class="om-SignalNode__icon">${icon('output', { size: 17 })}</div>
          <div class="om-SignalNode__body">
            <div class="om-SignalNode__name">
              <span>4. Salida de Hardware</span>
              <span class="om-SignalNode__tag">Exclusivo</span>
            </div>
            <div class="om-SignalNode__detail tnum">${NOW_PLAYING.output} · ${NOW_PLAYING.device} (24/192 nativo)</div>
          </div>
        </div>
      </div>
    </aside>
  `;
}

export function buildWindowHTML(screenId, size = '1440') {
  const isCompact = size === '1280';
  const sizeCls = isCompact ? 'is-1280' : '';

  if (screenId === 'albums') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${NOW_PLAYING.album.palette[1]}">
        ${renderSidebar('albums')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Álbumes'] })}
          ${renderAlbumGridContent({ isCompact })}
        </main>
        ${renderNowPlayingBar()}
      </div>
    `;
  }

  if (screenId === 'search') {
    return `
      <div class="om-Window ${sizeCls}" data-accent="${NOW_PLAYING.album.palette[1]}">
        ${renderSidebar('albums')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Álbumes'], searchQuery: 'lumen', searchFocused: true })}
          ${renderAlbumGridContent({ isCompact })}
          ${renderSearchOverlay()}
        </main>
        ${renderNowPlayingBar()}
      </div>
    `;
  }

  if (screenId === 'album-detail') {
    const heroAlbum = ALBUMS[0];
    return `
      <div class="om-Window ${sizeCls}" data-accent="${heroAlbum.palette[1]}">
        ${renderSidebar('albums')}
        <main class="om-Main">
          ${renderTopbar({ crumbs: ['Biblioteca', 'Álbumes', heroAlbum.artist, heroAlbum.title] })}
          ${renderAlbumHeroDetail({ isCompact })}
        </main>
        ${renderNowPlayingBar()}
      </div>
    `;
  }

  // signal-path
  return `
    <div class="om-Window ${sizeCls}" data-accent="${NOW_PLAYING.album.palette[1]}">
      ${renderSidebar('albums')}
      <main class="om-Main">
        ${renderTopbar({ crumbs: ['Biblioteca', 'Álbumes', NOW_PLAYING.album.artist, NOW_PLAYING.album.title] })}
        ${renderAlbumHeroDetail({ isCompact })}
      </main>
      ${renderSignalPathPopover()}
      ${renderNowPlayingBar({ signalActive: true })}
    </div>
  `;
}

const SCREENS = [
  { id: 'albums', code: 'R1-01', title: 'Álbumes en Cuadrícula + Sidebar + Now Playing Bar' },
  { id: 'search', code: 'R1-02', title: 'Búsqueda Global Instantánea Desplegada (SQLite FTS5 + Letras)' },
  { id: 'album-detail', code: 'R1-03', title: 'Vista Detallada de Álbum (Hero + Color Thievery + Pistas)' },
  { id: 'signal-path', code: 'R1-04', title: 'Popover «Ruta de Señal» Bit-Perfect sobre Reproductor' },
];

export function mountRound1App(root) {
  let currentView = 'all'; // 'all' | 'albums' | 'search' | 'album-detail' | 'signal-path'
  let currentSize = 'both'; // 'both' | '1440' | '1280'

  function render() {
    const screensToRender =
      currentView === 'all' ? SCREENS : SCREENS.filter((s) => s.id === currentView);
    const sizesToRender =
      currentSize === 'both' ? ['1440', '1280'] : [currentSize];

    const artboards = [];
    for (const s of screensToRender) {
      for (const sz of sizesToRender) {
        const dim = sz === '1440' ? '1440 × 900 (Escritorio)' : '1280 × 720 (Compacto · Sidebar colapsada)';
        artboards.push(`
          <section class="artboard-Wrap">
            <div class="artboard-Header">
              <span><strong>${s.code} (${sz}w)</strong> — ${s.title}</span>
              <span class="artboard-Meta tnum">${dim}</span>
            </div>
            ${buildWindowHTML(s.id, sz)}
          </section>
        `);
      }
    }

    root.innerHTML = `
      <header class="proto-Dock">
        <div class="proto-Dock__brand">
          <span>OurMusic — Bocetos Hi-Fi</span>
          <span class="proto-Dock__badge">RONDA 1 · BASE VISUAL</span>
        </div>

        <div class="proto-Dock__tabs">
          <button class="proto-Tab ${currentView === 'all' ? 'is-active' : ''}" data-view="all">Todas (4 pantallas)</button>
          ${SCREENS.map(
            (s) => `
            <button class="proto-Tab ${currentView === s.id ? 'is-active' : ''}" data-view="${s.id}">
              ${s.code}: ${s.title.split(' (')[0].split(' +')[0]}
            </button>`,
          ).join('')}
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

    // Aplicar Color Thievery (contraste AA garantizado) a cada ventana
    root.querySelectorAll('.om-Window[data-accent]').forEach((win) => {
      applyAccent(win, win.getAttribute('data-accent'));
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
