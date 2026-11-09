/*
 * OurMusic — Vista de Tabla de Todas las Pistas con Selector de Columnas
 */
import { icon } from './icons.js';
import { coverSvg } from './visuals.js';
import { ApiClient } from './api.js';

function formatDuration(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class TracksTableView {
  constructor({ container, store, onContextMenu }) {
    this.container = container;
    this.store = store;
    this.onContextMenu = onContextMenu;
    this.tracks = [];
    this.total = 0;
    this.showColPicker = false;

    this.columns = {
      title: { label: 'Título', enabled: true },
      artist: { label: 'Artista', enabled: true },
      album: { label: 'Álbum', enabled: true },
      year: { label: 'Año', enabled: true },
      format: { label: 'Formato', enabled: true },
      lufs: { label: 'Sonoridad (LUFS)', enabled: true },
      duration: { label: 'Duración', enabled: true },
    };

    this.render();
    this.loadTracks();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (keys.includes('playback')) {
        this.updatePlayingRow(state.playback);
      }
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
  }

  render() {
    this.container.innerHTML = `
      <div class="om-Content">
        <div class="om-SectionToolbar">
          <div class="om-SectionToolbar__title">
            <h1>Todas las pistas</h1>
            <span class="om-SectionToolbar__sub tnum" id="tracks-total-count">Cargando pistas…</span>
          </div>
          <div class="om-FilterPills">
            <span class="om-Pill is-active" data-filter="all">Todas</span>
            <span class="om-Pill" data-filter="hires">Hi-Res / DSD</span>
            <span class="om-Pill" data-filter="lossless">Lossless</span>
            <span class="om-Pill" id="btn-toggle-cols" style="cursor:pointer">
              ${icon('columns', { size: 14 })}<span>Columnas</span>
            </span>
          </div>
        </div>

        <div class="om-DataGridWrap" style="position:relative">
          <table class="om-DataGrid">
            <thead>
              <tr>
                <th style="width:42px">#</th>
                <th class="is-sorted">Título ↓</th>
                <th>Artista</th>
                <th>Álbum</th>
                <th style="width:92px">Año</th>
                <th style="width:130px">Formato</th>
                <th style="width:110px">LUFS</th>
                <th style="width:76px;text-align:right">${icon('clock', { size: 14 })}</th>
              </tr>
            </thead>
            <tbody id="tracks-table-body">
              <tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-3)">Cargando pistas desde SQLite…</td></tr>
            </tbody>
          </table>

          <!-- Popover Selector de Columnas -->
          <div id="col-picker-slot"></div>
        </div>
      </div>
    `;

    this.container.querySelector('#btn-toggle-cols')?.addEventListener('click', () => {
      this.showColPicker = !this.showColPicker;
      this.renderColPicker();
    });

    this.container.querySelectorAll('.om-FilterPills [data-filter]').forEach((pill) => {
      pill.addEventListener('click', () => {
        this.container.querySelectorAll('.om-FilterPills [data-filter]').forEach((p) => p.classList.remove('is-active'));
        pill.classList.add('is-active');
        const filter = pill.getAttribute('data-filter');
        if (filter === 'hires') {
          this.loadTracks({ hiResOnly: 'true' });
        } else if (filter === 'lossless') {
          this.loadTracks({ losslessOnly: 'true' });
        } else {
          this.loadTracks({});
        }
      });
    });
  }

  async loadTracks(filterParams = {}) {
    try {
      const res = await ApiClient.getTracks({
        limit: 250,
        offset: 0,
        sortBy: 'title',
        sortOrder: 'asc',
        ...filterParams,
      });

      this.tracks = res.tracks || [];
      this.total = res.total || 0;

      const subEl = this.container.querySelector('#tracks-total-count');
      if (subEl) {
        subEl.textContent = `${this.total.toLocaleString()} pistas en SQLite · Paginación O(1)`;
      }

      this.renderRows();
    } catch (err) {
      console.error('Error cargando pistas:', err);
    }
  }

  renderRows() {
    const tbody = this.container.querySelector('#tracks-table-body');
    if (!tbody) return;

    if (this.tracks.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:32px;color:var(--text-3)">No se encontraron pistas.</td></tr>`;
      return;
    }

    const curId = this.store.state.playback?.track?.id;

    tbody.innerHTML = this.tracks
      .map((t, idx) => {
        const isPlaying = curId && t.id === curId;
        const dur = formatDuration(t.durationSec);
        const lufs = t.integratedLufs ? `${t.integratedLufs.toFixed(1)} LUFS` : '--';
        const isHiRes = t.isHiRes || t.codec === 'DSD';
        const chipLabel = t.codec === 'DSD' ? 'DSD' : `${t.codec || 'PCM'} ${t.bitDepth || 16}/${((t.sampleRate || 44100) / 1000).toFixed(1)}k`;

        const thumbHtml = t.coverId
          ? `<img src="/api/covers/${encodeURIComponent(t.coverId)}" class="cover-svg" style="width:28px;height:28px;border-radius:4px;object-fit:cover" alt="Cover" />`
          : coverSvg({ title: t.title || '', artist: t.artist || '', palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'], style: 'waves' });

        return `
          <tr class="${isPlaying ? 'is-playing' : ''}" data-track-id="${t.id}" style="cursor:pointer">
            <td class="tnum">${isPlaying ? icon('bars', { size: 15 }) : (idx + 1)}</td>
            <td>
              <div class="om-TrackCell">
                <div class="om-MiniThumb" style="width:28px;height:28px">${thumbHtml}</div>
                <span class="om-TrackTitle">${t.title || t.fileName}</span>
                ${t.hasSyncedLyrics ? '<span class="om-TagMini">LRC</span>' : ''}
              </div>
            </td>
            <td>${t.artist || 'Desconocido'}</td>
            <td>${t.album || 'Desconocido'}</td>
            <td class="tnum">${t.year || ''}</td>
            <td><span class="om-FormatChip tnum ${isHiRes ? 'is-hires' : ''}">${chipLabel}</span></td>
            <td class="tnum">${lufs}</td>
            <td class="tnum" style="text-align:right">${dur}</td>
          </tr>
        `;
      })
      .join('');

    tbody.querySelectorAll('tr[data-track-id]').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-track-id');
        const trk = this.tracks.find((t) => t.id === id);
        if (trk) {
          ApiClient.play(trk).catch(console.error);
        }
      });

      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = row.getAttribute('data-track-id');
        const trk = this.tracks.find((t) => t.id === id);
        if (trk && this.onContextMenu) {
          this.onContextMenu({ x: e.clientX, y: e.clientY, track: trk });
        }
      });
    });
  }

  updatePlayingRow(playback) {
    const curId = playback?.track?.id;
    const tbody = this.container.querySelector('#tracks-table-body');
    if (!tbody) return;

    tbody.querySelectorAll('tr[data-track-id]').forEach((row) => {
      row.classList.toggle('is-playing', row.getAttribute('data-track-id') === curId);
    });
  }

  renderColPicker() {
    const slot = this.container.querySelector('#col-picker-slot');
    if (!slot) return;
    if (!this.showColPicker) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `
      <aside class="om-ColPicker" style="position:absolute;top:40px;right:16px;z-index:70">
        <div class="om-ColPicker__title">Columnas visibles</div>
        ${Object.keys(this.columns)
          .map((k) => {
            const col = this.columns[k];
            return `
              <div class="om-ColPicker__item ${col.enabled ? 'is-checked' : ''}" data-col-key="${k}" style="cursor:pointer">
                <span>${col.label}</span>
                <span class="om-CheckBox">${col.enabled ? icon('check', { size: 11 }) : ''}</span>
              </div>
            `;
          })
          .join('')}
      </aside>
    `;

    slot.querySelectorAll('[data-col-key]').forEach((item) => {
      item.addEventListener('click', () => {
        const key = item.getAttribute('data-col-key');
        this.columns[key].enabled = !this.columns[key].enabled;
        this.renderColPicker();
      });
    });
  }
}
