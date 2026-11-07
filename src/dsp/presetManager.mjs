import fs from 'node:fs';
import path from 'node:path';

export const BAND_FREQS_5 = [60, 230, 910, 3600, 14000];
export const BAND_FREQS_10 = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const VALID_PEQ_TYPES = new Set([
  'peaking',
  'low_shelf',
  'high_shelf',
  'low_pass',
  'high_pass',
  'notch',
  'all_pass',
]);

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

function clampGain(v, maxAbs = 15) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-maxAbs, Math.min(maxAbs, Math.round(n * 100) / 100));
}

function clampPreamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-18, Math.min(18, Math.round(n * 100) / 100));
}

function normalizePeqBands(bands = []) {
  if (!Array.isArray(bands)) return [];
  return bands.slice(0, 16).map((b) => {
    const rawType = String(b?.type || 'peaking').toLowerCase();
    return {
      enabled: b?.enabled !== false,
      type: VALID_PEQ_TYPES.has(rawType) ? rawType : 'peaking',
      freq: Math.max(10, Math.min(24000, Number(b?.freq) || 1000)),
      q: Math.max(0.1, Math.min(24.0, Number(b?.q) || 0.7071)),
      gainDb: clampGain(b?.gainDb, 24),
    };
  });
}

function interpolateGains(srcGains, targetBands) {
  if (srcGains.length === targetBands) return srcGains.map((g) => clampGain(g, 15));
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
    ].map((g) => clampGain(g, 15));
  }
  if (srcGains.length === 10 && targetBands === 5) {
    return [
      (srcGains[0] + srcGains[1]) / 2,
      (srcGains[2] + srcGains[3]) / 2,
      (srcGains[4] + srcGains[5]) / 2,
      (srcGains[6] + srcGains[7]) / 2,
      (srcGains[8] + srcGains[9]) / 2,
    ].map((g) => clampGain(g, 15));
  }
  const res = new Array(targetBands).fill(0);
  for (let i = 0; i < Math.min(res.length, srcGains.length); i++) {
    res[i] = clampGain(srcGains[i], 15);
  }
  return res;
}

/**
 * Equalizer & Audiophile DSP State Manager — stores classic/custom Graphic EQ presets,
 * 16-band Parametric EQ (PEQ), Headphone Crossfeed, Partitioned FFT Convolver,
 * ReplayGain 2.0 / R128 normalization, and Polyphase Sinc Resampler settings.
 */
export class PresetManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.filePath = path.join(dataDir, 'eq_presets.json');
    this.statePath = path.join(dataDir, 'eq_state.json');
    this.customPresets = [];
    this.activeState = {
      enabled: false,
      peqMode: false,
      numBands: 5,
      preampDb: 0.0,
      gains: [0, 0, 0, 0, 0],
      peqBands: [],
      smoothingEnabled: true,
      limiterEnabled: true,
      customHookEnabled: false,
      stereoWidth: 1.0,
      crossfeed: {
        enabled: false,
        cutoffHz: 700,
        feedDb: -6.0,
        itdUs: 260,
      },
      convolver: {
        enabled: false,
        irPath: '',
        mix: 1.0,
        gainDb: 0.0,
        autoNormalize: false,
      },
      replayGain: {
        mode: 'off',
        preampDb: 0.0,
        preventClipping: true,
      },
      resampler: {
        targetRate: 0,
        quality: 'high',
      },
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
          peqBands: normalizePeqBands(st.peqBands),
          crossfeed: { ...this.activeState.crossfeed, ...(st.crossfeed || {}) },
          convolver: { ...this.activeState.convolver, ...(st.convolver || {}) },
          replayGain: { ...this.activeState.replayGain, ...(st.replayGain || {}) },
          resampler: { ...this.activeState.resampler, ...(st.resampler || {}) },
        };
        this.activeState.gains = interpolateGains(
          this.activeState.gains || [],
          this.activeState.numBands,
        );
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
      'utf8',
    );
  }

  saveActiveState(patch = {}) {
    if (typeof patch.enabled === 'boolean') this.activeState.enabled = patch.enabled;
    if (typeof patch.peqMode === 'boolean') this.activeState.peqMode = patch.peqMode;
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
    if (Array.isArray(patch.peqBands)) {
      this.activeState.peqBands = normalizePeqBands(patch.peqBands);
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
    if (patch.crossfeed && typeof patch.crossfeed === 'object') {
      this.activeState.crossfeed = {
        enabled:
          typeof patch.crossfeed.enabled === 'boolean'
            ? patch.crossfeed.enabled
            : this.activeState.crossfeed.enabled,
        cutoffHz: Math.max(
          300,
          Math.min(2000, Number(patch.crossfeed.cutoffHz ?? this.activeState.crossfeed.cutoffHz)),
        ),
        feedDb: Math.max(
          -15,
          Math.min(0, Number(patch.crossfeed.feedDb ?? this.activeState.crossfeed.feedDb)),
        ),
        itdUs: Math.max(
          0,
          Math.min(650, Number(patch.crossfeed.itdUs ?? this.activeState.crossfeed.itdUs)),
        ),
      };
    }
    if (patch.convolver && typeof patch.convolver === 'object') {
      this.activeState.convolver = {
        enabled:
          typeof patch.convolver.enabled === 'boolean'
            ? patch.convolver.enabled
            : this.activeState.convolver.enabled,
        irPath:
          typeof patch.convolver.irPath === 'string'
            ? patch.convolver.irPath
            : this.activeState.convolver.irPath,
        mix: Math.max(0, Math.min(1, Number(patch.convolver.mix ?? this.activeState.convolver.mix))),
        gainDb: Math.max(
          -24,
          Math.min(12, Number(patch.convolver.gainDb ?? this.activeState.convolver.gainDb)),
        ),
        autoNormalize:
          typeof patch.convolver.autoNormalize === 'boolean'
            ? patch.convolver.autoNormalize
            : this.activeState.convolver.autoNormalize,
      };
    }
    if (patch.replayGain && typeof patch.replayGain === 'object') {
      const m = String(patch.replayGain.mode ?? this.activeState.replayGain.mode).toLowerCase();
      this.activeState.replayGain = {
        mode: ['off', 'track', 'album'].includes(m) ? m : 'off',
        preampDb: clampPreamp(patch.replayGain.preampDb ?? this.activeState.replayGain.preampDb),
        preventClipping:
          typeof patch.replayGain.preventClipping === 'boolean'
            ? patch.replayGain.preventClipping
            : this.activeState.replayGain.preventClipping,
      };
    }
    if (patch.resampler && typeof patch.resampler === 'object') {
      const q = String(patch.resampler.quality ?? this.activeState.resampler.quality).toLowerCase();
      this.activeState.resampler = {
        targetRate: Math.max(
          0,
          Math.round(Number(patch.resampler.targetRate ?? this.activeState.resampler.targetRate) || 0),
        ),
        quality: ['fast', 'high', 'ultra'].includes(q) ? q : 'high',
      };
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
      peqBands: this.activeState.peqBands.map((b) => ({ ...b })),
      crossfeed: { ...this.activeState.crossfeed },
      convolver: { ...this.activeState.convolver },
      replayGain: { ...this.activeState.replayGain },
      resampler: { ...this.activeState.resampler },
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
      2,
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
