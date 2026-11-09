/*
 * OurMusic — Vista Inmersiva «Ahora Suena» y Letras Sincronizadas .LRC (Fase 3)
 * Atmósfera cromática dinámica (Color Thievery AA), carátula en alta definición,
 * barra de progreso recta y limpia (sin ondas ni rizos), transporte completo y
 * desplazamiento sincronizado verso a verso con click-to-seek.
 */
import { icon } from './icons.js';
import { coverSvg, formatTime, accentFrom } from './visuals.js';
import { ApiClient } from './api.js';

export function parseLrc(lrcText) {
  if (!lrcText || typeof lrcText !== 'string') return [];
  const lines = lrcText.split(/\r?\n/);
  const result = [];
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let match;
    const text = trimmed.replace(timeRegex, '').trim();
    timeRegex.lastIndex = 0;
    while ((match = timeRegex.exec(trimmed)) !== null) {
      const min = parseInt(match[1], 10);
      const sec = parseInt(match[2], 10);
      const ms = match[3] ? parseInt(match[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      const totalSec = min * 60 + sec + ms / 1000;
      result.push({
        seconds: totalSec,
        timeFormatted: `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`,
        text: text || '♪',
      });
    }
  }

  result.sort((a, b) => a.seconds - b.seconds);
  return result;
}

export class ImmersiveLyricsView {
  constructor({ container, store, onClose }) {
    this.container = container;
    this.store = store;
    this.onClose = onClose;

    this.currentTrackId = null;
    this.lyricsList = [];
    this.activeLyricIndex = -1;
    this.isSeeking = false;

    this.render();
    this.bindEvents();
    this.loadLyricsForCurrentTrack();

    this.unsubscribe = this.store.subscribe((state, keys) => {
      if (keys.includes('playback')) {
        this.updatePlayback(state);
      }
    });
  }

  destroy() {
    if (this.unsubscribe) this.unsubscribe();
    this.container.innerHTML = '';
  }

  async loadLyricsForCurrentTrack() {
    const trk = this.store.state.playback?.track;
    if (!trk || trk.id === this.currentTrackId) return;

    this.currentTrackId = trk.id;
    this.lyricsList = [];
    this.activeLyricIndex = -1;

    try {
      const detailRes = await ApiClient.getTrackDetail(trk.id).catch(() => null);
      const fullTrack = detailRes?.track || trk;
      if (fullTrack?.lyrics) {
        this.lyricsList = parseLrc(fullTrack.lyrics);
      }
    } catch (err) {
      console.warn('[OurMusic Immersive] No se cargaron letras:', err);
    }

    this.render();
    this.bindEvents();
  }

  render() {
    const { playback } = this.store.state;
    const trk = playback.track || {
      title: 'Reproductor HiFi OurMusic',
      artist: 'Selecciona una pista para comenzar',
      album: 'OurMusic Hi-Res Library',
      year: 2026,
      codec: 'FLAC',
      sampleRate: 96000,
      bitDepth: 24,
    };

    const albumKey = trk.album || trk.title || 'OurMusic';
    const accent = accentFrom(albumKey);
    const pct = Math.round((playback.progress || 0) * 100);

    this.container.innerHTML = `
      <div class="om-Immersive" style="
        background:
          radial-gradient(720px 580px at 22% 40%, rgba(var(--accent-rgb), 0.32), transparent 75%),
          radial-gradient(640px 520px at 80% 28%, rgba(91, 127, 184, 0.20), transparent 72%),
          #0a0908;
        width: 100vw;
        height: 100vh;
      ">
        <!-- Cabecera Superior de Sala de Escucha -->
        <header class="om-Immersive__top">
          <div style="display:flex;align-items:center;gap:12px">
            <div class="om-Brand__logo" style="width:32px;height:32px">
              ${icon('disc', { size: 20 })}
            </div>
            <div>
              <div style="font-size:13px;font-weight:700;color:var(--text-1)">Ahora Suena · Modo Sala de Escucha</div>
              <div style="font-size:11px;color:var(--text-2)" class="tnum">
                ${trk.codec || 'FLAC'} ${trk.bitDepth ? trk.bitDepth + '-bit / ' : ''}${trk.sampleRate ? Math.round(trk.sampleRate / 1000) + ' kHz' : ''} · ${playback.outputMode || 'Bit-Perfect'}
              </div>
            </div>
          </div>

          <div style="display:flex;align-items:center;gap:10px">
            <span class="om-Pill is-active" style="padding:4px 12px;font-size:11px">Letras Sincronizadas (.LRC)</span>
            <button class="om-BtnGhost" id="immersive-exit-btn" style="cursor:pointer">
              ${icon('close', { size: 14 })}
              <span>Salir (Esc)</span>
            </button>
          </div>
        </header>

        <!-- Escenario Central (Carátula Hi-Res + Controles Rectos + Letras Sincronizadas) -->
        <div class="om-Immersive__stage">
          <!-- Columna Izquierda: Disco, Metadatos y Controles de Transporte -->
          <div class="om-Immersive__vinyl">
            <div class="om-Immersive__art" style="position:relative">
              ${
                trk.coverId || trk.coverArtId
                  ? `<img src="/api/covers/${encodeURIComponent(trk.coverId || trk.coverArtId)}" style="width:100%;height:100%;object-fit:cover" alt="${trk.album || ''}" />`
                  : coverSvg(trk, 420)
              }
            </div>

            <div>
              <h1 style="font-size:28px;font-weight:800;letter-spacing:-0.025em;line-height:1.2" id="imm-title">
                ${trk.title || trk.fileName || 'Pista'}
              </h1>
              <div style="font-size:15px;color:var(--text-2);margin-top:6px" id="imm-artist">
                ${trk.artist || 'Artista Desconocido'} — ${trk.album || 'Álbum'} ${trk.year ? `(${trk.year})` : ''}
              </div>
            </div>

            <!-- Barra de Progreso Recta y Limpia (Sin ondas) -->
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
              <div class="om-SeekRow" style="max-width:100%">
                <span class="om-Time tnum" id="imm-time-cur">${formatTime(playback.positionSec)}</span>
                <div class="om-SeekBar" id="imm-seek-bar" style="cursor:pointer;flex:1">
                  <div class="om-SeekFill" id="imm-seek-fill" style="width:${pct}%"></div>
                  <div class="om-SeekThumb" id="imm-seek-thumb" style="left:${pct}%"></div>
                </div>
                <span class="om-Time is-end tnum" id="imm-time-end">${formatTime(playback.durationSec)}</span>
              </div>

              <!-- Controles de Transporte -->
              <div class="om-Transport" style="justify-content:center;margin-top:4px">
                <button class="om-IconBtn" id="imm-shuffle-btn" title="Aleatorio (S)" style="color:${playback.shuffle ? 'var(--accent)' : 'var(--text-2)'}">
                  ${icon('shuffle', { size: 18 })}
                </button>
                <button class="om-IconBtn" id="imm-prev-btn" title="Pista Anterior (Ctrl+Izquierda)">
                  ${icon('prev', { size: 22 })}
                </button>
                <button class="om-PlayBtn" id="imm-play-btn" style="width:48px;height:48px" title="Reproducir / Pausar (Espacio)">
                  ${playback.state === 'playing' ? icon('pause', { size: 22 }) : icon('play', { size: 22 })}
                </button>
                <button class="om-IconBtn" id="imm-next-btn" title="Siguiente Pista (Ctrl+Derecha)">
                  ${icon('next', { size: 22 })}
                </button>
                <button class="om-IconBtn" id="imm-repeat-btn" title="Repetir (R)" style="color:${playback.repeat !== 'off' ? 'var(--accent)' : 'var(--text-2)'}">
                  ${icon('repeat', { size: 18 })}
                </button>
              </div>
            </div>
          </div>

          <!-- Columna Derecha: Letras Sincronizadas -->
          <div class="om-LyricsStage" id="imm-lyrics-stage" aria-label="Letras sincronizadas" style="max-height:68vh;overflow-y:auto;padding-right:12px">
            ${
              this.lyricsList.length > 0
                ? this.lyricsList
                    .map((line, idx) => {
                      return `
                  <div class="om-LyricLine lyric-line" data-idx="${idx}" data-time="${line.seconds}" style="cursor:pointer" title="Saltar a ${line.timeFormatted}">
                    <span>${line.text}</span>
                    <span class="om-LyricTime tnum">${line.timeFormatted}</span>
                  </div>
                `;
                    })
                    .join('')
                : `
              <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;min-height:300px;text-align:center;color:var(--text-3);gap:14px">
                <div style="opacity:0.35">${icon('disc', { size: 56 })}</div>
                <div style="font-size:18px;font-weight:600;color:var(--text-2)">Pista Instrumental o sin archivo .LRC</div>
                <div style="font-size:13px;max-width:340px;line-height:1.5">
                  OurMusic escanea automáticamente archivos .LRC con el mismo nombre de la canción o etiquetas USLT integradas.
                </div>
              </div>
            `
            }
          </div>
        </div>

        <!-- Pie de Página de Contraste AA y Ayuda -->
        <footer style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-3)">
          <span>Haz clic en cualquier verso para saltar directamente a su marca de tiempo exacta</span>
          <span class="tnum">Color Thievery AA · Relación de Contraste Verificada ≥ 4.5:1</span>
        </footer>
      </div>
    `;

    this.syncActiveLyric(playback.positionSec);
  }

  bindEvents() {
    // Salir del modo inmersivo
    const exitBtn =
      this.container.querySelector('#immersive-exit-btn') ||
      this.container.querySelector('#imm-exit-btn');
    if (exitBtn) {
      exitBtn.addEventListener('click', () => {
        if (this.onClose) this.onClose();
        else this.store.setState({ immersiveOpen: false });
      });
    }

    // Play / Pause
    const playBtn = this.container.querySelector('#imm-play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', async () => {
        const { playback } = this.store.state;
        if (playback.state === 'playing') {
          await ApiClient.pause().catch(console.error);
        } else {
          await ApiClient.play().catch(console.error);
        }
      });
    }

    // Prev / Next
    const prevBtn = this.container.querySelector('#imm-prev-btn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => ApiClient.previous().catch(console.error));
    }
    const nextBtn = this.container.querySelector('#imm-next-btn');
    if (nextBtn) {
      nextBtn.addEventListener('click', () => ApiClient.next().catch(console.error));
    }

    // Shuffle / Repeat
    const shufBtn = this.container.querySelector('#imm-shuffle-btn');
    if (shufBtn) {
      shufBtn.addEventListener('click', async () => {
        const cur = this.store.state.playback.shuffle;
        await ApiClient.setModes({ shuffle: !cur }).catch(console.error);
      });
    }
    const repBtn = this.container.querySelector('#imm-repeat-btn');
    if (repBtn) {
      repBtn.addEventListener('click', async () => {
        const cur = this.store.state.playback.repeat;
        const modes = ['off', 'all', 'one'];
        const next = modes[(modes.indexOf(cur) + 1) % modes.length];
        await ApiClient.setModes({ repeat: next }).catch(console.error);
      });
    }

    // Seek recto interactivo
    const seekBar = this.container.querySelector('#imm-seek-bar');
    if (seekBar) {
      const handleSeek = async (e) => {
        const rect = seekBar.getBoundingClientRect();
        const clickX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const pct = clickX / rect.width;
        const { playback } = this.store.state;
        const targetSec = pct * (playback.durationSec || 1);

        this.updateSeekVisuals(pct, targetSec);
        try {
          await ApiClient.seek(targetSec);
        } catch (err) {
          console.error('[OurMusic Immersive] Error al hacer seek:', err);
        }
      };

      seekBar.addEventListener('click', handleSeek);
    }

    // Clic en verso para saltar en el audio (Click-to-seek)
    const lyricLines = this.container.querySelectorAll('.lyric-line');
    lyricLines.forEach((lineEl) => {
      lineEl.addEventListener('click', async () => {
        const timeSec = parseFloat(lineEl.getAttribute('data-time'));
        if (!isNaN(timeSec)) {
          try {
            await ApiClient.seek(timeSec);
            this.syncActiveLyric(timeSec);
          } catch (err) {
            console.error('[OurMusic Immersive] Error al saltar verso:', err);
          }
        }
      });
    });
  }

  updateSeekVisuals(pct, sec) {
    const fill = this.container.querySelector('#imm-seek-fill');
    const thumb = this.container.querySelector('#imm-seek-thumb');
    const curTime = this.container.querySelector('#imm-time-cur');
    const pct100 = (pct * 100).toFixed(2);
    if (fill) fill.style.width = `${pct100}%`;
    if (thumb) thumb.style.left = `${pct100}%`;
    if (curTime) curTime.textContent = formatTime(sec);
  }

  syncActiveLyric(currentSec) {
    if (!this.lyricsList || this.lyricsList.length === 0) return;

    // Encontrar el verso que corresponde al tiempo actual
    let activeIdx = -1;
    for (let i = 0; i < this.lyricsList.length; i++) {
      if (this.lyricsList[i].seconds <= currentSec + 0.25) {
        activeIdx = i;
      } else {
        break;
      }
    }

    if (activeIdx !== this.activeLyricIndex) {
      this.activeLyricIndex = activeIdx;
      const stage = this.container.querySelector('#imm-lyrics-stage');
      const lines = this.container.querySelectorAll('.lyric-line');

      lines.forEach((lineEl, idx) => {
        lineEl.classList.remove('is-active', 'is-past');
        if (idx === activeIdx) {
          lineEl.classList.add('is-active');
          // Desplazamiento suave centrado
          lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else if (idx < activeIdx) {
          lineEl.classList.add('is-past');
        }
      });
    }
  }

  updatePlayback(state) {
    const { playback } = state;
    const trk = playback.track;

    // Si cambió de pista, cargar letras de la nueva pista
    if (trk && trk.id !== this.currentTrackId) {
      this.loadLyricsForCurrentTrack();
      return;
    }

    // Actualizar Play / Pause Icon solo cuando cambia el estado
    const playBtn = this.container.querySelector('#imm-play-btn');
    if (playBtn && this._lastRenderedPlayState !== playback.state) {
      this._lastRenderedPlayState = playback.state;
      playBtn.innerHTML =
        playback.state === 'playing' ? icon('pause', { size: 22 }) : icon('play', { size: 22 });
    }

    // Actualizar Seek Bar recta
    if (!this.isSeeking) {
      this.updateSeekVisuals(playback.progress, playback.positionSec);
      const endTime = this.container.querySelector('#imm-time-end');
      if (endTime) endTime.textContent = formatTime(playback.durationSec);
    }

    // Sincronizar letra activa verso a verso
    this.syncActiveLyric(playback.positionSec);
  }
}
