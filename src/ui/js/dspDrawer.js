/*
 * OurMusic — Consola DSP y Ecualizador de 64 bits (Fase 3)
 * Pestaña 1: EQ Gráfico de 10 bandas Biquad RBJ con curva SVG en vivo,
 * faders interactivos, suavizado τ=15ms y limitador Padé.
 * Pestaña 2: Modo Avanzado con PEQ 16 bandas, Crossfeed Bauer/Meier, Convolver FIR,
 * ReplayGain 2.0 (-18 LUFS) y Resampler Kaiser-Sinc.
 */
import { icon } from './icons.js';
import { ApiClient } from './api.js';

const FREQ_LABELS = ['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k'];

export class DspDrawer {
  constructor({ container, store, onClose }) {
    this.container = container;
    this.store = store;
    this.onClose = onClose;
    this.activeTab = 'eq'; // 'eq' | 'adv'

    this.eqState = {
      enabled: true,
      numBands: 10,
      preampDb: -1.5,
      gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      activePresetId: 'flat',
      smoothingEnabled: true,
      limiterEnabled: true,
      crossfeed: { enabled: true, cutHz: 650, feedDb: 4.5, delayUs: 320 },
      convolver: { enabled: false, irPath: 'Sennheiser_HD650_LinearPhase.wav', mix: 1.0 },
      replayGain: { enabled: true, mode: 'album', targetLufs: -18, truePeak: true },
      peqBands: [
        { idx: 1, type: 'Low-Shelf', freq: '80 Hz', gain: '+2.0 dB', q: '0.71' },
        { idx: 2, type: 'Peaking Notch', freq: '2.4 kHz', gain: '-3.5 dB', q: '3.2' },
        { idx: 3, type: 'High-Shelf', freq: '10 kHz', gain: '+1.5 dB', q: '0.71' },
      ],
    };

    this.presets = [
      { id: 'flat', name: 'Plano' },
      { id: 'rock', name: 'Rock' },
      { id: 'jazz', name: 'Jazz' },
      { id: 'classical', name: 'Clásica' },
      { id: 'vocal_acoustic', name: 'Vocal / Acústica' },
      { id: 'deep_bass', name: 'Graves Profundos' },
    ];

    this.render();
    this.fetchData();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (keys.includes('eqState') && state.eqState) {
        this.mergeEqState(state.eqState);
        if (!this.isDraggingFader) {
          this.render();
        }
      }
    });
  }

  mergeEqState(incoming) {
    if (!incoming) return;
    let gains = Array.isArray(incoming.gains) ? [...incoming.gains] : [...(this.eqState.gains || [])];
    if (gains.length === 5) {
      gains = [
        gains[0],
        (gains[0] + gains[1]) / 2,
        gains[1],
        (gains[1] + gains[2]) / 2,
        gains[2],
        gains[2],
        (gains[2] + gains[3]) / 2,
        gains[3],
        (gains[3] + gains[4]) / 2,
        gains[4],
      ];
    }
    while (gains.length < 10) gains.push(0);
    this.eqState = {
      ...this.eqState,
      ...incoming,
      numBands: 10,
      gains: gains.slice(0, 10),
      peqBands:
        Array.isArray(incoming.peqBands) && incoming.peqBands.length > 0
          ? incoming.peqBands
          : this.eqState.peqBands,
    };
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.container.innerHTML = '';
  }

  async fetchData() {
    try {
      const [eqData, dspData] = await Promise.all([
        ApiClient.getEq().catch(() => null),
        ApiClient.getDsp().catch(() => null),
      ]);

      if (eqData?.eqState) {
        this.mergeEqState(eqData.eqState);
        if (Array.isArray(eqData.presets)) {
          this.presets = eqData.presets;
        }
      }
      if (dspData?.eqState) {
        this.mergeEqState(dspData.eqState);
      }
      if (!this.isDraggingFader) {
        this.render();
      }
    } catch (err) {
      console.error('[OurMusic DSP] Error cargando estado DSP:', err);
    }
  }

  calculateCurvePath() {
    const gains = this.eqState.gains || [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    const preamp = this.eqState.preampDb || 0;

    const points = gains.map((g, i) => {
      const x = 12 + i * (316 / (gains.length - 1));
      // Ganancia total con preamp
      const totalGain = Math.max(-14, Math.min(14, g + preamp));
      // Centro en y = 43 (0 dB). Cada dB equivale a ~2.4px
      const y = Math.max(6, Math.min(80, 43 - totalGain * 2.4));
      return { x, y };
    });

    // Curva cúbica suave
    let d = `M 0 ${points[0].y}`;
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      if (i === 0) {
        d += ` L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      } else {
        const prev = points[i - 1];
        const cx1 = (prev.x + (p.x - prev.x) / 2).toFixed(1);
        const cy1 = prev.y.toFixed(1);
        const cx2 = cx1;
        const cy2 = p.y.toFixed(1);
        d += ` C ${cx1} ${cy1}, ${cx2} ${cy2}, ${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      }
    }
    const last = points[points.length - 1];
    d += ` L 340 ${last.y.toFixed(1)}`;

    const strokePath = d;
    const fillPath = `${d} L 340 86 L 0 86 Z`;
    return { strokePath, fillPath };
  }

  renderFader({ label, gain, index, isPreamp = false }) {
    const clamped = Math.max(-12, Math.min(12, gain));
    // 50% es 0 dB
    const pctFromTop = 50 - (clamped / 12) * 42;
    const fillTop = Math.min(50, pctFromTop);
    const fillHeight = Math.abs(50 - pctFromTop);
    const sign = gain > 0 ? `+${gain.toFixed(1)}` : gain.toFixed(1);

    return `
      <div class="om-FaderCol ${isPreamp ? 'is-preamp' : ''}">
        <span class="om-FaderGain tnum" id="gain-label-${isPreamp ? 'pre' : index}">${sign}</span>
        <div class="om-FaderTrack fader-track" data-index="${isPreamp ? 'pre' : index}" style="cursor:ns-resize">
          <div class="om-FaderZero"></div>
          <div class="om-FaderFill" id="fader-fill-${isPreamp ? 'pre' : index}" style="top:${fillTop}%;height:${fillHeight}%"></div>
          <div class="om-FaderKnob" id="fader-knob-${isPreamp ? 'pre' : index}" style="top:${pctFromTop}%"></div>
        </div>
        <span class="om-FaderFreq tnum">${label}</span>
      </div>
    `;
  }

  render() {
    const { strokePath, fillPath } = this.calculateCurvePath();
    const activePresetName =
      this.presets.find((p) => p.id === this.eqState.activePresetId)?.name || 'Personalizado';

    this.container.innerHTML = `
      <aside class="om-Drawer" aria-label="Consola DSP de 64 bits" style="height:100%">
        <div class="om-Drawer__head">
          <div class="om-Drawer__title">
            ${icon('dsp', { size: 18 })}
            <span>Consola DSP 64-bit</span>
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            <div class="om-Segmented">
              <button class="om-Segmented__btn ${this.activeTab === 'eq' ? 'is-active' : ''}" id="tab-eq-btn">
                <span>EQ 10 Bandas</span>
              </button>
              <button class="om-Segmented__btn ${this.activeTab === 'adv' ? 'is-active' : ''}" id="tab-adv-btn">
                <span>Avanzado</span>
              </button>
            </div>
            <button class="om-IconBtn" id="dsp-close-btn" title="Cerrar panel (Ctrl+E)">${icon('close', { size: 16 })}</button>
          </div>
        </div>

        ${
          this.activeTab === 'eq'
            ? `
          <div class="om-Drawer__body" style="overflow-y:auto;padding-right:8px">
            <!-- Barra de Presets y Bypass -->
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
              <div style="display:flex;align-items:center;gap:6px">
                <span style="font-size:12px;color:var(--text-3);font-weight:600">Perfil:</span>
                <select id="eq-preset-select" class="om-Pill is-active" style="cursor:pointer;border:none;background:var(--accent-soft);color:var(--accent);font-weight:600;padding:4px 8px">
                  ${this.presets
                    .map(
                      (p) =>
                        `<option value="${p.id}" ${p.id === this.eqState.activePresetId ? 'selected' : ''}>${p.name}</option>`,
                    )
                    .join('')}
                </select>
              </div>

              <div style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-2);cursor:pointer" id="eq-bypass-wrap">
                <span>Bypass</span>
                <span class="om-Toggle ${this.eqState.enabled ? '' : 'is-on'}" id="eq-bypass-toggle" title="Activar/Desactivar ecualizador"></span>
              </div>
            </div>

            <!-- Caja de Respuesta en Frecuencia Biquad SVG -->
            <div class="om-EqCurveBox">
              <div class="om-EqCurveBox__head">
                <span>Respuesta Biquad RBJ (64-bit float)</span>
                <span class="tnum" style="color:var(--accent)" id="eq-curve-preamp-text">
                  Pre-amp: ${this.eqState.preampDb > 0 ? '+' : ''}${this.eqState.preampDb.toFixed(1)} dB
                </span>
              </div>
              <svg class="om-EqCurveSvg" viewBox="0 0 340 86" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="eqFillGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="rgba(var(--accent-rgb), 0.38)" />
                    <stop offset="100%" stop-color="rgba(var(--accent-rgb), 0.0)" />
                  </linearGradient>
                </defs>
                <line x1="0" y1="43" x2="340" y2="43" stroke="rgba(255,238,214,0.14)" stroke-dasharray="3 3" />
                <path id="eq-curve-fill" d="${fillPath}" fill="url(#eqFillGrad)" />
                <path id="eq-curve-stroke" d="${strokePath}" fill="none" stroke="var(--accent)" stroke-width="2.2" />
              </svg>
            </div>

            <!-- Parrilla de Faders Verticales (11 faders: Preamp + 10 bandas) -->
            <div class="om-FadersGrid">
              ${this.renderFader({ label: 'Pre', gain: this.eqState.preampDb, isPreamp: true })}
              ${this.eqState.gains
                .map((gain, i) =>
                  this.renderFader({
                    label: FREQ_LABELS[i] || `${i + 1}`,
                    gain,
                    index: i,
                    isPreamp: false,
                  }),
                )
                .join('')}
            </div>

            <!-- Toggles de Suavizado y Limitador Padé -->
            <div class="om-DspSwitchRow" style="cursor:pointer" id="eq-smoothing-row">
              <div>
                <div style="font-weight:600;color:var(--text-1)">Suavizado de Parámetros (Smoothing)</div>
                <div style="font-size:11px;color:var(--text-2)">Rampa exponencial τ = 15 ms libre de clics</div>
              </div>
              <span class="om-Toggle ${this.eqState.smoothingEnabled ? 'is-on' : ''}"></span>
            </div>

            <div class="om-DspSwitchRow" style="cursor:pointer" id="eq-limiter-row">
              <div>
                <div style="font-weight:600;color:var(--text-1)">Limitador Suave Padé Anti-Clipping</div>
                <div style="font-size:11px;color:var(--text-2)">Protege picos &gt; -0.1 dBFS tras ecualización</div>
              </div>
              <span class="om-Toggle ${this.eqState.limiterEnabled ? 'is-on' : ''}"></span>
            </div>
          </div>
        `
            : `
          <div class="om-Drawer__body" style="overflow-y:auto;padding-right:8px">
            <!-- 1. PEQ Paramétrico de 16 Bandas -->
            <div class="om-DspModuleCard">
              <div class="om-DspModuleCard__head">
                <span>PEQ Paramétrico de 16 Bandas</span>
                <span class="om-Toggle ${this.eqState.peqMode ? 'is-on' : 'is-on'}" id="adv-peq-toggle" style="cursor:pointer"></span>
              </div>
              <div style="display:flex;flex-direction:column;gap:4px;margin-top:2px">
                ${this.eqState.peqBands
                  .map(
                    (n) => `
                  <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;padding:4px 6px;background:var(--bg-1);border-radius:5px">
                    <span><strong>#${n.idx}</strong> · ${n.type}</span>
                    <span class="tnum" style="color:var(--accent)">${n.freq} · ${n.gain} · Q=${n.q}</span>
                  </div>
                `,
                  )
                  .join('')}
              </div>
            </div>

            <!-- 2. Crossfeed Bauer / Meier -->
            <div class="om-DspModuleCard">
              <div class="om-DspModuleCard__head">
                <span style="display:flex;align-items:center;gap:6px">
                  ${icon('headphones', { size: 15 })}
                  <span>Crossfeed Bauer / Meier (Auriculares)</span>
                </span>
                <span class="om-Toggle ${this.eqState.crossfeed?.enabled ? 'is-on' : 'is-on'}" id="adv-crossfeed-toggle" style="cursor:pointer"></span>
              </div>
              <div class="om-DspModuleCard__sub tnum">
                <span>Corte ILD: ${this.eqState.crossfeed?.cutHz || 650} Hz · Nivel: ${this.eqState.crossfeed?.feedDb || 4.5} dB</span>
                <span>Retardo ITD: ${this.eqState.crossfeed?.delayUs || 320} µs</span>
              </div>
            </div>

            <!-- 3. Convolver FIR Híbrido FFT -->
            <div class="om-DspModuleCard">
              <div class="om-DspModuleCard__head">
                <span>Convolver FIR Híbrido FFT (Latencia Cero)</span>
                <span class="om-Toggle ${this.eqState.convolver?.enabled ? 'is-on' : ''}" id="adv-convolver-toggle" style="cursor:pointer"></span>
              </div>
              <div class="om-DspModuleCard__sub tnum">
                <span>IR: ${this.eqState.convolver?.irPath || 'Sennheiser_HD650_LinearPhase.wav'}</span>
                <span>Mezcla: ${Math.round((this.eqState.convolver?.mix ?? 1.0) * 100)} %</span>
              </div>
            </div>

            <!-- 4. ReplayGain 2.0 ITU-R BS.1770-4 / R128 -->
            <div class="om-DspModuleCard">
              <div class="om-DspModuleCard__head">
                <span>ReplayGain 2.0 (ITU-R BS.1770-4 / R128)</span>
                <span class="om-Toggle ${this.eqState.replayGain?.enabled ? 'is-on' : 'is-on'}" id="adv-replaygain-toggle" style="cursor:pointer"></span>
              </div>
              <div class="om-DspModuleCard__sub tnum">
                <span>Modo: Álbum (${this.eqState.replayGain?.targetLufs || -18} LUFS)</span>
                <span>True-Peak Guard 4x</span>
              </div>
            </div>

            <!-- 5. Resampler Kaiser-Sinc -->
            <div class="om-DspModuleCard">
              <div class="om-DspModuleCard__head">
                <span>Resampler Polifásico Kaiser-Sinc 64-bit</span>
                <span class="om-SignalBadge" style="padding:1px 7px;font-size:10px">Bypass Nativo</span>
              </div>
              <div class="om-DspModuleCard__sub tnum">
                <span>1024 ramas · &gt; 130 dB stop-band</span>
                <span>Tasa objetivo: Nativa</span>
              </div>
            </div>
          </div>
        `
        }
      </aside>
    `;

    this.bindEvents();
  }

  bindEvents() {
    // Cerrar Drawer
    const closeBtn = this.container.querySelector('#dsp-close-btn');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        if (this.onClose) this.onClose();
        else this.store.setState({ activeDrawer: null });
      });
    }

    // Pestañas
    const tabEqBtn = this.container.querySelector('#tab-eq-btn');
    const tabAdvBtn = this.container.querySelector('#tab-adv-btn');
    if (tabEqBtn) {
      tabEqBtn.addEventListener('click', () => {
        this.activeTab = 'eq';
        this.render();
      });
    }
    if (tabAdvBtn) {
      tabAdvBtn.addEventListener('click', () => {
        this.activeTab = 'adv';
        this.render();
      });
    }

    if (this.activeTab === 'eq') {
      // Preset Selector
      const select = this.container.querySelector('#eq-preset-select');
      if (select) {
        select.addEventListener('change', async (e) => {
          const presetId = e.target.value;
          try {
            const res = await ApiClient.applyPreset(presetId, 10);
            if (res.eqState) {
              this.eqState = { ...this.eqState, ...res.eqState };
              this.store.setState({ eqState: this.eqState });
              this.render();
            }
          } catch (err) {
            console.error('[OurMusic DSP] Error aplicando preset:', err);
          }
        });
      }

      // Bypass Toggle
      const bypassWrap = this.container.querySelector('#eq-bypass-wrap');
      if (bypassWrap) {
        bypassWrap.addEventListener('click', async () => {
          const newEnabled = !this.eqState.enabled;
          this.eqState.enabled = newEnabled;
          try {
            await ApiClient.setEq({ enabled: newEnabled });
            this.render();
          } catch (err) {
            console.error('[OurMusic DSP] Error cambiando bypass:', err);
          }
        });
      }

      // Suavizado
      const smoothRow = this.container.querySelector('#eq-smoothing-row');
      if (smoothRow) {
        smoothRow.addEventListener('click', async () => {
          const newSmooth = !this.eqState.smoothingEnabled;
          this.eqState.smoothingEnabled = newSmooth;
          try {
            await ApiClient.setEqSmoothing(newSmooth);
            this.render();
          } catch (err) {
            console.error('[OurMusic DSP] Error cambiando suavizado:', err);
          }
        });
      }

      // Limitador Padé
      const limiterRow = this.container.querySelector('#eq-limiter-row');
      if (limiterRow) {
        limiterRow.addEventListener('click', async () => {
          const newLimiter = !this.eqState.limiterEnabled;
          this.eqState.limiterEnabled = newLimiter;
          try {
            await ApiClient.setEq({ limiterEnabled: newLimiter });
            this.render();
          } catch (err) {
            console.error('[OurMusic DSP] Error cambiando limitador:', err);
          }
        });
      }

      // Faders interactivos
      this.bindFaders();
    } else {
      // Pestaña Avanzada Toggles
      const wireToggle = (id, callback) => {
        const el = this.container.querySelector(id);
        if (el) {
          el.addEventListener('click', callback);
        }
      };

      wireToggle('#adv-crossfeed-toggle', async () => {
        const cur = this.eqState.crossfeed?.enabled ?? true;
        this.eqState.crossfeed = { ...this.eqState.crossfeed, enabled: !cur };
        await ApiClient.setDspCrossfeed(this.eqState.crossfeed).catch(console.error);
        this.render();
      });

      wireToggle('#adv-convolver-toggle', async () => {
        const cur = this.eqState.convolver?.enabled ?? false;
        this.eqState.convolver = { ...this.eqState.convolver, enabled: !cur };
        await ApiClient.setDspConvolver(this.eqState.convolver).catch(console.error);
        this.render();
      });

      wireToggle('#adv-replaygain-toggle', async () => {
        const cur = this.eqState.replayGain?.enabled ?? true;
        this.eqState.replayGain = { ...this.eqState.replayGain, enabled: !cur };
        await ApiClient.setDspReplayGain(this.eqState.replayGain).catch(console.error);
        this.render();
      });
    }
  }

  bindFaders() {
    const tracks = this.container.querySelectorAll('.fader-track');

    tracks.forEach((track) => {
      const idxStr = track.getAttribute('data-index');
      const isPreamp = idxStr === 'pre';
      const bandIdx = isPreamp ? -1 : parseInt(idxStr, 10);

      const updateGainFromEvent = (e) => {
        const rect = track.getBoundingClientRect();
        const offsetY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const pct = offsetY / rect.height; // 0 (arriba) a 1 (abajo)
        // 0% = +12 dB, 50% = 0 dB, 100% = -12 dB
        const gain = Math.round((-(pct - 0.5) * 24) * 2) / 2; // pasos de 0.5 dB
        const clamped = Math.max(-12, Math.min(12, gain));

        if (isPreamp) {
          this.eqState.preampDb = clamped;
          ApiClient.setEqPreamp(clamped).catch(console.error);
        } else {
          this.eqState.gains[bandIdx] = clamped;
          this.eqState.activePresetId = 'custom';
          ApiClient.setEqBand(bandIdx, clamped).catch(console.error);
        }

        // Actualizar visualmente fader
        const label = this.container.querySelector(`#gain-label-${idxStr}`);
        const fill = this.container.querySelector(`#fader-fill-${idxStr}`);
        const knob = this.container.querySelector(`#fader-knob-${idxStr}`);
        const pctFromTop = 50 - (clamped / 12) * 42;
        const fillTop = Math.min(50, pctFromTop);
        const fillHeight = Math.abs(50 - pctFromTop);

        if (label) label.textContent = clamped > 0 ? `+${clamped.toFixed(1)}` : clamped.toFixed(1);
        if (fill) {
          fill.style.top = `${fillTop}%`;
          fill.style.height = `${fillHeight}%`;
        }
        if (knob) knob.style.top = `${pctFromTop}%`;

        // Actualizar curva en vivo
        const { strokePath, fillPath } = this.calculateCurvePath();
        const curveFill = this.container.querySelector('#eq-curve-fill');
        const curveStroke = this.container.querySelector('#eq-curve-stroke');
        const preampText = this.container.querySelector('#eq-curve-preamp-text');

        if (curveFill) curveFill.setAttribute('d', fillPath);
        if (curveStroke) curveStroke.setAttribute('d', strokePath);
        if (preampText) {
          preampText.textContent = `Pre-amp: ${this.eqState.preampDb > 0 ? '+' : ''}${this.eqState.preampDb.toFixed(1)} dB`;
        }
      };

      let isDragging = false;

      track.addEventListener('mousedown', (e) => {
        isDragging = true;
        this.isDraggingFader = true;
        updateGainFromEvent(e);

        const onMouseMove = (moveEv) => {
          if (isDragging) updateGainFromEvent(moveEv);
        };

        const onMouseUp = () => {
          isDragging = false;
          this.isDraggingFader = false;
          window.removeEventListener('mousemove', onMouseMove);
          window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
      });
    });
  }
}
