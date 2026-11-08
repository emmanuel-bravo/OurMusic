/*
 * OurMusic — Hoja Modal de Atajos de Teclado e Integración Multimedia (Fase 4)
 * Muestra el mapa de controles de teclado y anuncia integración MPRIS/SMTC.
 */
import { icon } from './icons.js';

export class ShortcutsModal {
  constructor({ container = document.body, onClose }) {
    this.container = container;
    this.onClose = onClose;
    this.init();
  }

  init() {
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'om-ModalBackdrop';
    this.container.appendChild(this.backdrop);
    this.render();
    this.bindEvents();
  }

  destroy() {
    if (this.backdrop && this.backdrop.parentNode) {
      this.backdrop.parentNode.removeChild(this.backdrop);
    }
  }

  render() {
    const col1 = [
      ['Pausar / Reanudar reproducción', 'Espacio'],
      ['Pista siguiente / anterior', 'Ctrl + → / ←'],
      ['Adelantar / Retroceder 10 s', '→ / ←'],
      ['Subir / Bajar volumen', '↑ / ↓'],
      ['Silenciar salida (Mute)', 'M'],
      ['Alternar modo Aleatorio', 'S'],
      ['Alternar modo Repetir', 'R'],
      ['Teclas Multimedia del Teclado', 'MPRIS2 / SMTC'],
    ];

    const col2 = [
      ['Enfocar Búsqueda Global Instantánea', 'Ctrl + F'],
      ['Abrir / Cerrar Cola de Reproducción', 'Ctrl + Q'],
      ['Abrir / Cerrar Consola DSP y EQ', 'Ctrl + E'],
      ['Modo Sala de Escucha / Letras .LRC', 'F11 / Ctrl + L'],
      ['Inspector de Metadatos / Etiquetas', 'Ctrl + I'],
      ['Vista de Álbumes / Pistas', '1 / 2'],
      ['Mostrar esta hoja de atajos', '?'],
      ['Cerrar modal o panel activo', 'Escape'],
    ];

    this.backdrop.innerHTML = `
      <section class="om-Modal" style="width:760px" aria-label="Atajos de Teclado y Control Multimedia">
        <header class="om-Modal__head">
          <div class="om-Modal__title">
            ${icon('bolt', { size: 18 })}
            <span>Atajos de Teclado e Integración del Sistema</span>
          </div>
          <span class="om-SignalBadge">MPRIS D-Bus (Linux) · SMTC (Windows) Activos</span>
        </header>

        <div class="om-ShortcutsCols" style="padding:18px 22px;display:grid;grid-template-columns:1fr 1fr;gap:24px">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:10px">
              Transporte y Audio
            </div>
            ${col1
              .map(
                ([label, kbd]) => `
              <div class="om-ShortcutRow" style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid var(--line-1)">
                <span style="color:var(--text-1)">${label}</span>
                <kbd class="om-Kbd tnum">${kbd}</kbd>
              </div>
            `,
              )
              .join('')}
          </div>

          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-3);margin-bottom:10px">
              Navegación, Vistas y Herramientas
            </div>
            ${col2
              .map(
                ([label, kbd]) => `
              <div class="om-ShortcutRow" style="display:flex;align-items:center;justify-content:space-between;padding:5px 0;font-size:12px;border-bottom:1px solid var(--line-1)">
                <span style="color:var(--text-1)">${label}</span>
                <kbd class="om-Kbd tnum">${kbd}</kbd>
              </div>
            `,
              )
              .join('')}
          </div>
        </div>

        <footer class="om-Modal__foot">
          <span style="font-size:11px;color:var(--text-2)">
            Las teclas físicas de tu teclado funcionan incluso con la aplicación en segundo plano.
          </span>
          <button class="om-BtnPrimary" id="shortcuts-close-btn">Entendido (Esc)</button>
        </footer>
      </section>
    `;
  }

  bindEvents() {
    this.backdrop.addEventListener('click', (e) => {
      if (e.target === this.backdrop) this.close();
    });

    const btn = this.backdrop.querySelector('#shortcuts-close-btn');
    if (btn) btn.addEventListener('click', () => this.close());
  }

  close() {
    this.destroy();
    if (this.onClose) this.onClose();
  }
}
