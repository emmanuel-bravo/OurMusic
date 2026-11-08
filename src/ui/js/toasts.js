/*
 * OurMusic — Notificaciones Efímeras (Toasts) (Fase 4)
 * Pila flotante de avisos no intrusivos con animación de entrada, auto-cierre y acción de deshacer.
 */
import { icon } from './icons.js';

export class ToastManager {
  constructor(container = document.body) {
    this.container = container;
    this.stack = null;
    this.init();
  }

  init() {
    let stack = document.getElementById('toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.id = 'toast-stack';
      stack.className = 'om-ToastStack';
      this.container.appendChild(stack);
    }
    this.stack = stack;
  }

  show({ title, message, type = 'info', actionLabel = null, onAction = null, duration = 3500 }) {
    if (!this.stack) this.init();

    const toast = document.createElement('div');
    toast.className = 'om-Toast';
    if (type === 'accent') {
      toast.style.borderColor = 'rgba(var(--accent-rgb), 0.45)';
    } else if (type === 'success') {
      toast.style.borderColor = 'rgba(46, 204, 113, 0.45)';
    } else if (type === 'error') {
      toast.style.borderColor = 'rgba(231, 76, 60, 0.45)';
    }

    const dotColor =
      type === 'success'
        ? 'var(--ok)'
        : type === 'error'
          ? 'var(--danger)'
          : type === 'accent'
            ? 'var(--accent)'
            : 'var(--text-3)';

    toast.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:0">
        <span class="om-Dot" style="background:${dotColor};box-shadow:0 0 8px ${dotColor}"></span>
        <div style="min-width:0">
          <div style="font-size:12px;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${title}</div>
          ${message ? `<div style="font-size:11px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${message}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
        ${
          actionLabel && onAction
            ? `<span class="toast-action-btn" style="font-size:11px;font-weight:700;color:var(--accent);cursor:pointer">${actionLabel}</span>`
            : ''
        }
        <button class="om-IconBtn toast-close-btn" style="width:24px;height:24px;color:var(--text-3)">
          ${icon('close', { size: 13 })}
        </button>
      </div>
    `;

    // Botón de acción (ej. Deshacer)
    if (actionLabel && onAction) {
      toast.querySelector('.toast-action-btn').addEventListener('click', () => {
        try {
          onAction();
        } catch (err) {
          console.error('[Toast Action]', err);
        }
        this.dismiss(toast);
      });
    }

    // Botón cerrar
    toast.querySelector('.toast-close-btn').addEventListener('click', () => {
      this.dismiss(toast);
    });

    this.stack.appendChild(toast);

    // Animación de entrada suave
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    toast.style.transition = 'opacity 0.22s ease, transform 0.22s ease';

    requestAnimationFrame(() => {
      toast.style.opacity = '1';
      toast.style.transform = 'translateY(0)';
    });

    // Auto-cierre
    if (duration > 0) {
      setTimeout(() => {
        this.dismiss(toast);
      }, duration);
    }

    return toast;
  }

  dismiss(toast) {
    if (!toast || !toast.parentNode) return;
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 240);
  }
}

export const toasts = new ToastManager();
