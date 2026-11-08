/*
 * OurMusic — Capa de API y cliente SSE para la UI funcional
 */

export class ApiClient {
  static async get(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error HTTP ${res.status}`);
    }
    return res.json();
  }

  static async post(url, body = {}) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error HTTP ${res.status}`);
    }
    return res.json();
  }

  static async put(url, body = {}) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error HTTP ${res.status}`);
    }
    return res.json();
  }

  static async delete(url) {
    const res = await fetch(url, { method: 'DELETE', headers: { Accept: 'application/json' } });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Error HTTP ${res.status}`);
    }
    return res.json();
  }

  // --- Bootstrap & Library ---
  static getBootstrap(limit = 100, offset = 0) {
    return this.get(`/api/bootstrap?limit=${limit}&offset=${offset}`);
  }

  static getSummary() {
    return this.get('/api/library/summary');
  }

  static getDbStats() {
    return this.get('/api/library/db-stats');
  }

  static getTracks(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return this.get(`/api/library/tracks${qs ? '?' + qs : ''}`);
  }

  static addFolder(folderPath) {
    return this.post('/api/library/folder', { path: folderPath });
  }

  static startScan(folderPath = null) {
    return this.post('/api/library/scan', folderPath ? { path: folderPath } : {});
  }

  // --- Player Transport ---
  static play(track = null, index = null) {
    return this.post('/api/player/play', { track, index });
  }

  static pause() {
    return this.post('/api/player/pause');
  }

  static stop() {
    return this.post('/api/player/stop');
  }

  static seek(positionSec) {
    return this.post('/api/player/seek', { positionSec });
  }

  static next() {
    return this.post('/api/player/next');
  }

  static previous() {
    return this.post('/api/player/previous');
  }

  static setVolume(volume) {
    return this.post('/api/player/volume', { volume });
  }

  static setModes({ repeat, shuffle }) {
    return this.post('/api/player/modes', { repeat, shuffle });
  }

  // --- Queue ---
  static getQueue() {
    return this.get('/api/queue');
  }

  static enqueue({ track = null, tracks = null, playNext = false }) {
    return this.post('/api/queue/enqueue', { track, tracks, playNext });
  }

  // --- Real-time SSE Stream ---
  static subscribeEvents(onEvent, onError) {
    const es = new EventSource('/api/events');
    const handlers = [
      'telemetry',
      'track_started',
      'playback_ended',
      'queue_updated',
      'scan_started',
      'scan_progress',
      'scan_completed',
      'track_updated',
      'watcher_indexed',
      'watcher_removed',
      'library_changed',
    ];

    for (const h of handlers) {
      es.addEventListener(h, (e) => {
        try {
          const data = JSON.parse(e.data);
          onEvent(h, data);
        } catch (err) {
          console.error(`Error parseando evento SSE ${h}:`, err);
        }
      });
    }

    if (onError) es.onerror = onError;
    return es;
  }
}
