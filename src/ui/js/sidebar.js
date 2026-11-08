/*
 * OurMusic — Componente de la Barra Lateral de Navegación (Sidebar)
 */
import { icon } from './icons.js';
import { ApiClient } from './api.js';
import { ShortcutsModal } from './shortcutsModal.js';

export class Sidebar {
  constructor({ container, store }) {
    this.container = container;
    this.store = store;

    this.render();
    this.bindEvents();
    this.update(this.store.state);

    this.store.subscribe((state, keys) => {
      if (
        keys.includes('currentView') ||
        keys.includes('summary') ||
        keys.includes('sidebarCollapsed') ||
        keys.includes('smartPlaylists') ||
        keys.includes('playlists') ||
        keys.includes('eqState')
      ) {
        this.update(state);
      }
    });
  }

  render() {
    const libItems = [
      { id: 'albums', icon: 'disc', label: 'Álbumes', count: 0 },
      { id: 'tracks', icon: 'note', label: 'Pistas', count: 0 },
      { id: 'artists', icon: 'artist', label: 'Artistas', count: 0 },
      { id: 'genres', icon: 'genre', label: 'Géneros', count: 0 },
      { id: 'composers', icon: 'composer', label: 'Compositores', count: 0 },
      { id: 'folders', icon: 'folder', label: 'Carpetas locales', count: 0 },
    ];

    this.container.innerHTML = `
      <aside class="om-Sidebar" id="sidebar">
        <div class="om-Brand">
          <div class="om-Brand__left">
            <div class="om-LogoSlot" title="Espacio reservado para tu logotipo">LOGO</div>
            <span class="om-Brand__title">OurMusic</span>
          </div>
          <button class="om-IconBtn" id="sidebar-collapse-btn" title="Alternar barra lateral (Ctrl+B)">
            ${icon('sidebar', { size: 17 })}
          </button>
        </div>

        <nav class="om-NavGroup">
          <div class="om-NavGroup__label"><span>Biblioteca</span></div>
          ${libItems
            .map(
              (it) => `
            <div class="om-NavItem ${it.id === 'albums' ? 'is-active' : ''}" data-nav="${it.id}">
              <div class="om-NavItem__left">
                ${icon(it.icon, { size: 18 })}
                <span class="om-NavItem__text">${it.label}</span>
              </div>
              <span class="om-NavItem__count tnum" id="nav-count-${it.id}">0</span>
            </div>`,
            )
            .join('')}
        </nav>

        <nav class="om-NavGroup">
          <div class="om-NavGroup__label">
            <span>Listas Inteligentes</span>
            ${icon('plus', { size: 14 })}
          </div>
          <div id="smart-playlists-list"></div>
        </nav>

        <nav class="om-NavGroup">
          <div class="om-NavGroup__label">
            <span>Mis Listas</span>
            ${icon('plus', { size: 14 })}
          </div>
          <div id="user-playlists-list"></div>
        </nav>

        <div class="om-Sidebar__footer">
          <div class="om-WatcherPill" title="Vigilancia incremental de carpetas en tiempo real">
            <span class="om-Dot"></span>
            <span id="watcher-status-text">SQLite WAL · Vigilancia activa</span>
          </div>
          <div class="om-NavItem" data-action="toggle-dsp">
            <div class="om-NavItem__left">
              ${icon('dsp', { size: 18 })}
              <span class="om-NavItem__text">Consola DSP y EQ</span>
            </div>
            <span class="om-NavItem__count" id="dsp-badge">Bypass</span>
          </div>
          <div class="om-NavItem" data-action="open-settings">
            <div class="om-NavItem__left">
              ${icon('settings', { size: 18 })}
              <span class="om-NavItem__text">Ajustes de Audio</span>
            </div>
          </div>
        </div>
      </aside>
    `;
  }

  bindEvents() {
    this.container.querySelectorAll('[data-nav]').forEach((el) => {
      el.addEventListener('click', () => {
        const view = el.getAttribute('data-nav');
        this.store.setState({ currentView: view });
      });
    });

    this.container.querySelector('#sidebar-collapse-btn')?.addEventListener('click', () => {
      const col = !this.store.state.sidebarCollapsed;
      this.store.setState({ sidebarCollapsed: col });
      const win = document.querySelector('.om-Window');
      if (win) win.classList.toggle('is-1280', col);
    });

    this.container.querySelector('[data-action="toggle-dsp"]')?.addEventListener('click', () => {
      const cur = this.store.state.activeDrawer;
      this.store.setState({ activeDrawer: cur === 'dsp' ? null : 'dsp' });
    });

    this.container.querySelector('[data-action="open-settings"]')?.addEventListener('click', () => {
      new ShortcutsModal({});
    });
  }

  update(state) {
    const { currentView, summary } = state;

    // Actualizar elemento activo
    this.container.querySelectorAll('[data-nav]').forEach((el) => {
      el.classList.toggle('is-active', el.getAttribute('data-nav') === currentView);
    });

    // Actualizar contadores si hay datos
    if (summary) {
      const setCount = (id, count) => {
        const el = this.container.querySelector(`#nav-count-${id}`);
        if (el) el.textContent = count ? count.toLocaleString() : '0';
      };
      setCount('albums', summary.totalAlbums || 0);
      setCount('tracks', summary.totalTracks || 0);
      setCount('artists', summary.totalArtists || 0);
      setCount('folders', summary.folders?.length || 0);
    }

    // Actualizar insignia de DSP
    const dspBadge = this.container.querySelector('#dsp-badge');
    if (dspBadge && state.eqState) {
      dspBadge.textContent = state.eqState.enabled ? '64-bit ON' : 'Bypass';
      dspBadge.style.color = state.eqState.enabled ? 'var(--accent)' : '';
    }

    // Renderizar Listas Inteligentes
    const smartSlot = this.container.querySelector('#smart-playlists-list');
    if (smartSlot && Array.isArray(state.smartPlaylists)) {
      smartSlot.innerHTML = state.smartPlaylists
        .map(
          (sp) => `
          <div class="om-NavItem" data-smart-id="${sp.id}" title="Reproducir lista inteligente: ${sp.name}">
            <div class="om-NavItem__left">
              ${icon('bolt', { size: 16 })}
              <span class="om-NavItem__text">${sp.name}</span>
            </div>
            <span class="om-NavItem__count tnum">${sp.trackCount ?? sp.tracks?.length ?? 0}</span>
          </div>`,
        )
        .join('');
      smartSlot.querySelectorAll('[data-smart-id]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.getAttribute('data-smart-id');
          const sp = state.smartPlaylists.find((x) => x.id === id);
          if (sp && Array.isArray(sp.tracks) && sp.tracks.length > 0) {
            ApiClient.play(sp.tracks, 0).catch(console.error);
          } else {
            this.store.setState({ currentView: 'tracks' });
          }
        });
      });
    }

    // Renderizar Mis Listas
    const plSlot = this.container.querySelector('#user-playlists-list');
    if (plSlot && Array.isArray(state.playlists)) {
      plSlot.innerHTML = state.playlists
        .map(
          (pl) => `
          <div class="om-NavItem" data-pl-id="${pl.id}">
            <div class="om-NavItem__left">
              ${icon('list', { size: 16 })}
              <span class="om-NavItem__text">${pl.name}</span>
            </div>
            <span class="om-NavItem__count tnum">${pl.trackCount ?? pl.tracks?.length ?? 0}</span>
          </div>`,
        )
        .join('');
      plSlot.querySelectorAll('[data-pl-id]').forEach((el) => {
        el.addEventListener('click', () => {
          const id = el.getAttribute('data-pl-id');
          const pl = state.playlists.find((x) => x.id === id);
          if (pl && Array.isArray(pl.tracks) && pl.tracks.length > 0) {
            ApiClient.play(pl.tracks, 0).catch(console.error);
          }
        });
      });
    }
  }
}
