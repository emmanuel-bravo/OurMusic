/*
 * OurMusic — Overlay de Búsqueda Global Instantánea FTS5
 */
import { icon } from './icons.js';
import { coverSvg, avatarColor, initials } from './visuals.js';
import { ApiClient } from './api.js';

export class SearchDropdown {
  constructor({ container, store, onSelectResult, onClose }) {
    this.container = container;
    this.store = store;
    this.onSelectResult = onSelectResult;
    this.onClose = onClose;
    this.results = [];
    this.perfMs = 0;
    this.isOpen = false;
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.render();
  }

  render() {
    this.container.innerHTML = `
      <div class="om-Scrim" id="search-scrim"></div>
      <section class="om-SearchDropdown" aria-label="Resultados instantáneos SQLite FTS5">
        <div class="om-SearchDropdown__head">
          <span>Índice invertido <strong>SQLite FTS5</strong></span>
          <span class="om-SearchDropdown__perf tnum" id="search-perf-text">Buscando…</span>
        </div>

        <div class="om-SearchDropdown__body" id="search-body-content">
          <div style="grid-column: 1 / -1; padding: 24px; text-align: center; color: var(--text-3)">
            Escribe para buscar pistas, artistas, álbumes o letras…
          </div>
        </div>

        <div class="om-SearchDropdown__foot">
          <span>Usa <kbd class="om-Kbd">↑</kbd> <kbd class="om-Kbd">↓</kbd> para navegar · <kbd class="om-Kbd">Enter</kbd> para reproducir</span>
          <span class="om-SearchDropdown__link" id="search-view-all" style="cursor:pointer">Cerrar búsqueda (Esc)</span>
        </div>
      </section>
    `;

    this.container.querySelector('#search-scrim')?.addEventListener('click', () => {
      this.close(true);
    });

    this.container.querySelector('#search-view-all')?.addEventListener('click', () => {
      this.close(true);
    });
  }

  async search(query) {
    if (!query || query.length < 1) {
      this.close(false);
      return;
    }

    this.open();
    const t0 = performance.now();
    try {
      const res = await ApiClient.getTracks({ search: query, limit: 12 });
      const t1 = performance.now();
      this.perfMs = (t1 - t0).toFixed(1);
      this.results = res.tracks || [];

      const perfEl = this.container.querySelector('#search-perf-text');
      if (perfEl) {
        perfEl.textContent = `${this.results.length} resultados en ${this.perfMs} ms`;
      }

      this.renderResults(query);
    } catch (err) {
      console.error('Error buscando:', err);
    }
  }

  renderResults(query) {
    const body = this.container.querySelector('#search-body-content');
    if (!body) return;

    if (this.results.length === 0) {
      body.innerHTML = `
        <div style="grid-column: 1 / -1; padding: 32px; text-align: center; color: var(--text-3)">
          No se encontraron resultados para «<strong>${query}</strong>».
        </div>
      `;
      return;
    }

    const topHit = this.results[0];
    const topCover = topHit.coverId
      ? `<img src="/api/covers/${encodeURIComponent(topHit.coverId)}" class="cover-svg" style="width:100%;height:100%;object-fit:cover" alt="Cover" />`
      : coverSvg({ title: topHit.title || '', artist: topHit.artist || '', palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'], style: 'waves' });

    body.innerHTML = `
      <!-- Mejor resultado destacado -->
      <div class="om-TopHit">
        <span class="om-TopHit__label">Mejor resultado</span>
        <div class="om-TopHit__art">${topCover}</div>
        <div>
          <div class="om-TopHit__title">${topHit.title || topHit.fileName}</div>
          <div class="om-TopHit__sub">${topHit.artist || 'Artista'} · ${topHit.album || 'Álbum'}</div>
        </div>
        <div class="om-TopHit__actions">
          <button class="om-BtnPrimary" id="top-play-btn" style="cursor:pointer">
            ${icon('play', { size: 14 })}<span>Reproducir</span>
          </button>
          <button class="om-BtnGhost" id="top-queue-btn" style="cursor:pointer">
            ${icon('addQueue', { size: 14 })}<span>A la cola</span>
          </button>
        </div>
      </div>

      <!-- Grupos de resultados -->
      <div class="om-SearchGroups">
        <div>
          <div class="om-SearchGroup__title">Pistas encontradas (${this.results.length})</div>
          ${this.results
            .slice(0, 5)
            .map((t) => {
              const chip = t.codec === 'DSD' ? 'DSD' : `${t.codec || 'PCM'} ${t.bitDepth || 16}/${((t.sampleRate || 44100) / 1000).toFixed(1)}k`;
              return `
                <div class="om-SearchRow" data-search-track-id="${t.id}" style="cursor:pointer">
                  <div class="om-SearchRow__left">
                    <span style="color:var(--accent)">${icon('note', { size: 15 })}</span>
                    <div>
                      <div class="om-TrackTitle">${t.title || t.fileName} — <span style="color:var(--text-2)">${t.artist}</span></div>
                    </div>
                  </div>
                  <span class="om-ArtboardMeta tnum">${chip}</span>
                </div>
              `;
            })
            .join('')}
        </div>
      </div>
    `;

    // Eventos de reproducción
    body.querySelector('#top-play-btn')?.addEventListener('click', () => {
      ApiClient.play(topHit).catch(console.error);
      this.close(true);
    });

    body.querySelector('#top-queue-btn')?.addEventListener('click', () => {
      ApiClient.enqueue({ track: topHit }).catch(console.error);
      this.close(true);
    });

    body.querySelectorAll('[data-search-track-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-search-track-id');
        const trk = this.results.find((t) => t.id === id);
        if (trk) {
          ApiClient.play(trk).catch(console.error);
          this.close(true);
        }
      });
    });
  }

  close(notify = false) {
    if (!this.isOpen && !this.container.innerHTML) return;
    this.isOpen = false;
    this.container.innerHTML = '';
    if (notify && this.onClose) this.onClose();
  }
}
