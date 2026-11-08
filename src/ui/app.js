/*
 * OurMusic — Entrada Principal del Frontend (Fases 1, 2, 3 y 4 Completas)
 * Suite HiFi completa: Store reactivo, API REST y SSE, Álbumes, Pistas,
 * Artistas y Géneros, Explorador de Carpetas Locales, Consola DSP 64-bit,
 * Cola de Reproducción Drag & Drop, Modo Inmersivo con Letras .LRC,
 * Menús Contextuales con Clic Derecho, Inspector de Metadatos y Toasts.
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
import { FoldersView } from './js/foldersView.js';
import { ArtistsView } from './js/artistsView.js';
import { ContextMenu } from './js/contextMenu.js';
import { TagInspectorModal } from './js/tagInspectorModal.js';
import { ShortcutsModal } from './js/shortcutsModal.js';
import { toasts } from './js/toasts.js';
import { icon } from './js/icons.js';

class App {
  constructor() {
    this.searchOverlay = null;
    this.currentDrawer = null;
    this.currentDrawerType = null;
    this.immersiveView = null;
    this.contextMenu = null;
    this.init();
  }

  async init() {
    console.log('[OurMusic UI] Inicializando Fases 1 a 4...');

    // Instanciar Gestor de Menú Contextual Global
    this.contextMenu = new ContextMenu({ store });

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
        case 'track_started': {
          const startedTrack =
            data.track ||
            store.state.queueState?.currentTrack ||
            store.state.tracks?.find((t) => t.filePath === data.path) ||
            store.state.playback?.track ||
            (data.path
              ? {
                  id: data.path,
                  filePath: data.path,
                  title: data.path.split('/').pop(),
                  artist: 'Reproduciendo',
                  codec: data.codec || 'PCM',
                  sampleRate: data.sampleRate || 44100,
                  bitDepth: data.bitDepth || 16,
                }
              : null);
          store.setState({
            playback: {
              state: 'playing',
              track: startedTrack,
              isDsdNative: Boolean(data.isDsdNative),
              isDop: Boolean(data.isDop),
            },
          });
          break;
        }
        case 'playback_ended':
          store.setState({ playback: { state: 'stopped' } });
          break;
        case 'queue_updated': {
          const nextPlayback = {};
          if (data?.currentTrack) {
            nextPlayback.track = data.currentTrack;
          }
          if (data?.repeatMode !== undefined) {
            nextPlayback.repeat = data.repeatMode;
          }
          if (typeof data?.shuffle === 'boolean') {
            nextPlayback.shuffle = data.shuffle;
          }
          store.setState({
            queueState: data,
            ...(Object.keys(nextPlayback).length > 0 ? { playback: nextPlayback } : {}),
          });
          break;
        }
        case 'eq_updated':
          store.setState({ eqState: data });
          break;
        case 'library_changed':
        case 'scan_completed':
          this.refreshSummary();
          toasts.show({
            title: 'Biblioteca actualizada',
            message: 'Índice SQLite FTS5 sincronizado',
            type: 'info',
          });
          break;
        case 'watcher_indexed':
          toasts.show({
            title: 'Nueva pista indexada',
            message: data.path ? data.path.split('/').pop() : 'Vigilancia inotify',
            type: 'success',
          });
          break;
        case 'watcher_removed':
          toasts.show({
            title: 'Archivo eliminado',
            message: data.path ? data.path.split('/').pop() : 'Actualizado en biblioteca',
            type: 'info',
          });
          break;
      }
    });
  }

  async loadInitialData() {
    try {
      const boot = await ApiClient.getBootstrap(250, 0);
      store.setState({
        summary: boot.librarySummary || boot.summary || {},
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
      const [res, tracksRes, plRes] = await Promise.all([
        ApiClient.getSummary().catch(() => null),
        ApiClient.getTracks({ limit: 250, offset: 0 }).catch(() => null),
        ApiClient.get('/api/playlists').catch(() => null),
      ]);
      const nextState = {};
      if (res) nextState.summary = res.summary || res;
      if (tracksRes?.tracks) nextState.tracks = tracksRes.tracks;
      if (plRes?.playlists) nextState.playlists = plRes.playlists;
      if (plRes?.smartPlaylists) nextState.smartPlaylists = plRes.smartPlaylists;
      store.setState(nextState);
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
        onContextMenu: (args) => this.contextMenu.show(args),
      });
    } else if (['artists', 'genres', 'composers'].includes(view)) {
      const av = new ArtistsView({
        container,
        store,
        onArtistSelect: (name) => {
          store.setState({ currentView: 'tracks', searchQuery: name });
        },
      });
      av.filterMode = view;
      av.render();
      av.bindEvents();
    } else if (view === 'folders') {
      new FoldersView({
        container,
        store,
        onTrackClick: (trk) => ApiClient.play(trk).catch(console.error),
        onContextMenu: (args) => this.contextMenu.show(args),
      });
    } else {
      new AlbumsView({
        container,
        store,
        onAlbumClick: (albumData) => {
          this.openAlbumDetail(albumData, container);
        },
      });
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
      onContextMenu: (args) => this.contextMenu.show(args),
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
      } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        new ShortcutsModal({});
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
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        const currentTrk = store.state.playback?.track;
        if (currentTrk) {
          new TagInspectorModal({ store, tracks: [currentTrk] });
        }
      } else if (e.key === '1') {
        store.setState({ currentView: 'albums' });
      } else if (e.key === '2') {
        store.setState({ currentView: 'tracks' });
      } else if (e.key === '3') {
        store.setState({ currentView: 'folders' });
      } else if (e.key === 'm' || e.key === 'M') {
        const curVol = store.state.playback.volume || 0.8;
        const newVol = curVol > 0 ? 0 : 0.8;
        ApiClient.setVolume(newVol).catch(console.error);
        store.setState({ playback: { volume: newVol } });
      } else if (e.key === 's' || e.key === 'S') {
        const cur = store.state.playback.shuffle;
        ApiClient.setModes({ shuffle: !cur }).catch(console.error);
      } else if (e.key === 'r' || e.key === 'R') {
        const cur = store.state.playback.repeat;
        const modes = ['off', 'all', 'one'];
        const next = modes[(modes.indexOf(cur) + 1) % modes.length];
        ApiClient.setModes({ repeat: next }).catch(console.error);
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
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        const cur = store.state.playback.positionSec || 0;
        ApiClient.seek(cur + 10).catch(console.error);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        const cur = store.state.playback.positionSec || 0;
        ApiClient.seek(Math.max(0, cur - 10)).catch(console.error);
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        const cur = store.state.playback.volume ?? 0.8;
        const next = Math.min(1.0, cur + 0.05);
        ApiClient.setVolume(next).catch(console.error);
        store.setState({ playback: { volume: next } });
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        const cur = store.state.playback.volume ?? 0.8;
        const next = Math.max(0, cur - 0.05);
        ApiClient.setVolume(next).catch(console.error);
        store.setState({ playback: { volume: next } });
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.__ourmusic = new App();
});
