/*
 * OurMusic — Entrada Principal del Frontend (Fase 1 y Fase 2 Completas)
 * Enlaza Store, API REST, SSE, Vistas de Álbumes, Detalle de Álbum,
 * Tabla de Pistas con Columnas y Búsqueda Instantánea FTS5.
 */
import { store } from './js/store.js';
import { ApiClient } from './js/api.js';
import { Sidebar } from './js/sidebar.js';
import { Topbar } from './js/topbar.js';
import { NowPlayingBar } from './js/nowPlayingBar.js';
import { AlbumsView } from './js/albumsView.js';
import { AlbumDetailView } from './js/albumDetailView.js';
import { TracksTableView } from './js/tracksTableView.js';
import { SearchDropdown } from './js/searchDropdown.js';
import { icon } from './js/icons.js';

class App {
  constructor() {
    this.searchOverlay = null;
    this.init();
  }

  async init() {
    console.log('[OurMusic UI] Inicializando Fase 1 & Fase 2...');

    // Instanciar Componentes del Esqueleto
    this.sidebar = new Sidebar({
      container: document.getElementById('sidebar-container'),
      store,
    });

    this.topbar = new Topbar({
      container: document.getElementById('topbar-container'),
      store,
    });

    this.nowPlaying = new NowPlayingBar({
      container: document.getElementById('nowplaying-container'),
      store,
    });

    // Contenedor flotante para Búsqueda Instantánea
    this.searchContainer = document.createElement('div');
    this.searchContainer.id = 'search-overlay-container';
    document.body.appendChild(this.searchContainer);

    this.searchDropdown = new SearchDropdown({
      container: this.searchContainer,
      store,
      onClose: () => {
        store.setState({ searchQuery: '' });
        const input = document.getElementById('global-search-input');
        if (input) input.value = '';
      },
    });

    // Escuchar cambios de búsqueda en el Store
    store.subscribe((state, keys) => {
      if (keys.includes('searchQuery')) {
        if (state.searchQuery) {
          this.searchDropdown.search(state.searchQuery);
        } else {
          this.searchDropdown.close();
        }
      }
    });

    // Conectar Stream SSE en Tiempo Real
    this.initSSE();

    // Cargar Bootstrap Inicial de la API
    await this.loadInitialData();

    // Router de Vistas Principales
    this.initViewRouter();

    // Atajos de Teclado Globales
    this.bindGlobalKeyboard();
  }

  initSSE() {
    ApiClient.subscribeEvents((event, data) => {
      switch (event) {
        case 'telemetry':
          store.setPlaybackTelemetry(data);
          break;
        case 'track_started':
          store.setState({
            playback: {
              state: 'playing',
              track: data.track,
              isDsdNative: Boolean(data.isDsdNative),
              isDop: Boolean(data.isDop),
            },
          });
          break;
        case 'playback_ended':
          store.setState({ playback: { state: 'stopped' } });
          break;
        case 'library_changed':
        case 'scan_completed':
          this.refreshSummary();
          break;
        case 'watcher_indexed':
        case 'watcher_removed':
          console.log(`[SSE Watcher] ${event}:`, data);
          break;
      }
    });
  }

  async loadInitialData() {
    try {
      const boot = await ApiClient.getBootstrap(100, 0);
      store.setState({
        summary: boot.summary || {},
        tracks: boot.tracks || [],
        queue: boot.queue || [],
        playlists: boot.playlists || [],
        smartPlaylists: boot.smartPlaylists || [],
      });

      if (boot.status) {
        store.setPlaybackTelemetry(boot.status);
      }
      if (boot.currentTrack) {
        store.setState({ playback: { track: boot.currentTrack } });
      }
    } catch (err) {
      console.error('[OurMusic UI] Error cargando bootstrap:', err);
    }
  }

  async refreshSummary() {
    try {
      const summary = await ApiClient.getSummary();
      store.setState({ summary });
    } catch (err) {
      console.error('Error refrescando summary:', err);
    }
  }

  initViewRouter() {
    const mainSlot = document.getElementById('main-content-slot');
    if (!mainSlot) return;

    store.subscribe((state, keys) => {
      if (keys.includes('currentView')) {
        this.renderCurrentView(state.currentView, mainSlot);
      }
    });

    this.renderCurrentView(store.state.currentView, mainSlot);
  }

  renderCurrentView(view, container) {
    container.innerHTML = '';

    if (view === 'albums') {
      new AlbumsView({
        container,
        store,
        onAlbumClick: (albumData) => {
          this.openAlbumDetail(albumData, container);
        },
      });
    } else if (view === 'tracks') {
      new TracksTableView({
        container,
        store,
      });
    } else {
      // Placeholder para vistas restantes (Artistas, Géneros, Carpetas)
      container.innerHTML = `
        <div class="om-Content">
          <div class="om-SectionToolbar">
            <h1>${view.toUpperCase()}</h1>
          </div>
          <div style="padding:48px;text-align:center;color:var(--text-3)">
            Vista preparada para Fase 3 & 4.
          </div>
        </div>
      `;
    }
  }

  openAlbumDetail(albumData, container) {
    container.innerHTML = '';
    new AlbumDetailView({
      container,
      store,
      albumData,
      onBack: () => {
        store.setState({ currentView: 'albums' });
      },
    });
  }

  bindGlobalKeyboard() {
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
          store.setState({ searchQuery: '' });
        }
        return;
      }

      if (e.code === 'Space') {
        e.preventDefault();
        const { playback } = store.state;
        if (playback.state === 'playing') {
          ApiClient.pause().catch(console.error);
        } else {
          ApiClient.play().catch(console.error);
        }
      } else if (e.code === 'ArrowRight' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ApiClient.next().catch(console.error);
      } else if (e.code === 'ArrowLeft' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ApiClient.previous().catch(console.error);
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.__ourmusic = new App();
});
