/**
 * Clean-room synchronized lyrics (.lrc) parser and serializer.
 * Supports [mm:ss.xx], [mm:ss.xxx], and [mm:ss:xx] timestamps plus metadata headers.
 */

const LRC_TAG_RE = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLrc(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  const entries = [];

  for (const rawLine of lines) {
    LRC_TAG_RE.lastIndex = 0;
    const timestamps = [];
    let match;
    let lastEnd = 0;

    while ((match = LRC_TAG_RE.exec(rawLine)) !== null) {
      const mins = parseInt(match[1], 10);
      const secs = parseInt(match[2], 10);
      let ms = 0;
      if (match[3] !== undefined) {
        const frac = match[3];
        if (frac.length === 1) ms = parseInt(frac, 10) * 100;
        else if (frac.length === 2) ms = parseInt(frac, 10) * 10;
        else ms = parseInt(frac.slice(0, 3), 10);
      }
      timestamps.push(mins * 60000 + secs * 1000 + ms);
      lastEnd = match.index + match[0].length;
    }

    if (timestamps.length > 0) {
      const lyric = rawLine.slice(lastEnd).trim();
      for (const timeMs of timestamps) {
        entries.push({ timeMs, text: lyric });
      }
    }
  }

  entries.sort((a, b) => a.timeMs - b.timeMs);
  return entries;
}

export function formatLrc(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const sorted = [...entries].sort((a, b) => a.timeMs - b.timeMs);
  return sorted
    .map(({ timeMs, text }) => {
      const clamped = Math.max(0, Math.round(Number(timeMs) || 0));
      const mins = Math.floor(clamped / 60000);
      const rem = clamped % 60000;
      const secs = Math.floor(rem / 1000);
      const cs = Math.floor((rem % 1000) / 10);
      const mm = String(mins).padStart(2, '0');
      const ss = String(secs).padStart(2, '0');
      const xx = String(cs).padStart(2, '0');
      return `[${mm}:${ss}.${xx}] ${text ?? ''}`.trimEnd();
    })
    .join('\n');
}
