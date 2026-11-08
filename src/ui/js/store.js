/*
 * OurMusic — Gestor de Estado Global Reactivo (Fase 1)
 */

export class Store {
  constructor() {
    this.state = {
      // Navegación
      currentView: 'albums', // 'albums' | 'tracks' | 'artists' | 'genres' | 'composers' | 'folders'
      breadcrumbs: ['Biblioteca', 'Álbumes'],
      sidebarCollapsed: false,
      activeDrawer: null, // null | 'queue' | 'dsp'
      immersiveOpen: false, // Modo pantalla completa / sala de escucha
      showSignalPopover: false,

      // Reproducción activa
      playback: {
        state: 'stopped', // 'playing' | 'paused' | 'stopped'
        track: null,
        positionSec: 0,
        durationSec: 0,
        progress: 0,
        volume: 0.8,
        repeat: 'off', // 'off' | 'all' | 'one'
        shuffle: false,
        device: 'ALSA Default / WASAPI',
        outputMode: 'Bit-Perfect',
        isDsdNative: false,
        isDop: false,
      },

      // Cola de Reproducción
      queueState: {
        queue: [],
        currentIndex: -1,
        currentTrack: null,
        repeatMode: 'off',
        shuffle: false,
      },

      // Estado DSP y Ecualizador
      eqState: null,
      dspState: null,
      presets: [],

      // Biblioteca
      summary: {
        totalTracks: 0,
        totalAlbums: 0,
        totalArtists: 0,
        hiResCount: 0,
        totalDurationSec: 0,
        codecs: {},
        folders: [],
        albums: [],
        artists: [],
      },
      dbStats: null,
      tracks: [],
      queue: [],
      playlists: [],
      smartPlaylists: [],

      // Filtros rápidos
      activeFilter: 'all', // 'all' | 'hires' | 'lossless' | 'lyrics'
      searchQuery: '',
    };

    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(changedKeys = []) {
    for (const l of this.listeners) {
      try {
        l(this.state, changedKeys);
      } catch (err) {
        console.error('Error en listener de Store:', err);
      }
    }
  }

  setState(partial) {
    const keys = Object.keys(partial);
    for (const k of keys) {
      if (typeof partial[k] === 'object' && partial[k] !== null && !Array.isArray(partial[k])) {
        this.state[k] = { ...this.state[k], ...partial[k] };
      } else {
        this.state[k] = partial[k];
      }
    }
    this.notify(keys);
  }

  setPlaybackTelemetry(tel) {
    const p = this.state.playback;
    const dur = tel.durationSec || p.durationSec || 0;
    const pos = tel.positionSec !== undefined ? tel.positionSec : p.positionSec;
    const prog = dur > 0 ? Math.min(1, Math.max(0, pos / dur)) : 0;

    this.setState({
      playback: {
        ...p,
        state: tel.state || p.state,
        positionSec: pos,
        durationSec: dur,
        progress: prog,
        volume: tel.volume !== undefined ? tel.volume : p.volume,
        repeat: tel.repeat || p.repeat,
        shuffle: tel.shuffle !== undefined ? tel.shuffle : p.shuffle,
        device: tel.device || p.device,
        outputMode: tel.outputMode || (tel.resamplerActive || tel.dspActive ? 'DSP 64-bit' : 'Bit-Perfect'),
        isDsdNative: Boolean(tel.isDsdNative),
        isDop: Boolean(tel.isDop),
      },
    });
  }
}

export const store = new Store();
