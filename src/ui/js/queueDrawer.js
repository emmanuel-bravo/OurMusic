/*
 * OurMusic — Panel Desplegable de Cola de Reproducción (Fase 3)
 * Estructura en 2 bloques (Prioridad vs Contexto), reordenación drag-and-drop,
 * eliminación de pistas y reproducción instantánea.
 */
import { icon } from './icons.js';
import { coverSvg, formatTime } from './visuals.js';
import { ApiClient } from './api.js';

export class QueueDrawer {
  constructor({ container, store, onClose }) {
    this.container = container;
    this.store = store;
    this.onClose = onClose;
    this.draggedIndex = null;

    this.render();
    this.bindEvents();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (
        keys.includes('queueState') ||
        keys.includes('playback') ||
        keys.includes('activeDrawer')
      ) {
        this.update(state);
      }
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.container.innerHTML = '';
  }

  render() {
    const { queueState, playback } = this.store.state;
    const queue = queueState?.queue || [];
    const currentIndex = queueState?.currentIndex ?? -1;
    const currentTrack = playback.track || queueState?.currentTrack || (currentIndex >= 0 ? queue[currentIndex] : null);

    // Separamos la cola en:
    // 1. Pista actual
    // 2. A continuación (pistas después del índice actual o añadidas prioritariamente)
    const upcoming = [];
    queue.forEach((item, idx) => {
      if (idx !== currentIndex) {
        upcoming.push({ item, index: idx });
      }
    });

    this.container.innerHTML = `
      <aside class="om-Drawer" aria-label="Cola de reproducción" style="height:100%">
        <div class="om-Drawer__head">
          <div class="om-Drawer__title">
            ${icon('queue', { size: 18 })}
            <span>Cola de Reproducción</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${
              queue.length > 0
                ? `<button class="om-Pill" id="queue-clear-btn" style="padding:3px 9px;font-size:11px;cursor:pointer" title="Vaciar toda la cola de reproducción">Limpiar</button>`
                : ''
            }
            <button class="om-IconBtn" id="queue-close-btn" title="Cerrar panel (Ctrl+Q)">${icon('close', { size: 16 })}</button>
          </div>
        </div>

        <div class="om-Drawer__body" style="overflow-y:auto;padding-right:8px">
          <!-- 1. Pista que está sonando ahora -->
          <div class="om-QueueSection">
            <div class="om-QueueSection__head">
              <span>Reproduciendo ahora</span>
              <span class="tnum" style="color:var(--text-3);font-size:10px">${currentIndex >= 0 ? `Pista ${currentIndex + 1} de ${queue.length}` : 'En pausa'}</span>
            </div>
            ${
              currentTrack
                ? `
              <div class="om-QueueItem is-current" id="queue-current-item">
                <div class="om-MiniThumb" style="width:36px;height:36px;border-radius:4px;overflow:hidden;flex-shrink:0">
                  ${
                    currentTrack.coverId || currentTrack.coverArtId
                      ? `<img src="/api/covers/${encodeURIComponent(currentTrack.coverId || currentTrack.coverArtId)}" style="width:100%;height:100%;object-fit:cover" alt="" />`
                      : coverSvg(currentTrack, 36)
                  }
                </div>
                <div class="om-QueueItem__meta">
                  <div class="om-QueueItem__title">${currentTrack.title || currentTrack.fileName || 'Pista'}</div>
                  <div class="om-QueueItem__sub">
                    ${currentTrack.artist || 'Artista'} · <span style="color:var(--accent);font-weight:600">${currentTrack.codec || 'FLAC'}</span>
                  </div>
                </div>
                <span class="tnum" id="queue-elapsed-time" style="font-size:11px;color:var(--accent);font-weight:600">
                  ${formatTime(playback.positionSec)} / ${formatTime(playback.durationSec || currentTrack.durationSec || 0)}
                </span>
              </div>
            `
                : `
              <div style="padding:14px;background:var(--bg-2);border-radius:var(--r-8);color:var(--text-3);font-size:12px;text-align:center">
                Ninguna pista en reproducción
              </div>
            `
            }
          </div>

          <!-- 2. Bloque: A continuación (Prioridad y reordenación drag-and-drop) -->
          <div class="om-QueueSection" style="margin-top:10px">
            <div class="om-QueueSection__head">
              <span>A continuación (Prioridad)</span>
              <span class="om-QueueSection__badge">${upcoming.length} ${upcoming.length === 1 ? 'pista' : 'pistas'}</span>
            </div>

            <div id="queue-items-list" style="display:flex;flex-direction:column;gap:6px;min-height:50px">
              ${
                upcoming.length > 0
                  ? upcoming
                      .map(({ item, index }) => {
                        return `
                    <div class="om-QueueItem" draggable="true" data-index="${index}" style="cursor:grab">
                      <span class="om-QueueItem__grip" title="Arrastrar para reordenar">${icon('grip', { size: 15 })}</span>
                      <div class="om-MiniThumb" style="width:30px;height:30px;border-radius:3px;overflow:hidden;flex-shrink:0">
                        ${
                          item.coverId || item.coverArtId
                            ? `<img src="/api/covers/${encodeURIComponent(item.coverId || item.coverArtId)}" style="width:100%;height:100%;object-fit:cover" alt="" />`
                            : coverSvg(item, 30)
                        }
                      </div>
                      <div class="om-QueueItem__meta queue-item-click" data-index="${index}" style="cursor:pointer">
                        <div class="om-QueueItem__title">${item.title || item.fileName || 'Pista'}</div>
                        <div class="om-QueueItem__sub">${item.artist || 'Artista'} · ${item.codec || 'Audio'}</div>
                      </div>
                      <span class="tnum" style="font-size:11px;color:var(--text-3)">${formatTime(item.durationSec || 0)}</span>
                      <button class="om-IconBtn queue-remove-btn" data-index="${index}" style="width:24px;height:24px;color:var(--text-3)" title="Quitar de la cola">
                        ${icon('close', { size: 13 })}
                      </button>
                    </div>
                  `;
                      })
                      .join('')
                  : `
                <div style="padding:24px 14px;border:1px dashed var(--line-2);border-radius:var(--r-8);color:var(--text-3);font-size:12px;text-align:center">
                  La cola está vacía.<br/>
                  <span style="font-size:11px;color:var(--text-4)">Añade pistas desde cualquier álbum o tabla con clic derecho o el botón (+).</span>
                </div>
              `
              }
            </div>
          </div>

          <!-- 3. Información Hi-Fi del Buffer de Cola -->
          <div style="margin-top:auto;padding-top:14px;border-top:1px solid var(--line-1);font-size:11px;color:var(--text-3);display:flex;align-items:center;justify-content:space-between">
            <span>Continuidad Gapless: <strong>Activa</strong></span>
            <span class="om-SignalBadge" style="font-size:10px;padding:1px 6px">Buffer 64-Block</span>
          </div>
        </div>
      </aside>
    `;
  }

  bindEvents() {
    // Cerrar Drawer
    const closeBtn = this.container.querySelector('#queue-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (this.onClose) this.onClose();
        else this.store.setState({ activeDrawer: null });
      });
    }

    // Vaciar Cola
    const clearBtn = this.container.querySelector('#queue-clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        try {
          await ApiClient.clearQueue();
          this.store.setState({
            queueState: { queue: [], currentIndex: -1, currentTrack: null },
          });
        } catch (err) {
          console.error('[OurMusic Queue] Error al vaciar cola:', err);
        }
      });
    }

    // Clic en pista para reproducir
    const clickables = this.container.querySelectorAll('.queue-item-click');
    clickables.forEach((el) => {
      el.addEventListener('click', async () => {
        const idx = parseInt(el.getAttribute('data-index'), 10);
        if (!isNaN(idx)) {
          try {
            await ApiClient.playQueueIndex(idx);
          } catch (err) {
            console.error('[OurMusic Queue] Error al reproducir índice:', err);
          }
        }
      });
    });

    // Eliminar pista individual
    const removeBtns = this.container.querySelectorAll('.queue-remove-btn');
    removeBtns.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.getAttribute('data-index'), 10);
        if (!isNaN(idx)) {
          try {
            const res = await ApiClient.removeFromQueue(idx);
            if (res.queueState) {
              this.store.setState({ queueState: res.queueState });
            }
          } catch (err) {
            console.error('[OurMusic Queue] Error al eliminar pista:', err);
          }
        }
      });
    });

    // Reordenación Drag & Drop
    const items = this.container.querySelectorAll('.om-QueueItem[draggable="true"]');
    items.forEach((item) => {
      item.addEventListener('dragstart', (e) => {
        this.draggedIndex = parseInt(item.getAttribute('data-index'), 10);
        item.classList.add('is-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(this.draggedIndex));
      });

      item.addEventListener('dragend', () => {
        item.classList.remove('is-dragging');
        this.draggedIndex = null;
        items.forEach((it) => it.classList.remove('drag-over-top', 'drag-over-bottom'));
      });

      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const rect = item.getBoundingClientRect();
        const offset = e.clientY - rect.top;
        if (offset < rect.height / 2) {
          item.classList.add('drag-over-top');
          item.classList.remove('drag-over-bottom');
        } else {
          item.classList.add('drag-over-bottom');
          item.classList.remove('drag-over-top');
        }
      });

      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      item.addEventListener('drop', async (e) => {
        e.preventDefault();
        item.classList.remove('drag-over-top', 'drag-over-bottom');
        const targetIndex = parseInt(item.getAttribute('data-index'), 10);
        const sourceIndex = this.draggedIndex;

        if (!isNaN(sourceIndex) && !isNaN(targetIndex) && sourceIndex !== targetIndex) {
          try {
            const res = await ApiClient.reorderQueue(sourceIndex, targetIndex);
            if (res.queueState) {
              this.store.setState({ queueState: res.queueState });
            }
          } catch (err) {
            console.error('[OurMusic Queue] Error al reordenar cola:', err);
          }
        }
      });
    });
  }

  update(state) {
    // Si la pista actual o la cola cambiaron, redibujamos el panel
    this.render();
    this.bindEvents();
  }
}
