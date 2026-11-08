/*
 * OurMusic — Vista de Cuadrícula de Álbumes (Fase 2)
 */
import { icon } from './icons.js';
import { coverSvg } from './visuals.js';
import { ApiClient } from './api.js';

export class AlbumsView {
  constructor({ container, store, onAlbumClick }) {
    this.container = container;
    this.store = store;
    this.onAlbumClick = onAlbumClick;

    this.render();
    this.bindEvents();

    this.store.subscribe((state, keys) => {
      if (keys.includes('summary') || keys.includes('activeFilter')) {
        this.update(state);
      }
    });
  }

  render() {
    this.container.innerHTML = `
      <div class="om-Content">
        <div class="om-SectionToolbar">
          <div class="om-SectionToolbar__title">
            <h1>Álbumes</h1>
            <span class="om-SectionToolbar__sub tnum" id="albums-count-sub">0 álbumes</span>
          </div>
          <div class="om-FilterPills" id="album-filter-pills">
            <span class="om-Pill is-active" data-filter="all">Todos</span>
            <span class="om-Pill" data-filter="hires">Hi-Res (24-bit / DSD)</span>
            <span class="om-Pill" data-filter="lossless">Lossless</span>
          </div>
        </div>

        <div class="om-AlbumGrid" id="albums-grid">
          <!-- Renderizado dinámico -->
        </div>
      </div>
    `;
  }

  bindEvents() {
    this.container.querySelectorAll('[data-filter]').forEach((pill) => {
      pill.addEventListener('click', () => {
        this.container.querySelectorAll('[data-filter]').forEach((p) => p.classList.remove('is-active'));
        pill.classList.add('is-active');
        const filter = pill.getAttribute('data-filter');
        this.store.setState({ activeFilter: filter });
      });
    });
  }

  update(state) {
    const { summary, activeFilter } = state;
    const albums = summary.albums || [];

    const subEl = this.container.querySelector('#albums-count-sub');
    if (subEl) {
      subEl.textContent = `${albums.length.toLocaleString()} álbumes · ${summary.totalTracks?.toLocaleString() || 0} pistas`;
    }

    const grid = this.container.querySelector('#albums-grid');
    if (!grid) return;

    if (albums.length === 0) {
      grid.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 48px; text-align: center; color: var(--text-3)">
          No se encontraron álbumes en tu biblioteca.
        </div>
      `;
      return;
    }

    grid.innerHTML = albums
      .map((alb) => {
        const coverHtml = alb.coverId
          ? `<img src="/api/covers/${encodeURIComponent(alb.coverId)}" class="cover-svg" style="width:100%;height:100%;object-fit:cover" alt="Cover" />`
          : coverSvg({ title: alb.album, artist: alb.artist, palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'], style: 'waves' });

        return `
          <article class="om-AlbumCard" data-album-name="${alb.album}" data-artist-name="${alb.artist}" style="cursor:pointer">
            <div class="om-AlbumCard__art">
              ${coverHtml}
              <div class="om-AlbumCard__play" data-play-album="${alb.album}" title="Reproducir álbum">${icon('play', { size: 16 })}</div>
            </div>
            <div class="om-AlbumCard__title">${alb.album}</div>
            <div class="om-AlbumCard__sub">
              <span>${alb.artist}</span>
              <span class="tnum">${alb.year || ''}</span>
            </div>
          </article>
        `;
      })
      .join('');

    // Eventos de clic en tarjeta o botón play
    grid.querySelectorAll('.om-AlbumCard').forEach((card) => {
      card.addEventListener('click', (e) => {
        const playBtn = e.target.closest('[data-play-album]');
        const albumName = card.getAttribute('data-album-name');
        const artistName = card.getAttribute('data-artist-name');

        if (playBtn) {
          e.stopPropagation();
          this.playAlbumDirectly(albumName);
          return;
        }

        if (this.onAlbumClick) {
          this.onAlbumClick({ album: albumName, artist: artistName });
        }
      });
    });
  }

  async playAlbumDirectly(albumName) {
    try {
      const res = await ApiClient.getTracks({ album: albumName, sortBy: 'trackNumber', sortOrder: 'asc' });
      if (res.tracks && res.tracks.length > 0) {
        await ApiClient.play(res.tracks[0]);
        if (res.tracks.length > 1) {
          await ApiClient.enqueue({ tracks: res.tracks.slice(1) });
        }
      }
    } catch (err) {
      console.error('Error reproduciendo álbum completo:', err);
    }
  }
}
