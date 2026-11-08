/*
 * OurMusic — Explorador de Carpetas Locales y Onboarding (Fase 4)
 * Navegación de directorios vigilados por inotify / ReadDirectoryChangesW,
 * migas de pan interactivas, vinculación de nuevas carpetas y reescaneo atómico.
 */
import { icon } from './icons.js';
import { formatTime, formatBytes } from './visuals.js';
import { ApiClient } from './api.js';
import { toasts } from './toasts.js';

export class FoldersView {
  constructor({ container, store, onTrackClick, onContextMenu }) {
    this.container = container;
    this.store = store;
    this.onTrackClick = onTrackClick;
    this.onContextMenu = onContextMenu;
    this.currentFolder = null;

    this.render();
    this.bindEvents();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (keys.includes('summary') || keys.includes('tracks')) {
        this.render();
        this.bindEvents();
      }
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.container.innerHTML = '';
  }

  render() {
    const { summary, tracks } = this.store.state;
    const folders = summary?.folders || [];

    // Si la biblioteca está totalmente vacía, mostramos el Onboarding inicial
    if (folders.length === 0 && tracks.length === 0) {
      this.renderEmptyOnboarding();
      return;
    }

    const activeDir = this.currentFolder || folders[0] || '/';
    // Pistas dentro de esta carpeta
    const folderTracks = tracks.filter((t) => t.filePath && t.filePath.startsWith(activeDir));
    const displayTracks = folderTracks.length > 0 ? folderTracks : tracks.slice(0, 50);

    // Subcarpetas agrupadas
    const subfolderSet = new Set();
    tracks.forEach((t) => {
      if (t.filePath) {
        const parts = t.filePath.split('/');
        if (parts.length > 2) {
          subfolderSet.add(parts.slice(0, -1).join('/'));
        }
      }
    });

    const subfoldersList = Array.from(subfolderSet).slice(0, 6);

    this.container.innerHTML = `
      <div class="om-Content" style="display:flex;flex-direction:column;height:100%;overflow:hidden">
        <!-- Barra de Herramientas de la Carpeta -->
        <div class="om-SectionToolbar">
          <div class="om-SectionToolbar__title">
            <h1 style="display:flex;align-items:center;gap:8px">
              ${icon('folder', { size: 22 })}
              <span>Explorador de Carpetas Locales</span>
            </h1>
            <span class="om-SectionToolbar__sub tnum" style="max-width:600px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              ${activeDir} · Vigilancia inotify / ReadDirectoryChangesW activa
            </span>
          </div>

          <div class="om-FilterPills">
            <button class="om-Pill is-active" id="btn-add-folder" style="cursor:pointer">
              ${icon('plus', { size: 13 })}
              <span>Vincular carpeta</span>
            </button>
            <button class="om-Pill" id="btn-rescan-folder" style="cursor:pointer">
              ${icon('disc', { size: 13 })}
              <span>Reescanear carpeta actual</span>
            </button>
          </div>
        </div>

        <!-- Tarjetas de Subdirectorios Detectados -->
        <div id="folder-input-panel" style="display:none;margin:0 24px 14px;padding:12px 16px;background:var(--bg-2);border:1px solid var(--accent);border-radius:var(--r-10);align-items:center;gap:10px">
          <span style="font-size:12px;font-weight:600;color:var(--text-1);white-space:nowrap">Ruta de carpeta local:</span>
          <input type="text" id="folder-path-input" class="om-Field__input" style="flex:1" placeholder="/home/emmanuel/Música" value="/home/emmanuel/Música" />
          <button class="om-BtnPrimary" id="folder-confirm-btn" style="cursor:pointer">Indexar</button>
          <button class="om-BtnGhost" id="folder-cancel-btn" style="cursor:pointer">Cancelar</button>
        </div>
        ${
          subfoldersList.length > 0
            ? `
          <div class="om-SubfolderRow" style="padding:0 24px 14px;display:flex;gap:12px;overflow-x:auto;flex-shrink:0">
            ${subfoldersList
              .map((sf) => {
                const name = sf.split('/').pop() || sf;
                const count = tracks.filter((t) => t.filePath && t.filePath.startsWith(sf)).length;
                return `
                <div class="om-SubfolderCard subfolder-chip" data-dir="${this.escapeAttr(sf)}" style="cursor:pointer;background:var(--bg-2);padding:8px 12px;border-radius:var(--r-8);border:1px solid var(--line-1);display:flex;align-items:center;gap:10px;min-width:180px">
                  <span style="color:var(--accent)">${icon('folder', { size: 20 })}</span>
                  <div style="min-width:0">
                    <div style="font-size:12px;font-weight:600;color:var(--text-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
                    <div style="font-size:11px;color:var(--text-2)" class="tnum">${count} pistas</div>
                  </div>
                </div>
              `;
              })
              .join('')}
          </div>
        `
            : ''
        }

        <!-- Tabla de Pistas en Disco -->
        <div class="om-DataGridWrap" style="flex:1;overflow-y:auto;padding:0 24px 24px">
          <table class="om-DataGrid">
            <thead>
              <tr>
                <th>Nombre de archivo en disco</th>
                <th>Título detectado</th>
                <th style="width:130px">Contenedor</th>
                <th style="width:110px">Tamaño</th>
                <th style="width:80px;text-align:right">${icon('clock', { size: 14 })}</th>
              </tr>
            </thead>
            <tbody>
              ${
                displayTracks.length > 0
                  ? displayTracks
                      .map((t) => {
                        const fname = t.filePath ? t.filePath.split('/').pop() : t.title || 'archivo';
                        const isHiRes = (t.bitDepth && t.bitDepth > 16) || (t.sampleRate && t.sampleRate > 48000);
                        return `
                    <tr class="folder-track-row" data-id="${t.id}" style="cursor:pointer">
                      <td class="tnum" style="color:var(--text-1);font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px">
                        ${fname}
                      </td>
                      <td>${t.title || 'Pista'} — <span style="color:var(--text-2)">${t.artist || 'Artista'}</span></td>
                      <td>
                        <span class="om-FormatChip tnum ${isHiRes ? 'is-hires' : ''}">
                          ${t.codec || 'FLAC'} ${isHiRes ? 'Hi-Res' : ''}
                        </span>
                      </td>
                      <td class="tnum" style="color:var(--text-2);font-size:12px">
                        ${t.sizeBytes || t.fileSize ? formatBytes(t.sizeBytes || t.fileSize) : '—'}
                      </td>
                      <td class="tnum" style="text-align:right">
                        ${formatTime(t.durationSec || 0)}
                      </td>
                    </tr>
                  `;
                      })
                      .join('')
                  : `
                <tr>
                  <td colspan="5" style="text-align:center;padding:36px;color:var(--text-3)">
                    No hay archivos de audio en esta carpeta
                  </td>
                </tr>
              `
              }
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  renderEmptyOnboarding() {
    this.container.innerHTML = `
      <div class="om-EmptyHero">
        <div class="om-EmptyArt">${icon('disc', { size: 46 })}</div>
        <div>
          <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.025em">Tu sala de escucha local está lista</h1>
          <p style="font-size:14px;color:var(--text-2);max-width:540px;margin:8px auto 0;line-height:1.5">
            Vincula una carpeta de tu disco duro o almacenamiento local. OurMusic indexará tus metadatos en <strong>SQLite FTS5</strong> con hilos paralelos y vigilará cambios en tiempo real sin subir nada a internet.
          </p>
        </div>

        <div style="display:flex;align-items:center;gap:10px;justify-content:center;margin-top:8px">
          <button class="om-BtnPrimary" id="onboard-add-folder" style="padding:9px 18px;font-size:13px;cursor:pointer">
            ${icon('folder', { size: 16 })}
            <span>+ Añadir primera carpeta de música local</span>
          </button>
        </div>

        <div id="folder-input-panel" style="display:none;margin:10px auto 0;padding:12px 16px;width:540px;max-width:95%;background:var(--bg-2);border:1px solid var(--accent);border-radius:var(--r-10);align-items:center;gap:10px">
          <input type="text" id="folder-path-input" class="om-Field__input" style="flex:1" placeholder="/home/emmanuel/Música" value="/home/emmanuel/Música" />
          <button class="om-BtnPrimary" id="folder-confirm-btn" style="cursor:pointer">Indexar</button>
          <button class="om-BtnGhost" id="folder-cancel-btn" style="cursor:pointer">Cancelar</button>
        </div>

        <div class="om-OnboardCards">
          <div class="om-OnboardCard">
            <div style="font-size:12px;font-weight:700;color:var(--accent)">1. Escaneo O(metadata)</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:4px">Lee cabeceras FLAC, ALAC, WAV, MP3 y DSD64–DSD1024 en milisegundos sin saturar la memoria RAM.</div>
          </div>
          <div class="om-OnboardCard">
            <div style="font-size:12px;font-weight:700;color:var(--ok)">2. Salida Bit-Perfect Nativa</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:4px">Comunicación directa con ALSA Hardware (Linux) y WASAPI Exclusivo / ASIO (Windows).</div>
          </div>
          <div class="om-OnboardCard">
            <div style="font-size:12px;font-weight:700;color:var(--text-1)">3. Vigilancia Automática</div>
            <div style="font-size:11px;color:var(--text-2);margin-top:4px">Cualquier álbum nuevo que copies a tu carpeta se indexará automáticamente sin reescaneos manuales.</div>
          </div>
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
    // Añadir carpeta con panel inline (compatible con WebKit2GTK y navegadores)
    const addBtn = this.container.querySelector('#btn-add-folder') || this.container.querySelector('#onboard-add-folder');
    const panel = this.container.querySelector('#folder-input-panel');
    const pathInput = this.container.querySelector('#folder-path-input');
    const confirmBtn = this.container.querySelector('#folder-confirm-btn');
    const cancelBtn = this.container.querySelector('#folder-cancel-btn');

    const submitFolder = async () => {
      const folderPath = pathInput ? pathInput.value.trim() : '';
      if (!folderPath) return;
      if (panel) panel.style.display = 'none';
      toasts.show({
        title: 'Indexando carpeta local...',
        message: folderPath,
        type: 'info',
      });
      try {
        const res = await ApiClient.addFolder(folderPath);
        toasts.show({
          title: 'Carpeta indexada con éxito',
          message: `${res.report?.indexedCount ?? 0} pistas indexadas en SQLite FTS5`,
          type: 'success',
        });
        const [summaryRes, tracksRes] = await Promise.all([
          ApiClient.getSummary().catch(() => null),
          ApiClient.getTracks({ limit: 250, offset: 0 }).catch(() => null),
        ]);
        this.store.setState({
          summary: summaryRes?.summary || summaryRes || res.summary || {},
          tracks: tracksRes?.tracks || res.tracks || [],
        });
      } catch (err) {
        toasts.show({
          title: 'Error al vincular carpeta',
          message: err.message,
          type: 'error',
        });
      }
    };

    if (addBtn && panel) {
      addBtn.addEventListener('click', () => {
        panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
        if (panel.style.display === 'flex' && pathInput) {
          pathInput.focus();
          pathInput.select();
        }
      });
    }
    if (confirmBtn) confirmBtn.addEventListener('click', submitFolder);
    if (cancelBtn && panel) {
      cancelBtn.addEventListener('click', () => {
        panel.style.display = 'none';
      });
    }
    if (pathInput) {
      pathInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          submitFolder();
        } else if (e.key === 'Escape' && panel) {
          panel.style.display = 'none';
        }
      });
    }

    // Reescanear
    const rescanBtn = this.container.querySelector('#btn-rescan-folder');
    if (rescanBtn) {
      rescanBtn.addEventListener('click', async () => {
        const { summary } = this.store.state;
        const dir = this.currentFolder || summary?.folders?.[0];
        if (!dir) return;

        toasts.show({
          title: 'Reescaneando directorio...',
          message: dir,
          type: 'info',
        });
        try {
          await ApiClient.post('/api/library/scan', { directory: dir });
          toasts.show({
            title: 'Reescaneo completado',
            type: 'success',
          });
        } catch (err) {
          toasts.show({
            title: 'Error al reescanear',
            message: err.message,
            type: 'error',
          });
        }
      });
    }

    // Clic en subcarpeta
    const subfolderChips = this.container.querySelectorAll('.subfolder-chip');
    subfolderChips.forEach((chip) => {
      chip.addEventListener('click', () => {
        const dir = chip.getAttribute('data-dir');
        this.currentFolder = dir;
        this.render();
        this.bindEvents();
      });
    });

    // Clic en pista para reproducir
    const rows = this.container.querySelectorAll('.folder-track-row');
    rows.forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-id');
        const trk = this.store.state.tracks.find((t) => t.id === id);
        if (trk) {
          if (this.onTrackClick) this.onTrackClick(trk);
          else ApiClient.play(trk).catch(console.error);
        }
      });

      // Clic derecho para menú contextual
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const id = row.getAttribute('data-id');
        const trk = this.store.state.tracks.find((t) => t.id === id);
        if (trk && this.onContextMenu) {
          this.onContextMenu({ x: e.clientX, y: e.clientY, track: trk });
        }
      });
    });
  }
}
