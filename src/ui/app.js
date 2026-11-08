/*
 * OurMusic — Entrada Principal del Frontend (Fase 1, 2 y 3 Completas)
 * Enlaza Store, API REST, SSE, Vistas de Álbumes, Detalle de Álbum,
 * Tabla de Pistas con Columnas, Búsqueda Instantánea FTS5,
 * Paneles Desplegables de Cola de Reproducción y Consola DSP, y
 * Modo Inmersivo de Sala de Escucha con Letras Sincronizadas (.LRC).
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
import { QueueDrawer } from './js/queueDrawer.js';
import { DspDrawer } from './js/dspDrawer.js';
import { ImmersiveLyricsView } from './js/immersiveLyricsView.js';
import { icon } from './js/icons.js';

class App {
  constructor() {
    this.searchOverlay = null;
    this.currentDrawer = null;
    this.currentDrawerType = null;
    this.immersiveView = null;
    this.init();
  }

  async init() {
    console.log('[OurMusic UI] Inicializando Fase 1, Fase 2 & Fase 3...');

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

    // Conectar Paneles Desplegables y Modo Inmersivo
    this.initDrawersAndImmersive();

    // Conectar Stream SSE en Tiempo Real
    this.initSSE();

    // Cargar Bootstrap Inicial de la API
    await this.loadInitialData();

    // Router de Vistas Principales
    this.initViewRouter();

    // Atajos de Teclado Globales
    this.bindGlobalKeyboard();
  }

  initDrawersAndImmersive() {
    const drawerSlot = document.getElementById('drawer-slot');
    const immersiveSlot = document.getElementById('immersive-slot');

    store.subscribe((state, keys) => {
      // 1. Manejo de Drawer Lateral (Queue o DSP)
      if (keys.includes('activeDrawer')) {
        const targetType = state.activeDrawer;

        if (targetType !== this.currentDrawerType) {
          if (this.currentDrawer) {
            this.currentDrawer.destroy();
            this.currentDrawer = null;
            this.currentDrawerType = null;
          }

          if (targetType === 'queue') {
            drawerSlot.style.display = 'block';
            drawerSlot.style.width = '390px';
            this.currentDrawerType = 'queue';
            this.currentDrawer = new QueueDrawer({
              container: drawerSlot,
              store,
              onClose: () => store.setState({ activeDrawer: null }),
            });
          } else if (targetType === 'dsp') {
            drawerSlot.style.display = 'block';
            drawerSlot.style.width = '390px';
            this.currentDrawerType = 'dsp';
            this.currentDrawer = new DspDrawer({
              container: drawerSlot,
              store,
              onClose: () => store.setState({ activeDrawer: null }),
            });
          } else {
            drawerSlot.style.display = 'none';
            drawerSlot.innerHTML = '';
          }
        }
      }

      // 2. Manejo de Modo Inmersivo Fullscreen
      if (keys.includes('immersiveOpen')) {
        if (state.immersiveOpen) {
          immersiveSlot.style.display = 'block';
          if (!this.immersiveView) {
            this.immersiveView = new ImmersiveLyricsView({
              container: immersiveSlot,
              store,
              onClose: () => store.setState({ immersiveOpen: false }),
            });
          }
        } else {
          immersiveSlot.style.display = 'none';
          if (this.immersiveView) {
            this.immersiveView.destroy();
            this.immersiveView = null;
          }
        }
      }
    });
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
        case 'queue_updated':
          store.setState({ queueState: data });
          break;
        case 'eq_updated':
          store.setState({ eqState: data });
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
        queueState: boot.queueState || { queue: [], currentIndex: -1 },
        eqState: boot.eqState || null,
        presets: boot.presets || [],
        playlists: boot.playlists || [],
        smartPlaylists: boot.smartPlaylists || [],
      });

      if (boot.status) {
        store.setPlaybackTelemetry(boot.status);
      }
      if (boot.currentTrack) {
        store.setState({ playback: { track: boot.currentTrack } });
      } else if (boot.queueState?.currentTrack) {
        store.setState({ playback: { track: boot.queueState.currentTrack } });
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
            Vista preparada para Fase 4.
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
      // Ignorar teclas si se escribe en un input o textarea
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        if (e.key === 'Escape') {
          document.activeElement.blur();
          store.setState({ searchQuery: '' });
        }
        return;
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        if (store.state.immersiveOpen) {
          store.setState({ immersiveOpen: false });
        } else if (store.state.activeDrawer) {
          store.setState({ activeDrawer: null });
        } else if (store.state.searchQuery) {
          store.setState({ searchQuery: '' });
        }
      } else if (e.key === 'F11') {
        e.preventDefault();
        store.setState({ immersiveOpen: !store.state.immersiveOpen });
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'q' || e.key === 'Q')) {
        e.preventDefault();
        const cur = store.state.activeDrawer;
        store.setState({ activeDrawer: cur === 'queue' ? null : 'queue' });
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        const cur = store.state.activeDrawer;
        store.setState({ activeDrawer: cur === 'dsp' ? null : 'dsp' });
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        store.setState({ immersiveOpen: !store.state.immersiveOpen });
      } else if (e.code === 'Space') {
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
