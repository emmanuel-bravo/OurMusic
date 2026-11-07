import fs from 'node:fs';
import path from 'node:path';

export const BAND_FREQS_5 = [60, 230, 910, 3600, 14000];
export const BAND_FREQS_10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const BUILTIN_PROFILES = [
  {
    id: 'flat',
    name: 'Plano',
    builtin: true,
    preampDb: 0.0,
    gains5: [0.0, 0.0, 0.0, 0.0, 0.0],
    gains10: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
  },
  {
    id: 'rock',
    name: 'Rock',
    builtin: true,
    preampDb: -2.5,
    gains5: [4.5, 1.5, -1.5, 2.5, 4.0],
    gains10: [5.0, 4.0, 2.5, 0.5, -1.5, -1.0, 1.5, 3.0, 4.0, 4.5],
  },
  {
    id: 'jazz',
    name: 'Jazz',
    builtin: true,
    preampDb: -1.5,
    gains5: [3.0, 1.5, -1.0, 2.0, 3.0],
    gains10: [3.5, 2.5, 1.5, 2.0, -1.5, -1.5, 0.5, 1.5, 2.5, 3.5],
  },
  {
    id: 'classical',
    name: 'Clásica',
    builtin: true,
    preampDb: -1.5,
    gains5: [3.5, 1.0, -0.5, 1.5, 3.0],
    gains10: [4.0, 3.0, 2.0, 1.0, -0.5, -0.5, 0.5, 1.5, 2.5, 3.5],
  },
  {
    id: 'vocal_acoustic',
    name: 'Vocal / Acústica',
    builtin: true,
    preampDb: -1.5,
    gains5: [-1.0, 1.5, 3.5, 2.5, 1.0],
    gains10: [-1.5, -0.5, 1.0, 2.0, 3.5, 3.5, 2.5, 2.0, 1.5, 0.5],
  },
  {
    id: 'deep_bass',
    name: 'Graves Profundos',
    builtin: true,
    preampDb: -3.5,
    gains5: [6.0, 3.5, 0.0, -0.5, 1.0],
    gains10: [6.5, 5.5, 4.0, 1.5, 0.0, -0.5, 0.0, 0.5, 1.0, 1.0],
  },
];

function clampGain(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-15, Math.min(15, Math.round(n * 100) / 100));
}

function clampPreamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-18, Math.min(18, Math.round(n * 100) / 100));
}

function interpolateGains(srcGains, targetBands) {
  if (srcGains.length === targetBands) return srcGains.map(clampGain);
  if (srcGains.length === 5 && targetBands === 10) {
    return [
      srcGains[0],
      (srcGains[0] + srcGains[1]) / 2,
      srcGains[1],
      (srcGains[1] + srcGains[2]) / 2,
      srcGains[2],
      srcGains[2],
      (srcGains[2] + srcGains[3]) / 2,
      srcGains[3],
      (srcGains[3] + srcGains[4]) / 2,
      srcGains[4],
    ].map(clampGain);
  }
  if (srcGains.length === 10 && targetBands === 5) {
    return [
      (srcGains[0] + srcGains[1]) / 2,
      (srcGains[2] + srcGains[3]) / 2,
      (srcGains[4] + srcGains[5]) / 2,
      (srcGains[6] + srcGains[7]) / 2,
      (srcGains[8] + srcGains[9]) / 2,
    ].map(clampGain);
  }
  const res = new Array(targetBands).fill(0);
  for (let i = 0; i < Math.min(res.length, srcGains.length); i++) {
    res[i] = clampGain(srcGains[i]);
  }
  return res;
}

/**
 * Equalizer Preset Manager — stores and retrieves classic and custom EQ configurations in JSON.
 */
export class PresetManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'eq_presets.json');
    this.statePath = path.join(dataDir, 'eq_state.json');
    this.customPresets = [];
    this.activeState = {
      enabled: false,
      numBands: 5,
      preampDb: 0.0,
      gains: [0, 0, 0, 0, 0],
      smoothingEnabled: true,
      limiterEnabled: true,
      customHookEnabled: false,
      stereoWidth: 1.0,
      activePresetId: 'flat',
    };
    this._load();
  }

  _load() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (Array.isArray(parsed.presets)) {
          this.customPresets = parsed.presets.filter((p) => p && typeof p.id === 'string' && !p.builtin);
        }
      } catch {
        this.customPresets = [];
      }
    }
    if (fs.existsSync(this.statePath)) {
      try {
        const st = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
        this.activeState = {
          ...this.activeState,
          ...st,
          numBands: st.numBands === 10 ? 10 : 5,
        };
        this.activeState.gains = interpolateGains(this.activeState.gains || [], this.activeState.numBands);
      } catch {
        // Keep clean defaults
      }
    }
  }

  _savePresets() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(
      this.filePath,
      JSON.stringify({ version: 1, presets: this.customPresets }, null, 2),
      'utf8'
    );
  }

  saveActiveState(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.activeState.enabled = patch.enabled;
    if (patch.numBands === 5 || patch.numBands === 10) {
      if (patch.numBands !== this.activeState.numBands && !Array.isArray(patch.gains)) {
        this.activeState.gains = interpolateGains(this.activeState.gains, patch.numBands);
      }
      this.activeState.numBands = patch.numBands;
    }
    if (typeof patch.preampDb === 'number') this.activeState.preampDb = clampPreamp(patch.preampDb);
    if (Array.isArray(patch.gains)) {
      this.activeState.gains = interpolateGains(patch.gains, this.activeState.numBands);
    }
    if (typeof patch.smoothingEnabled === 'boolean') {
      this.activeState.smoothingEnabled = patch.smoothingEnabled;
    }
    if (typeof patch.limiterEnabled === 'boolean') {
      this.activeState.limiterEnabled = patch.limiterEnabled;
    }
    if (typeof patch.customHookEnabled === 'boolean') {
      this.activeState.customHookEnabled = patch.customHookEnabled;
    }
    if (typeof patch.stereoWidth === 'number') {
      this.activeState.stereoWidth = Math.max(0, Math.min(2, patch.stereoWidth));
    }
    if (typeof patch.activePresetId === 'string') {
      this.activeState.activePresetId = patch.activePresetId;
    }

    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.statePath, JSON.stringify(this.activeState, null, 2), 'utf8');
    return this.getActiveState();
  }

  getActiveState() {
    const freqs = this.activeState.numBands === 10 ? BAND_FREQS_10 : BAND_FREQS_5;
    return {
      ...this.activeState,
      bandFreqs: [...freqs],
      gains: [...this.activeState.gains],
    };
  }

  listPresets(numBands = this.activeState.numBands) {
    const nb = numBands === 10 ? 10 : 5;
    const freqs = nb === 10 ? BAND_FREQS_10 : BAND_FREQS_5;
    const builtins = BUILTIN_PROFILES.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: true,
      numBands: nb,
      bandFreqs: [...freqs],
      preampDb: p.preampDb,
      gains: nb === 10 ? [...p.gains10] : [...p.gains5],
    }));
    const customs = this.customPresets.map((p) => ({
      id: p.id,
      name: p.name,
      builtin: false,
      numBands: nb,
      bandFreqs: [...freqs],
      preampDb: clampPreamp(p.preampDb),
      gains: interpolateGains(p.gains || [], nb),
      smoothingEnabled: typeof p.smoothingEnabled === 'boolean' ? p.smoothingEnabled : true,
      updatedAt: p.updatedAt || null,
    }));
    return [...builtins, ...customs];
  }

  getPreset(id, numBands = this.activeState.numBands) {
    return this.listPresets(numBands).find((p) => p.id === id) || null;
  }

  saveUserPreset({ id, name, numBands = 5, preampDb = 0, gains = [], smoothingEnabled = true }) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new Error('El nombre del preset no puede estar vacío');

    const nb = numBands === 10 ? 10 : 5;
    const normalizedGains = interpolateGains(gains, nb);
    const presetId =
      id && !BUILTIN_PROFILES.some((b) => b.id === id)
        ? String(id)
        : `user_${cleanName.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;

    const entry = {
      id: presetId,
      name: cleanName,
      builtin: false,
      numBands: nb,
      preampDb: clampPreamp(preampDb),
      gains: normalizedGains,
      smoothingEnabled: Boolean(smoothingEnabled),
      updatedAt: new Date().toISOString(),
    };

    const existingIdx = this.customPresets.findIndex((p) => p.id === presetId);
    if (existingIdx >= 0) {
      this.customPresets[existingIdx] = entry;
    } else {
      this.customPresets.push(entry);
    }
    this._savePresets();
    return this.getPreset(presetId, nb);
  }

  deleteUserPreset(id) {
    if (BUILTIN_PROFILES.some((b) => b.id === id)) {
      throw new Error('No se pueden eliminar los perfiles clásicos integrados');
    }
    const before = this.customPresets.length;
    this.customPresets = this.customPresets.filter((p) => p.id !== id);
    if (this.customPresets.length !== before) {
      this._savePresets();
      if (this.activeState.activePresetId === id) {
        this.saveActiveState({ activePresetId: 'custom' });
      }
      return true;
    }
    return false;
  }

  exportPresetJson(id, numBands = this.activeState.numBands) {
    const preset = this.getPreset(id, numBands);
    if (!preset) throw new Error(`Preset '${id}' no encontrado`);
    return JSON.stringify(
      {
        schema: 'ourmusic.eq.preset.v1',
        name: preset.name,
        numBands: preset.numBands,
        bandFreqs: preset.bandFreqs,
        preampDb: preset.preampDb,
        gains: preset.gains,
        smoothingEnabled: this.activeState.smoothingEnabled,
      },
      null,
      2
    );
  }

  importPresetJson(jsonInput) {
    const obj = typeof jsonInput === 'string' ? JSON.parse(jsonInput) : jsonInput;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.gains)) {
      throw new Error('JSON de preset inválido: falta el arreglo de ganancias (gains)');
    }
    return this.saveUserPreset({
      name: obj.name || 'Preset Importado',
      numBands: obj.numBands === 10 ? 10 : obj.gains.length === 10 ? 10 : 5,
      preampDb: obj.preampDb ?? 0,
      gains: obj.gains,
      smoothingEnabled: obj.smoothingEnabled ?? true,
    });
  }
}
