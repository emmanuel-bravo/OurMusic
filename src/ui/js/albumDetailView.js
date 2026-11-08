/*
 * OurMusic — Vista Detallada de Álbum (Hero + Pistas del Álbum)
 */
import { icon } from './icons.js';
import { coverSvg, applyAccent, avatarColor, initials } from './visuals.js';
import { ApiClient } from './api.js';

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class AlbumDetailView {
  constructor({ container, store, albumData, onBack, onContextMenu }) {
    this.container = container;
    this.store = store;
    this.albumData = albumData;
    this.onBack = onBack;
    this.onContextMenu = onContextMenu;
    this.tracks = [];

    this.render();
    this.loadAlbumTracks();

    this.store.subscribe((state, keys) => {
      if (keys.includes('playback')) {
        this.updatePlayingRow(state.playback);
      }
    });
  }

  render() {
    this.container.innerHTML = `
      <section class="om-AlbumHero" id="album-hero-section">
        <div class="om-AlbumHero__cover" id="hero-cover-slot">
          <!-- Portada -->
        </div>
        <div class="om-AlbumHero__info">
          <div class="om-AlbumHero__eyebrow">
            <button class="om-IconBtn" id="hero-back-btn" title="Volver a Álbumes" style="margin-right:6px">
              ${icon('chevronLeft', { size: 16 })}
            </button>
            <span>Álbum Local</span>
            <span>•</span>
            <span id="hero-format-badge">FLAC / Hi-Res</span>
          </div>
          <h1 class="om-AlbumHero__title" id="hero-album-title">${this.albumData.album}</h1>
          <div class="om-AlbumHero__meta" id="hero-meta-row">
            <span class="om-AvatarInitials" id="hero-artist-avatar" style="width:22px;height:22px;font-size:10px"></span>
            <strong id="hero-artist-name">${this.albumData.artist || 'Artista'}</strong>
            <span>•</span>
            <span id="hero-track-count" class="tnum">Cargando pistas…</span>
          </div>
          <div class="om-AlbumHero__actions">
            <button class="om-BtnPrimary" id="hero-play-all-btn" style="cursor:pointer">
              ${icon('play', { size: 15 })}<span>Reproducir álbum</span>
            </button>
            <button class="om-BtnGhost" id="hero-play-next-btn" style="cursor:pointer">
              ${icon('playNext', { size: 15 })}<span>Reproducir a continuación</span>
            </button>
            <button class="om-BtnGhost" id="hero-add-queue-btn" style="cursor:pointer">
              ${icon('addQueue', { size: 15 })}<span>Añadir a la cola</span>
            </button>
          </div>
        </div>
      </section>

      <div class="om-Content" style="padding-top:12px;overflow-y:auto">
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
          <tbody id="hero-tracks-tbody">
            <tr><td colspan="5" style="text-align:center;padding:24px;color:var(--text-3)">Cargando lista de canciones…</td></tr>
          </tbody>
        </table>
      </div>
    `;

    this.container.querySelector('#hero-back-btn')?.addEventListener('click', () => {
      if (this.onBack) this.onBack();
    });

    const artistName = this.albumData.artist || 'Artista';
    const avatar = this.container.querySelector('#hero-artist-avatar');
    if (avatar) {
      avatar.style.background = avatarColor(artistName);
      avatar.textContent = initials(artistName);
    }
  }

  async loadAlbumTracks() {
    try {
      const res = await ApiClient.getTracks({
        album: this.albumData.album,
        sortBy: 'trackNumber',
        sortOrder: 'asc',
      });
      this.tracks = res.tracks || [];

      // Actualizar Portada y Acento Dinámico
      const coverSlot = this.container.querySelector('#hero-cover-slot');
      if (coverSlot) {
        const coverId = this.tracks.find((t) => t.coverId)?.coverId;
        if (coverId) {
          coverSlot.innerHTML = `<img src="/api/covers/${encodeURIComponent(coverId)}" class="cover-svg" style="width:100%;height:100%;object-fit:cover" alt="Cover" />`;
        } else {
          coverSlot.innerHTML = coverSvg({
            title: this.albumData.album,
            artist: this.albumData.artist || '',
            palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'],
            style: 'horizon',
          });
        }
      }

      // Metadata
      const totalDur = this.tracks.reduce((acc, t) => acc + (t.durationSec || 0), 0);
      const trackCountEl = this.container.querySelector('#hero-track-count');
      if (trackCountEl) {
        trackCountEl.textContent = `${this.tracks.length} pistas · ${formatDuration(totalDur)}`;
      }

      this.renderTrackRows();
      this.bindActionButtons();
    } catch (err) {
      console.error('Error cargando pistas del álbum:', err);
    }
  }

  renderTrackRows() {
    const tbody = this.container.querySelector('#hero-tracks-tbody');
    if (!tbody) return;

    const currentTrackId = this.store.state.playback?.track?.id;

    tbody.innerHTML = this.tracks
      .map((t, idx) => {
        const isPlaying = currentTrackId && t.id === currentTrackId;
        const dur = formatDuration(t.durationSec);
        const lufs = t.integratedLufs ? `${t.integratedLufs.toFixed(1)} LUFS` : '--';
        const formatStr = t.codec === 'DSD' ? 'DSD' : `${t.codec || 'PCM'} ${t.bitDepth || 16}/${((t.sampleRate || 44100) / 1000).toFixed(1)}k`;

        return `
          <tr class="${isPlaying ? 'is-playing' : ''}" data-track-id="${t.id}" style="cursor:pointer">
            <td class="tnum">${isPlaying ? icon('bars', { size: 15 }) : (t.trackNumber || idx + 1)}</td>
            <td>
              <span class="om-TrackTitle">${t.title || t.fileName}</span>
              ${t.hasSyncedLyrics ? '<span class="om-TagMini">LRC</span>' : ''}
            </td>
            <td class="tnum">${formatStr}</td>
            <td class="tnum">${lufs}</td>
            <td class="tnum" style="text-align:right">${dur}</td>
          </tr>
        `;
      })
      .join('');

    // Clic para reproducir o clic derecho para menú contextual
    tbody.querySelectorAll('tr[data-track-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const trkId = row.getAttribute('data-track-id');
        const trk = this.tracks.find((t) => t.id === trkId);
        if (trk) {
          ApiClient.play(trk).catch(console.error);
        }
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const trkId = row.getAttribute('data-track-id');
        const trk = this.tracks.find((t) => t.id === trkId);
        if (trk && this.onContextMenu) {
          this.onContextMenu({ x: e.clientX, y: e.clientY, track: trk });
        }
      });
    });
  }

  updatePlayingRow(playback) {
    const curId = playback?.track?.id;
    const tbody = this.container.querySelector('#hero-tracks-tbody');
    if (!tbody) return;

    tbody.querySelectorAll('tr[data-track-id]').forEach((row) => {
      const id = row.getAttribute('data-track-id');
      const isPlay = id === curId;
      row.classList.toggle('is-playing', isPlay);
    });
  }

  bindActionButtons() {
    this.container.querySelector('#hero-play-all-btn')?.addEventListener('click', async () => {
      if (this.tracks.length > 0) {
        await ApiClient.play(this.tracks, 0);
      }
    });

    this.container.querySelector('#hero-play-next-btn')?.addEventListener('click', async () => {
      if (this.tracks.length > 0) {
        await ApiClient.enqueue({ tracks: this.tracks, playNext: true });
      }
    });

    this.container.querySelector('#hero-add-queue-btn')?.addEventListener('click', async () => {
      if (this.tracks.length > 0) {
        await ApiClient.enqueue({ tracks: this.tracks, playNext: false });
      }
    });
  }
}
