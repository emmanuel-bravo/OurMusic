import { EventEmitter } from 'node:events';
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');

export function resolveEngineBinary() {
  const exeName = process.platform === 'win32' ? 'ourmusic-engine.exe' : 'ourmusic-engine';
  return path.join(ROOT_DIR, 'bin', exeName);
}

/**
 * Asynchronous non-blocking IPC controller for OurMusic's native C11 audio & DSP engine.
 * Decouples UI/HTTP threads completely from real-time audio decoding and ALSA/WASAPI/ASIO output threads,
 * using adaptive telemetry polling so idle CPU usage drops to ~0%.
 */
export class EngineBridge extends EventEmitter {
  constructor({ binaryPath = resolveEngineBinary(), pollIntervalMs = 100 } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.pollIntervalMs = pollIntervalMs;
    this.idlePollIntervalMs = Math.max(pollIntervalMs, 800);
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuf = '';
    this.ready = false;
    this.pollTimer = null;
    this.pollingActive = false;
    this.lastStatus = null;
    this.lastEmittedSig = '';
    this.deviceConfig = {
      device: 'default',
      bitPerfect: true,
      dop: false,
      dsdMode: 'pcm',
    };
  }

  async start() {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(
        `No se encontró el binario nativo del motor en ${this.binaryPath}. Ejecuta primero el script de compilación.`,
      );
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = proc;

      proc.stdin.on('error', (err) => {
        // Ignorar EPIPE si el proceso ya terminó al salir
        if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') {
          this.emit('error', err);
        }
      });

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          reject(err);
        }
        this.emit('error', err);
      });

      proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString('utf8').trim();
        if (msg) this.emit('engine_log', msg);
      });

      proc.stdout.on('data', (chunk) => {
        this.stdoutBuf += chunk.toString('utf8');
        let nl;
        while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
          const line = this.stdoutBuf.slice(0, nl).trim();
          this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let parsed;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }

          if (parsed.type === 'ready') {
            this.ready = true;
            if (!settled) {
              settled = true;
              resolve(parsed);
            }
            this.emit('ready', parsed);
          } else if (parsed.type === 'reply') {
            const waiter = this.pending.get(parsed.id);
            if (waiter) {
              this.pending.delete(parsed.id);
              clearTimeout(waiter.timer);
              waiter.resolve(parsed);
            }
          } else if (parsed.type === 'event') {
            this.emit(parsed.event, parsed.data || {});
            this.emit('engine_event', { event: parsed.event, data: parsed.data || {} });
            this._wakePolling();
          }
        }
      });

      proc.on('close', (code) => {
        this.ready = false;
        this.proc = null;
        this._stopPolling();
        for (const [, waiter] of this.pending) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error(`El motor de audio se cerró (código ${code})`));
        }
        this.pending.clear();
        if (!settled) {
          settled = true;
          reject(new Error(`El motor nativo terminó prematuramente (código ${code})`));
        }
        this.emit('closed', code);
      });
    });

    this._startPolling();
  }

  _startPolling() {
    this._stopPolling();
    if (this.pollIntervalMs <= 0) return;
    this.pollingActive = true;
    this._scheduleNextPoll(this.pollIntervalMs);
  }

  _scheduleNextPoll(delayMs) {
    if (!this.pollingActive || !this.ready || !this.proc) return;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      if (!this.pollingActive || !this.ready || !this.proc) return;
      let nextDelay = this.idlePollIntervalMs;
      try {
        const st = await this.getStatus();
        if (st?.state === 'playing') {
          nextDelay = this.pollIntervalMs;
          this.lastEmittedSig = '';
          this.emit('telemetry', st);
        } else {
          const sig = `${st?.state}|${st?.currentPath}|${Math.round((st?.positionSec || 0) * 100)}|${st?.bitPerfectActive}`;
          if (sig !== this.lastEmittedSig) {
            this.lastEmittedSig = sig;
            this.emit('telemetry', st);
          }
        }
      } catch {
        // Ignore transient shutdown races
      }
      this._scheduleNextPoll(nextDelay);
    }, delayMs);
    this.pollTimer.unref?.();
  }

  _wakePolling() {
    if (!this.pollingActive || this.pollIntervalMs <= 0) return;
    this._scheduleNextPoll(Math.min(25, this.pollIntervalMs));
  }

  _stopPolling() {
    this.pollingActive = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  sendCommand(cmd, payload = {}, timeoutMs = 6000) {
    if (!this.proc || !this.ready || !this.proc.stdin || !this.proc.stdin.writable) {
      return Promise.reject(new Error('El motor de audio no está disponible'));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...payload }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tiempo agotado esperando respuesta a '${cmd}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(line, 'utf8', (err) => {
          if (err) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(err);
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async getStatus() {
    const res = await this.sendCommand('status');
    if (res.status && res.status.path !== undefined && res.status.currentPath === undefined) {
      res.status.currentPath = res.status.path;
    }
    this.lastStatus = res.status;
    return res.status;
  }

  async listDevices() {
    const res = await this.sendCommand('list_devices');
    return res.devices || [];
  }

  async setDevice({ device, bitPerfect, dop, dsdMode } = {}) {
    if (typeof device === 'string' && device.length > 0) this.deviceConfig.device = device;
    if (typeof bitPerfect === 'boolean') this.deviceConfig.bitPerfect = bitPerfect;
    if (typeof dsdMode === 'string' && ['pcm', 'dop', 'native'].includes(dsdMode.toLowerCase())) {
      this.deviceConfig.dsdMode = dsdMode.toLowerCase();
      this.deviceConfig.dop = this.deviceConfig.dsdMode === 'dop';
    } else if (typeof dop === 'boolean') {
      this.deviceConfig.dop = dop;
      this.deviceConfig.dsdMode = dop ? 'dop' : 'pcm';
    }
    return this.sendCommand('set_device', {
      device: this.deviceConfig.device,
      bitPerfect: this.deviceConfig.bitPerfect,
      dop: this.deviceConfig.dop,
      dsdMode: this.deviceConfig.dsdMode,
    });
  }

  async play(filePath, nextPath = '') {
    const res = await this.sendCommand('play', {
      path: path.resolve(filePath),
      nextPath: nextPath ? path.resolve(nextPath) : '',
    });
    if (!res.ok) throw new Error(res.error || 'No se pudo reproducir el archivo');
    this._wakePolling();
    return res;
  }

  async queueNext(nextPath) {
    return this.sendCommand('queue_next', {
      path: nextPath ? path.resolve(nextPath) : '',
    });
  }

  async pause(paused = true) {
    const res = await this.sendCommand('pause', { paused: Boolean(paused) });
    this._wakePolling();
    return res;
  }

  async stop() {
    const res = await this.sendCommand('stop');
    this._wakePolling();
    return res;
  }

  async seek(seconds) {
    const res = await this.sendCommand('seek', { seconds: Number(seconds) || 0 });
    this._wakePolling();
    return res;
  }

  async setVolume(value) {
    const clamped = Math.max(0, Math.min(1, Number(value)));
    return this.sendCommand('volume', { value: clamped });
  }

  /* --- Classic 5/10-Band Graphic Equalizer --- */

  async configureEqualizer({ enabled, numBands, preampDb, gains, smoothing, limiter } = {}) {
    const payload = {};
    if (typeof enabled === 'boolean') payload.enabled = enabled;
    if (typeof numBands === 'number') payload.numBands = numBands;
    if (typeof preampDb === 'number') payload.preampDb = preampDb;
    if (Array.isArray(gains)) payload.gains = gains.map((g) => Number(g) || 0);
    if (typeof smoothing === 'boolean') payload.smoothing = smoothing;
    if (typeof limiter === 'boolean') payload.limiter = limiter;
    return this.sendCommand('set_eq', payload);
  }

  async setBandGain(band, gainDb) {
    return this.sendCommand('set_band', {
      band: Number(band),
      gainDb: Number(gainDb) || 0,
    });
  }

  async setPreamp(preampDb) {
    return this.sendCommand('set_preamp', { preampDb: Number(preampDb) || 0 });
  }

  async setSmoothing(enabled) {
    return this.sendCommand('set_smoothing', { enabled: Boolean(enabled) });
  }

  async setDspHook({ enabled, stereoWidth = 1.0 } = {}) {
    return this.sendCommand('set_hook', {
      enabled: Boolean(enabled),
      stereoWidth: Number(stereoWidth),
    });
  }

  /* --- Point 1 & 2 Audiophile Upgrades: SRC, 16-Band PEQ, Crossfeed, Convolver & ReplayGain --- */

  async setResampler({ targetRate = 0, quality = 'high' } = {}) {
    return this.sendCommand('set_resampler', {
      targetRate: Math.max(0, Math.round(Number(targetRate) || 0)),
      quality: String(quality || 'high').toLowerCase(),
    });
  }

  async configureParametricEq({ enabled, preampDb, smoothing, limiter, bands } = {}) {
    const payload = {};
    if (typeof enabled === 'boolean') payload.enabled = enabled;
    if (typeof preampDb === 'number') payload.preampDb = preampDb;
    if (typeof smoothing === 'boolean') payload.smoothing = smoothing;
    if (typeof limiter === 'boolean') payload.limiter = limiter;
    if (Array.isArray(bands)) {
      payload.bands = bands.map((b) => ({
        enabled: b.enabled !== false,
        type: String(b.type || 'peaking'),
        freq: Number(b.freq) || 1000,
        q: Number(b.q) || 0.7071,
        gainDb: Number(b.gainDb) || 0,
      }));
    }
    return this.sendCommand('set_peq', payload);
  }

  async setPeqBand({ band = 0, enabled = true, type = 'peaking', freq = 1000, q = 1.0, gainDb = 0 } = {}) {
    return this.sendCommand('set_peq_band', {
      band: Number(band) || 0,
      enabled: Boolean(enabled),
      type: String(type || 'peaking'),
      freq: Number(freq) || 1000,
      q: Number(q) || 1.0,
      gainDb: Number(gainDb) || 0,
    });
  }

  async setCrossfeed({ enabled = false, cutoffHz = 700, feedDb = -6.0, itdUs = 260 } = {}) {
    return this.sendCommand('set_crossfeed', {
      enabled: Boolean(enabled),
      cutoffHz: Number(cutoffHz) || 700,
      feedDb: Number(feedDb) ?? -6.0,
      itdUs: Number(itdUs) ?? 260,
    });
  }

  async setConvolver({
    enabled = false,
    irPath = '',
    mix = 1.0,
    gainDb = 0.0,
    autoNormalize = false,
  } = {}) {
    const resolvedIr = irPath ? path.resolve(irPath) : '';
    const res = await this.sendCommand(
      'set_convolver',
      {
        enabled: Boolean(enabled),
        irPath: resolvedIr,
        mix: Number(mix ?? 1.0),
        gainDb: Number(gainDb) || 0,
        autoNormalize: Boolean(autoNormalize),
      },
      15000,
    );
    if (!res.ok) throw new Error(res.error || 'Error al configurar convolver FIR');
    return res;
  }

  async setReplayGain({
    mode,
    preampDb,
    preventClipping,
    trackGainDb,
    trackPeak,
    albumGainDb,
    albumPeak,
  } = {}) {
    const payload = {};
    if (typeof mode === 'string') payload.mode = mode;
    if (typeof preampDb === 'number') payload.preampDb = preampDb;
    if (typeof preventClipping === 'boolean') payload.preventClipping = preventClipping;
    if (typeof trackGainDb === 'number') payload.trackGainDb = trackGainDb;
    if (typeof trackPeak === 'number') payload.trackPeak = trackPeak;
    if (typeof albumGainDb === 'number') payload.albumGainDb = albumGainDb;
    if (typeof albumPeak === 'number') payload.albumPeak = albumPeak;
    return this.sendCommand('set_replaygain', payload);
  }

  async scanLoudness(filePath) {
    if (this.proc && this.ready) {
      const res = await this.sendCommand(
        'scan_loudness',
        { path: path.resolve(filePath) },
        60000,
      );
      if (!res.ok) throw new Error(res.error || 'Error al analizar sonoridad BS.1770-4');
      return res.loudness;
    }
    return EngineBridge.scanLoudnessCli(filePath, this.binaryPath);
  }

  static scanLoudnessCli(filePath, binaryPath = resolveEngineBinary()) {
    return new Promise((resolve, reject) => {
      execFile(
        binaryPath,
        ['--scan-loudness', path.resolve(filePath)],
        { timeout: 60000 },
        (err, stdout) => {
          if (err && !stdout) return reject(err);
          try {
            const parsed = JSON.parse(stdout.trim());
            if (!parsed.ok) return reject(new Error(parsed.error || 'Loudness scan failed'));
            resolve(parsed);
          } catch (parseErr) {
            reject(parseErr);
          }
        },
      );
    });
  }

  async probe(filePath) {
    if (this.proc && this.ready) {
      const res = await this.sendCommand('probe', { path: path.resolve(filePath) });
      if (!res.ok) throw new Error(res.error || 'Error al analizar flujo de audio');
      return res.probe;
    }
    return EngineBridge.probeCli(filePath, this.binaryPath);
  }

  static probeCli(filePath, binaryPath = resolveEngineBinary()) {
    return new Promise((resolve, reject) => {
      execFile(binaryPath, ['--probe', path.resolve(filePath)], { timeout: 5000 }, (err, stdout) => {
        if (err && !stdout) return reject(err);
        try {
          const parsed = JSON.parse(stdout.trim());
          if (!parsed.ok) return reject(new Error(parsed.error || 'Probe failed'));
          resolve(parsed);
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });
  }

  async shutdown() {
    this._stopPolling();
    if (!this.proc) return;
    const proc = this.proc;
    try {
      await this.sendCommand('quit', {}, 1500);
    } catch {
      proc.kill('SIGTERM');
    }
    await new Promise((resolve) => {
      if (!this.proc) return resolve();
      proc.once('close', resolve);
      setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 1000).unref?.();
    });
  }
}
