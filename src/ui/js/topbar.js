/*
 * OurMusic — Componente de la Barra Superior (Topbar) con Búsqueda FTS5
 */
import { icon } from './icons.js';
import { ApiClient } from './api.js';

export class Topbar {
  constructor({ container, store }) {
    this.container = container;
    this.store = store;

    this.render();
    this.bindEvents();

    this.store.subscribe((state, keys) => {
      if (keys.includes('breadcrumbs') || keys.includes('currentView') || keys.includes('searchQuery')) {
        this.update(state);
      }
    });
  }

  render() {
    this.container.innerHTML = `
      <header class="om-Topbar">
        <div class="om-Breadcrumbs" id="breadcrumbs-container">
          <div class="om-HistoryBtns">
            <button class="om-IconBtn" id="hist-back" title="Atrás (Alt+←)">${icon('chevronLeft', { size: 17 })}</button>
            <button class="om-IconBtn" id="hist-forward" title="Adelante (Alt+→)">${icon('chevronRight', { size: 17 })}</button>
          </div>
          <span class="om-Crumb" id="crumb-root">Biblioteca</span>
          <span class="om-CrumbSep">/</span>
          <span class="om-Crumb is-current" id="crumb-current">Álbumes</span>
        </div>

        <div class="om-SearchBox" id="global-search-box">
          ${icon('search', { size: 16 })}
          <input type="text" id="global-search-input" class="om-SearchBox__input" style="background:transparent;border:none;outline:none" placeholder="Buscar pistas, álbumes, artistas o letras…" />
          <kbd class="om-Kbd">Ctrl+F</kbd>
        </div>

        <div class="om-Topbar__right">
          <div class="om-Segmented" id="view-mode-toggle">
            <div class="om-Segmented__btn is-active" data-mode="grid">${icon('grid', { size: 15 })}<span>Cuadrícula</span></div>
            <div class="om-Segmented__btn" data-mode="list">${icon('listView', { size: 15 })}<span>Tabla</span></div>
          </div>
          <div class="om-Pill" id="sort-pill" style="cursor:pointer">${icon('sort', { size: 14 })}<span id="sort-label">Año ↓</span></div>
        </div>
      </header>
    `;
  }

  bindEvents() {
    const input = this.container.querySelector('#global-search-input');
    let timer = null;

    input.addEventListener('input', (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const query = e.target.value.trim();
        this.store.setState({ searchQuery: query });
      }, 150);
    });

    // Atajo Ctrl+F para enfocar buscador
    window.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.focus();
        input.select();
      }
    });
  }

  update(state) {
    const crumbCurrent = this.container.querySelector('#crumb-current');
    if (crumbCurrent) {
      const titles = {
        albums: 'Álbumes',
        tracks: 'Pistas',
        artists: 'Artistas',
        genres: 'Géneros',
        composers: 'Compositores',
        folders: 'Carpetas locales',
      };
      crumbCurrent.textContent = titles[state.currentView] || 'Colección';
    }
  }
}
