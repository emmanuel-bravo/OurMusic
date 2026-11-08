/*
 * OurMusic — Vista de Artistas, Géneros y Compositores (Fase 4)
 * Avatares generados proceduralmente con iniciales (100% offline), agrupación por
 * metadatos y navegación directa hacia los álbumes y pistas correspondientes.
 */
import { icon } from './icons.js';
import { avatarColor, initials } from './visuals.js';

export class ArtistsView {
  constructor({ container, store, onArtistSelect }) {
    this.container = container;
    this.store = store;
    this.onArtistSelect = onArtistSelect;
    this.filterMode = 'artists'; // 'artists' | 'composers' | 'genres'

    this.render();
    this.bindEvents();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (keys.includes('tracks') || keys.includes('summary')) {
        this.render();
        this.bindEvents();
      }
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.container.innerHTML = '';
  }

  buildData() {
    const { tracks, summary } = this.store.state;

    if (this.filterMode === 'genres') {
      const map = new Map();
      tracks.forEach((t) => {
        const g = t.genre || 'Desconocido';
        const cur = map.get(g) || { name: g, count: 0, tracks: [] };
        cur.count++;
        cur.tracks.push(t);
        map.set(g, cur);
      });
      return Array.from(map.values()).sort((a, b) => b.count - a.count);
    }

    if (this.filterMode === 'composers') {
      const map = new Map();
      tracks.forEach((t) => {
        const c = t.composer || 'Sin compositor asignado';
        const cur = map.get(c) || { name: c, count: 0, albums: new Set() };
        cur.count++;
        if (t.album) cur.albums.add(t.album);
        map.set(c, cur);
      });
      return Array.from(map.values())
        .map((x) => ({ name: x.name, count: x.count, albumCount: x.albums.size }))
        .sort((a, b) => b.count - a.count);
    }

    // Default: 'artists'
    const map = new Map();
    tracks.forEach((t) => {
      const a = t.artist || 'Artista Desconocido';
      const cur = map.get(a) || { name: a, tracks: 0, albums: new Set() };
      cur.tracks++;
      if (t.album) cur.albums.add(t.album);
      map.set(a, cur);
    });

    return Array.from(map.values())
      .map((x) => ({ name: x.name, trackCount: x.tracks, albumCount: x.albums.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  render() {
    const data = this.buildData();
    const title =
      this.filterMode === 'genres'
        ? 'Géneros Musicales'
        : this.filterMode === 'composers'
          ? 'Compositores'
          : 'Artistas';

    this.container.innerHTML = `
      <div class="om-Content" style="display:flex;flex-direction:column;height:100%;overflow-y:auto;padding-bottom:28px">
        <div class="om-SectionToolbar">
          <div class="om-SectionToolbar__title">
            <h1>${title}</h1>
            <span class="om-SectionToolbar__sub tnum">
              ${data.length} elementos indexados · Avatares generados con iniciales (100% offline)
            </span>
          </div>

          <div class="om-FilterPills">
            <span class="om-Pill ${this.filterMode === 'artists' ? 'is-active' : ''}" id="pill-mode-artists" style="cursor:pointer">
              Artistas del álbum
            </span>
            <span class="om-Pill ${this.filterMode === 'composers' ? 'is-active' : ''}" id="pill-mode-composers" style="cursor:pointer">
              Compositores
            </span>
            <span class="om-Pill ${this.filterMode === 'genres' ? 'is-active' : ''}" id="pill-mode-genres" style="cursor:pointer">
              Géneros
            </span>
          </div>
        </div>

        <div class="om-ArtistGrid" style="padding:0 24px">
          ${
            data.length > 0
              ? data
                  .map((item) => {
                    const bg = avatarColor(item.name);
                    const init = initials(item.name);
                    const sub =
                      this.filterMode === 'genres'
                        ? `${item.count} pistas`
                        : `${item.albumCount || 0} álb · ${item.trackCount || item.count || 0} pistas`;

                    return `
                <article class="om-ArtistCard artist-card" data-name="${this.escapeAttr(item.name)}" style="cursor:pointer;padding:16px 12px;border-radius:var(--r-12);background:var(--bg-1);border:1px solid var(--line-1);display:flex;flex-direction:column;align-items:center;text-align:center;transition:transform 0.15s ease, border-color 0.15s ease">
                  <div class="om-ArtistCard__avatar" style="width:72px;height:72px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#fff;margin-bottom:12px;box-shadow:0 6px 16px rgba(0,0,0,0.3)">
                    ${init}
                  </div>
                  <div class="om-AlbumCard__title" style="font-weight:700;font-size:14px;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%">
                    ${item.name}
                  </div>
                  <div class="om-AlbumCard__sub tnum" style="font-size:11px;color:var(--text-3);margin-top:4px">
                    ${sub}
                  </div>
                </article>
              `;
                  })
                  .join('')
              : `
            <div style="grid-column:1/-1;padding:48px;text-align:center;color:var(--text-3)">
              No se encontraron elementos indexados en esta categoría
            </div>
          `
          }
        </div>
      </div>
    `;
  }

  escapeAttr(val) {
    return String(val ?? '')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  bindEvents() {
    const bindPill = (id, mode) => {
      const el = this.container.querySelector(id);
      if (el) {
        el.addEventListener('click', () => {
          this.filterMode = mode;
          this.render();
          this.bindEvents();
        });
      }
    };

    bindPill('#pill-mode-artists', 'artists');
    bindPill('#pill-mode-composers', 'composers');
    bindPill('#pill-mode-genres', 'genres');

    const cards = this.container.querySelectorAll('.artist-card');
    cards.forEach((card) => {
      card.addEventListener('click', () => {
        const name = card.getAttribute('data-name');
        if (this.onArtistSelect) {
          this.onArtistSelect(name, this.filterMode);
        } else {
          // Filtrar en la vista de pistas
          this.store.setState({
            currentView: 'tracks',
            searchQuery: name,
          });
        }
      });
    });
  }
}
