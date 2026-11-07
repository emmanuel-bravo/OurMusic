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
 * Decouples UI/HTTP threads completely from real-time audio decoding and ALSA/WASAPI output threads.
 */
export class EngineBridge extends EventEmitter {
  constructor({ binaryPath = resolveEngineBinary(), pollIntervalMs = 100 } = {}) {
    super();
    this.binaryPath = binaryPath;
    this.pollIntervalMs = pollIntervalMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuf = '';
    this.ready = false;
    this.pollTimer = null;
    this.lastStatus = null;
    this.deviceConfig = {
      device: 'default',
      bitPerfect: true,
      dop: false,
    };
  }

  async start() {
    if (this.proc) return;
    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(
        `No se encontró el binario nativo del motor en ${this.binaryPath}. Ejecuta primero el script de compilación.`
      );
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(this.binaryPath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      this.proc = proc;

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
    this.pollTimer = setInterval(async () => {
      if (!this.ready || !this.proc) return;
      try {
        const st = await this.getStatus();
        this.lastStatus = st;
        this.emit('telemetry', st);
      } catch {
        // Ignore transient shutdown races
      }
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  _stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  sendCommand(cmd, payload = {}, timeoutMs = 6000) {
    if (!this.proc || !this.ready) {
      return Promise.reject(new Error('El motor de audio no está iniciado'));
    }
    const id = this.nextId++;
    const line = JSON.stringify({ id, cmd, ...payload }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Tiempo agotado esperando respuesta a '${cmd}'`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(line, 'utf8');
    });
  }

  async getStatus() {
    const res = await this.sendCommand('status');
    this.lastStatus = res.status;
    return res.status;
  }

  async listDevices() {
    const res = await this.sendCommand('list_devices');
    return res.devices || [];
  }

  async setDevice({ device, bitPerfect, dop } = {}) {
    if (typeof device === 'string' && device.length > 0) this.deviceConfig.device = device;
    if (typeof bitPerfect === 'boolean') this.deviceConfig.bitPerfect = bitPerfect;
    if (typeof dop === 'boolean') this.deviceConfig.dop = dop;
    return this.sendCommand('set_device', {
      device: this.deviceConfig.device,
      bitPerfect: this.deviceConfig.bitPerfect,
      dop: this.deviceConfig.dop,
    });
  }

  async play(filePath, nextPath = '') {
    const res = await this.sendCommand('play', {
      path: path.resolve(filePath),
      nextPath: nextPath ? path.resolve(nextPath) : '',
    });
    if (!res.ok) throw new Error(res.error || 'No se pudo reproducir el archivo');
    return res;
  }

  async queueNext(nextPath) {
    return this.sendCommand('queue_next', {
      path: nextPath ? path.resolve(nextPath) : '',
    });
  }

  async pause(paused = true) {
    return this.sendCommand('pause', { paused: Boolean(paused) });
  }

  async stop() {
    return this.sendCommand('stop');
  }

  async seek(seconds) {
    return this.sendCommand('seek', { seconds: Number(seconds) || 0 });
  }

  async setVolume(value) {
    const clamped = Math.max(0, Math.min(1, Number(value)));
    return this.sendCommand('volume', { value: clamped });
  }

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
