/*
 * OurMusic — Inspector de Metadatos y Editor de Etiquetas (Fase 4)
 * Edición limpia de tags (ID3v2, Vorbis Comments, MP4 ilst), análisis de sonoridad EBU R128
 * y guardado atómico sin alterar el audio PCM (0 LSB de pérdida).
 */
import { icon } from './icons.js';
import { coverSvg, formatBytes } from './visuals.js';
import { ApiClient } from './api.js';
import { toasts } from './toasts.js';

export class TagInspectorModal {
  constructor({ container = document.body, store, tracks = [], onSave, onClose }) {
    this.container = container;
    this.store = store;
    this.tracks = Array.isArray(tracks) ? tracks : [tracks].filter(Boolean);
    this.onSave = onSave;
    this.onClose = onClose;
    this.activeTab = 'tags'; // 'tags' | 'lyrics' | 'tech'
    this.fullTrackData = null;

    this.init();
  }

  async init() {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'om-ModalBackdrop';
    this.container.appendChild(this.backdrop);

    // Cargar metadatos completos de la primera pista si es edición individual
    if (this.tracks.length === 1 && this.tracks[0].id) {
      try {
        const res = await ApiClient.getTrackDetail(this.tracks[0].id).catch(() => null);
        if (res?.track) {
          this.fullTrackData = res.track;
        }
      } catch (err) {
        console.warn('[TagInspector] Error al cargar detalles:', err);
      }
    }

    this.render();
    this.bindEvents();
  }

  destroy() {
    if (this.backdrop && this.backdrop.parentNode) {
      this.backdrop.parentNode.removeChild(this.backdrop);
    }
  }

  render() {
    const isBatch = this.tracks.length > 1;
    const t = this.fullTrackData || this.tracks[0] || {};

    const titleVal = isBatch ? '<varios — conservar individualmente>' : t.title || t.fileName || '';
    const artistVal = isBatch ? (this.isAllSame('artist') ? t.artist : '<varios>') : t.artist || '';
    const albumVal = isBatch ? (this.isAllSame('album') ? t.album : '<varios>') : t.album || '';
    const composerVal = isBatch ? (this.isAllSame('composer') ? t.composer : '<varios>') : t.composer || '';
    const genreVal = isBatch ? (this.isAllSame('genre') ? t.genre : '<varios>') : t.genre || '';
    const yearVal = isBatch ? (this.isAllSame('year') ? t.year : '<varios>') : t.year || '';
    const trackNumVal = isBatch ? '<varios>' : t.trackNumber || '';
    const lyricsVal = t.lyrics || '';

    this.backdrop.innerHTML = `
      <section class="om-Modal" style="width:840px" aria-label="Inspector de Metadatos y Editor de Etiquetas">
        <header class="om-Modal__head">
          <div class="om-Modal__title">
            ${icon('composer', { size: 18 })}
            <span>Inspector de Metadatos y Propiedades</span>
            <span class="om-Pill is-active" style="font-size:11px;padding:2px 9px">
              ${isBatch ? `${this.tracks.length} pistas seleccionadas (Edición por lotes)` : 'Pista individual'}
            </span>
          </div>

          <div class="om-Segmented">
            <button class="om-Segmented__btn ${this.activeTab === 'tags' ? 'is-active' : ''}" id="modal-tab-tags">
              <span>Etiquetas</span>
            </button>
            <button class="om-Segmented__btn ${this.activeTab === 'lyrics' ? 'is-active' : ''}" id="modal-tab-lyrics">
              <span>Letras (.LRC)</span>
            </button>
          </div>
        </header>

        <div class="om-Modal__body">
          ${
            this.activeTab === 'tags'
              ? `
            <!-- Formulario de Metadatos -->
            <form id="tag-form" class="om-FormGrid">
              <div class="om-Field is-full">
                <label class="om-Field__label">
                  <span>Título de la pista</span>
                  ${isBatch ? '<span style="color:var(--accent)">Valores distintos en el lote</span>' : '<span>TITLE</span>'}
                </label>
                <input class="om-Field__input ${isBatch ? 'is-mixed' : ''}" id="field-title" name="title" value="${this.escapeAttr(titleVal)}" ${isBatch ? 'disabled placeholder="Conserva títulos individuales"' : ''} />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>Artista</span>
                  <span>ARTIST</span>
                </label>
                <input class="om-Field__input" id="field-artist" name="artist" value="${this.escapeAttr(artistVal)}" />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>Álbum</span>
                  <span>ALBUM</span>
                </label>
                <input class="om-Field__input" id="field-album" name="album" value="${this.escapeAttr(albumVal)}" />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>Compositor</span>
                  <span>COMPOSER</span>
                </label>
                <input class="om-Field__input" id="field-composer" name="composer" value="${this.escapeAttr(composerVal)}" />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>Género</span>
                  <span>GENRE</span>
                </label>
                <input class="om-Field__input" id="field-genre" name="genre" value="${this.escapeAttr(genreVal)}" />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>Año</span>
                  <span>DATE</span>
                </label>
                <input class="om-Field__input tnum" type="number" id="field-year" name="year" value="${this.escapeAttr(yearVal)}" />
              </div>

              <div class="om-Field">
                <label class="om-Field__label">
                  <span>N.º de Pista</span>
                  <span>TRACKNUMBER</span>
                </label>
                <input class="om-Field__input tnum ${isBatch ? 'is-mixed' : ''}" id="field-trackNumber" name="trackNumber" value="${this.escapeAttr(trackNumVal)}" ${isBatch ? 'disabled' : ''} />
              </div>

              <div class="om-Field is-full">
                <label class="om-Field__label">
                  <span>Ruta en disco local (solo lectura)</span>
                  <span>Inodo ext4 / NTFS</span>
                </label>
                <div class="om-Field__input tnum" style="color:var(--text-2);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                  ${t.filePath || 'Pista(s) en memoria o archivo local'}
                </div>
              </div>
            </form>
          `
              : `
            <!-- Editor de Letras Sincronizadas -->
            <div style="grid-column:1;display:flex;flex-direction:column;gap:8px">
              <label class="om-Field__label">
                <span>Letras Sincronizadas (formato .LRC [mm:ss.xx]) o texto simple</span>
                <span style="color:var(--accent)">100% Offline</span>
              </label>
              <textarea id="field-lyrics" style="flex:1;min-height:260px;padding:10px;background:var(--bg-1);border:1px solid var(--line-2);border-radius:var(--r-8);color:var(--text-1);font-family:monospace;font-size:12px;line-height:1.6;resize:none">${lyricsVal}</textarea>
            </div>
          `
          }

          <!-- Tarjeta Técnica Lateral -->
          <aside class="om-TechCard">
            <div style="display:flex;align-items:center;gap:12px;padding-bottom:8px;border-bottom:1px solid var(--line-1)">
              <div class="om-MiniThumb" style="width:58px;height:58px;border-radius:8px;overflow:hidden;flex-shrink:0">
                ${
                  t.coverId || t.coverArtId
                    ? `<img src="/api/covers/${encodeURIComponent(t.coverId || t.coverArtId)}" style="width:100%;height:100%;object-fit:cover" alt="" />`
                    : coverSvg(t, 58)
                }
              </div>
              <div style="min-width:0">
                <div style="font-size:12px;font-weight:700;color:var(--text-1)">PICTURE Incrustado</div>
                <div style="font-size:11px;color:var(--text-2)" class="tnum">${t.coverMime || 'JPEG/PNG'}</div>
                <div style="font-size:11px;color:var(--accent);font-weight:600;margin-top:3px">Protegido Clean-Room</div>
              </div>
            </div>

            <div class="om-TechRow">
              <span>Contenedor</span>
              <strong class="tnum">${t.codec || 'FLAC'}</strong>
            </div>
            <div class="om-TechRow">
              <span>Resolución PCM</span>
              <strong class="tnum">${t.bitDepth ? t.bitDepth + '-bit / ' : ''}${t.sampleRate ? (t.sampleRate / 1000).toFixed(1) + ' kHz' : 'Nativa'}</strong>
            </div>
            <div class="om-TechRow">
              <span>Canales</span>
              <strong class="tnum">${t.channels === 1 ? '1.0 Mono' : '2.0 Estéreo'}</strong>
            </div>
            <div class="om-TechRow">
              <span>Tamaño en disco</span>
              <strong class="tnum">${t.sizeBytes || t.fileSize ? formatBytes(t.sizeBytes || t.fileSize) : 'Variable'}</strong>
            </div>
            <div class="om-TechRow">
              <span>Sonoridad R128</span>
              <strong class="tnum" id="tech-lufs" style="color:${t.integratedLufs ? 'var(--ok)' : 'var(--text-3)'}">
                ${t.integratedLufs ? `${t.integratedLufs.toFixed(1)} LUFS` : 'No escaneado'}
              </strong>
            </div>

            <button class="om-BtnGhost" id="btn-scan-loudness" style="margin-top:6px;width:100%;font-size:11px;justify-content:center">
              ${icon('wave', { size: 14 })}
              <span>Escanear Sonoridad EBU R128</span>
            </button>
          </aside>
        </div>

        <footer class="om-Modal__foot">
          <span style="font-size:11px;color:var(--text-2)">
            Escritura directa en cabeceras sin recodificar el flujo de audio (0 LSB alterado)
          </span>
          <div style="display:flex;align-items:center;gap:8px">
            <button class="om-BtnGhost" id="modal-cancel-btn">Cancelar (Esc)</button>
            <button class="om-BtnPrimary" id="modal-save-btn">
              ${icon('check', { size: 14 })}
              <span>${isBatch ? `Guardar en ${this.tracks.length} archivos` : 'Guardar etiquetas'}</span>
            </button>
          </div>
        </footer>
      </section>
    `;
  }

  isAllSame(field) {
    if (this.tracks.length <= 1) return true;
    const first = this.tracks[0][field];
    return this.tracks.every((item) => item[field] === first);
  }

  escapeAttr(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  bindEvents() {
    // Backdrop click para cerrar
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) {
        this.close();
      }
    });

    // Pestañas
    const tabTags = this.backdrop.querySelector('#modal-tab-tags');
    const tabLyrics = this.backdrop.querySelector('#modal-tab-lyrics');

    if (tabTags) {
      tabTags.addEventListener('click', () => {
        this.activeTab = 'tags';
        this.render();
        this.bindEvents();
      });
    }

    if (tabLyrics) {
      tabLyrics.addEventListener('click', () => {
        this.activeTab = 'lyrics';
        this.render();
        this.bindEvents();
      });
    }

    // Cancelar
    const cancelBtn = this.backdrop.querySelector('#modal-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => this.close());

    // Escanear sonoridad
    const scanBtn = this.backdrop.querySelector('#btn-scan-loudness');
    if (scanBtn) {
      scanBtn.addEventListener('click', async () => {
        if (!this.tracks[0]?.id) return;
        scanBtn.disabled = true;
        scanBtn.innerHTML = `<span>Analizando con ITU-R BS.1770-4...</span>`;
        try {
          const res = await ApiClient.post(`/api/tracks/${this.tracks[0].id}/loudness`, {
            writeTags: true,
          });
          const lufsEl = this.backdrop.querySelector('#tech-lufs');
          if (lufsEl && res.integratedLufs) {
            lufsEl.textContent = `${res.integratedLufs.toFixed(1)} LUFS`;
            lufsEl.style.color = 'var(--ok)';
          }
          toasts.show({
            title: 'Sonoridad calculada',
            message: `${res.integratedLufs ? res.integratedLufs.toFixed(1) + ' LUFS' : 'Completado'} · True Peak 4x`,
            type: 'success',
          });
        } catch (err) {
          toasts.show({
            title: 'Error al escanear sonoridad',
            message: err.message,
            type: 'error',
          });
        } finally {
          scanBtn.disabled = false;
          scanBtn.innerHTML = `${icon('wave', { size: 14 })}<span>Escanear Sonoridad EBU R128</span>`;
        }
      });
    }

    // Guardar
    const saveBtn = this.backdrop.querySelector('#modal-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        await this.handleSave();
      });
    }
  }

  async handleSave() {
    const isBatch = this.tracks.length > 1;
    const patch = {};

    const getVal = (id) => {
      const el = this.backdrop.querySelector(`#field-${id}`);
      return el ? el.value.trim() : null;
    };

    if (this.activeTab === 'tags') {
      const title = getVal('title');
      const artist = getVal('artist');
      const album = getVal('album');
      const composer = getVal('composer');
      const genre = getVal('genre');
      const year = getVal('year');
      const trackNumber = getVal('trackNumber');

      if (!isBatch && title) patch.title = title;
      if (artist && artist !== '<varios>') patch.artist = artist;
      if (album && album !== '<varios>') patch.album = album;
      if (composer && composer !== '<varios>') patch.composer = composer;
      if (genre && genre !== '<varios>') patch.genre = genre;
      if (year && year !== '<varios>') patch.year = parseInt(year, 10);
      if (!isBatch && trackNumber) patch.trackNumber = parseInt(trackNumber, 10);
    } else {
      const lyricsEl = this.backdrop.querySelector('#field-lyrics');
      if (lyricsEl) patch.lyrics = lyricsEl.value;
    }

    try {
      for (const trk of this.tracks) {
        if (trk.id) {
          await ApiClient.put(`/api/tracks/${trk.id}/tags`, patch);
        }
      }

      toasts.show({
        title: 'Etiquetas guardadas en disco',
        message: `${this.tracks.length} archivo(s) actualizados con 0 LSB alterado`,
        type: 'success',
      });

      if (this.onSave) this.onSave(patch);
      this.close();
    } catch (err) {
      toasts.show({
        title: 'Error al guardar etiquetas',
        message: err.message,
        type: 'error',
      });
    }
  }

  close() {
    this.destroy();
    if (this.onClose) this.onClose();
  }
}
