/*
 * OurMusic — Menú Contextual de Clic Derecho (Fase 4)
 * Menú contextual rápido para pistas, álbumes y elementos de cola con soporte
 * de reproducción, encolado prioritario, inspección de etiquetas y análisis R128.
 */
import { icon } from './icons.js';
import { ApiClient } from './api.js';
import { toasts } from './toasts.js';
import { TagInspectorModal } from './tagInspectorModal.js';

export class ContextMenu {
  constructor({ store }) {
    this.store = store;
    this.menuEl = null;
    this.activeTrack = null;
    this.activeTracks = [];
    this.activeQueueIndex = null;

    this.bindGlobal();
  }

  bindGlobal() {
    // Cerrar al hacer clic fuera
    window.addEventListener('click', (e) => {
      if (this.menuEl && !this.menuEl.contains(e.target)) {
        this.close();
      }
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.menuEl) {
        this.close();
      }
    });
  }

  show({ x, y, track = null, tracks = [], queueIndex = null }) {
    this.close();

    this.activeTrack = track || (tracks.length > 0 ? tracks[0] : null);
    this.activeTracks = tracks.length > 0 ? tracks : track ? [track] : [];
    this.activeQueueIndex = queueIndex;

    if (!this.activeTrack && this.activeTracks.length === 0) return;

    this.menuEl = document.createElement('div');
    this.menuEl.className = 'om-ContextMenu';
    this.menuEl.setAttribute('aria-label', 'Menú contextual de pista');

    const isQueueItem = queueIndex !== null && queueIndex !== undefined;

    this.menuEl.innerHTML = `
      <div class="om-ContextItem is-active" id="ctx-play-now" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('play', { size: 14 })} Reproducir ahora</span>
        <kbd class="om-Kbd">Enter</kbd>
      </div>

      <div class="om-ContextItem" id="ctx-play-next" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('playNext', { size: 14 })} Reproducir a continuación</span>
        <kbd class="om-Kbd">Shift+Enter</kbd>
      </div>

      <div class="om-ContextItem" id="ctx-add-queue" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('addQueue', { size: 14 })} Añadir al final de la cola</span>
        <kbd class="om-Kbd">Q</kbd>
      </div>

      <div class="om-ContextSep"></div>

      <div class="om-ContextItem" id="ctx-scan-lufs" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('wave', { size: 14 })} Medir sonoridad ITU-R BS.1770-4</span>
        <span class="tnum" style="font-size:10px;color:var(--text-3)">R128</span>
      </div>

      <div class="om-ContextItem" id="ctx-edit-tags" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('composer', { size: 14 })} Editar etiquetas ID3 / Vorbis…</span>
        <kbd class="om-Kbd">Ctrl+I</kbd>
      </div>

      <div class="om-ContextItem" id="ctx-copy-path" style="cursor:pointer">
        <span style="display:flex;align-items:center;gap:8px">${icon('folder', { size: 14 })} Copiar ruta de archivo local</span>
        <kbd class="om-Kbd">Ctrl+C</kbd>
      </div>

      ${
        isQueueItem
          ? `
        <div class="om-ContextSep"></div>
        <div class="om-ContextItem is-danger" id="ctx-remove-queue" style="cursor:pointer">
          <span style="display:flex;align-items:center;gap:8px">${icon('trash', { size: 14 })} Quitar de la cola de reproducción</span>
          <kbd class="om-Kbd">Supr</kbd>
        </div>
      `
          : ''
      }
    `;

    document.body.appendChild(this.menuEl);

    // Posicionamiento ajustado a límites de pantalla
    const menuWidth = 276;
    const menuHeight = this.menuEl.offsetHeight || 240;
    const posX = Math.max(10, Math.min(x, window.innerWidth - menuWidth - 14));
    const posY = Math.max(10, Math.min(y, window.innerHeight - menuHeight - 14));

    this.menuEl.style.left = `${posX}px`;
    this.menuEl.style.top = `${posY}px`;

    this.bindActions();
  }

  bindActions() {
    const bindBtn = (id, handler) => {
      const el = this.menuEl.querySelector(id);
      if (el) {
        el.addEventListener('click', async (e) => {
          e.stopPropagation();
          this.close();
          await handler();
        });
      }
    };

    // Reproducir ahora
    bindBtn('#ctx-play-now', async () => {
      if (this.activeQueueIndex !== null) {
        await ApiClient.playQueueIndex(this.activeQueueIndex).catch(console.error);
      } else if (this.activeTrack?.id) {
        await ApiClient.play(this.activeTrack).catch(console.error);
      }
    });

    // Reproducir a continuación
    bindBtn('#ctx-play-next', async () => {
      if (this.activeTrack?.id) {
        await ApiClient.enqueue({ track: this.activeTrack, playNext: true });
        toasts.show({
          title: 'Reproducir a continuación',
          message: `«${this.activeTrack.title || 'Pista'}» añadida como siguiente`,
          type: 'accent',
        });
      }
    });

    // Añadir al final de la cola
    bindBtn('#ctx-add-queue', async () => {
      if (this.activeTrack?.id) {
        await ApiClient.enqueue({ track: this.activeTrack, playNext: false });
        toasts.show({
          title: 'Pista añadida a la cola',
          message: `«${this.activeTrack.title || 'Pista'}» añadida al final`,
          type: 'info',
        });
      }
    });

    // Medir sonoridad
    bindBtn('#ctx-scan-lufs', async () => {
      if (this.activeTrack?.id) {
        toasts.show({
          title: 'Escaneando sonoridad...',
          message: 'Calculando ITU-R BS.1770-4 con 4x True-Peak Oversampling',
          type: 'info',
        });
        try {
          const res = await ApiClient.post(`/api/tracks/${this.activeTrack.id}/loudness`, {
            writeTags: true,
          });
          toasts.show({
            title: 'Sonoridad completada',
            message: `${res.integratedLufs ? res.integratedLufs.toFixed(1) + ' LUFS' : 'Calculado'} · Guardado en metadatos`,
            type: 'success',
          });
        } catch (err) {
          toasts.show({
            title: 'Error al medir sonoridad',
            message: err.message,
            type: 'error',
          });
        }
      }
    });

    // Editar etiquetas
    bindBtn('#ctx-edit-tags', () => {
      new TagInspectorModal({
        store: this.store,
        tracks: this.activeTracks,
      });
    });

    // Copiar ruta
    bindBtn('#ctx-copy-path', async () => {
      const p = this.activeTrack?.filePath || '';
      if (p && navigator.clipboard) {
        await navigator.clipboard.writeText(p).catch(console.error);
        toasts.show({
          title: 'Ruta copiada al portapapeles',
          message: p,
          type: 'info',
        });
      }
    });

    // Quitar de cola
    bindBtn('#ctx-remove-queue', async () => {
      if (this.activeQueueIndex !== null) {
        await ApiClient.removeFromQueue(this.activeQueueIndex);
        toasts.show({
          title: 'Pista eliminada de la cola',
          type: 'info',
        });
      }
    });
  }

  close() {
    if (this.menuEl && this.menuEl.parentNode) {
      this.menuEl.parentNode.removeChild(this.menuEl);
    }
    this.menuEl = null;
  }
}
