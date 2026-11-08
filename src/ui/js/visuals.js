/*
 * OurMusic — Carátulas abstractas procedurales (solo para bocetos) y
 * utilidades de color para el extractor dinámico (Color Thievery).
 */

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

let uid = 0;

/** Devuelve el SVG (string) de una carátula abstracta determinista. */
export function coverSvg(album) {
  const id = `cv${uid++}`;
  const rnd = mulberry32(hashString(album.title + album.artist));
  const [bg, c1, c2, c3] = album.palette;
  const parts = [];
  const defs = [
    `<linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bg}"/><stop offset="1" stop-color="${shade(bg, -0.35)}"/></linearGradient>`,
    `<filter id="${id}b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="9"/></filter>`,
    `<filter id="${id}n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 0.07 0"/></filter>`,
  ];
  parts.push(`<rect width="100" height="100" fill="url(#${id}g)"/>`);

  switch (album.style) {
    case 'orbs':
      for (let i = 0; i < 4; i++) {
        const c = [c1, c2, c3][i % 3];
        parts.push(`<circle cx="${15 + rnd() * 70}" cy="${15 + rnd() * 70}" r="${14 + rnd() * 22}" fill="${c}" opacity="${0.55 + rnd() * 0.35}" filter="url(#${id}b)"/>`);
      }
      break;
    case 'rings': {
      const cx = 30 + rnd() * 40;
      const cy = 30 + rnd() * 40;
      for (let r = 46; r > 4; r -= 7) {
        parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${r % 14 === 4 ? c1 : c2}" stroke-width="${1.2 + rnd() * 2.4}" opacity="0.85"/>`);
      }
      parts.push(`<circle cx="${cx}" cy="${cy}" r="5" fill="${c3}"/>`);
      break;
    }
    case 'stripes': {
      const ang = Math.floor(rnd() * 4) * 15 + 20;
      let x = -40;
      let k = 0;
      while (x < 140) {
        const w = 4 + rnd() * 12;
        parts.push(`<rect x="${x}" y="-40" width="${w}" height="180" fill="${[c1, c2, c3][k % 3]}" opacity="${0.5 + rnd() * 0.5}" transform="rotate(${ang} 50 50)"/>`);
        x += w + 3 + rnd() * 9;
        k++;
      }
      break;
    }
    case 'bauhaus':
      parts.push(`<rect x="${rnd() * 20}" y="${50 + rnd() * 10}" width="${45 + rnd() * 20}" height="40" fill="${c1}"/>`);
      parts.push(`<circle cx="${60 + rnd() * 15}" cy="${35 + rnd() * 10}" r="${18 + rnd() * 8}" fill="${c2}"/>`);
      parts.push(`<path d="M${10 + rnd() * 20} 12 L${45 + rnd() * 10} 12 L${20 + rnd() * 10} 46 Z" fill="${c3}"/>`);
      parts.push(`<rect x="0" y="${88 - rnd() * 4}" width="100" height="2" fill="${c3}" opacity="0.7"/>`);
      break;
    case 'horizon': {
      const hy = 52 + rnd() * 14;
      defs.push(`<linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>`);
      parts.push(`<rect width="100" height="${hy}" fill="url(#${id}s)" opacity="0.9"/>`);
      parts.push(`<circle cx="${30 + rnd() * 40}" cy="${hy - 2}" r="${12 + rnd() * 8}" fill="${c3}" opacity="0.95"/>`);
      parts.push(`<rect y="${hy}" width="100" height="${100 - hy}" fill="${bg}"/>`);
      for (let i = 0; i < 6; i++) {
        parts.push(`<rect x="${10 + rnd() * 60}" y="${hy + 4 + i * 5}" width="${10 + rnd() * 30}" height="1.4" fill="${c3}" opacity="${0.55 - i * 0.07}"/>`);
      }
      break;
    }
    case 'waves':
    default:
      for (let i = 0; i < 6; i++) {
        const y = 30 + i * 11;
        const a = 6 + rnd() * 10;
        parts.push(`<path d="M-5 ${y} C 20 ${y - a}, 35 ${y + a}, 55 ${y} S 90 ${y - a}, 105 ${y} V 105 H -5 Z" fill="${[c1, c2, c3][i % 3]}" opacity="${0.35 + i * 0.1}"/>`);
      }
      break;
  }
  parts.push(`<rect width="100" height="100" filter="url(#${id}n)"/>`);
  return `<svg class="cover-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><defs>${defs.join('')}</defs>${parts.join('')}</svg>`;
}

/* ---------------- Color ---------------- */

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3) * 255, hue2rgb(p, q, h) * 255, hue2rgb(p, q, h - 1 / 3) * 255];
}

export function shade(hex, amt) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, l + amt))]));
}

function luminance([r, g, b]) {
  const f = (v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrastRatio(hexA, hexB) {
  const a = luminance(hexToRgb(hexA));
  const b = luminance(hexToRgb(hexB));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Color Thievery: toma el color dominante y lo ajusta para que sea «sutil y legible»:
 * satura como máximo 0.72 y sube luminosidad hasta lograr contraste AA (≥ 4.5:1)
 * sobre el fondo base, manteniendo texto oscuro legible sobre el acento.
 */
export function accentFrom(dominantHex, bgHex = '#0d0c0b') {
  let [h, s, l] = rgbToHsl(hexToRgb(dominantHex));
  s = Math.min(s, 0.72);
  l = Math.max(l, 0.5);
  let hex = rgbToHex(hslToRgb([h, s, l]));
  while (contrastRatio(hex, bgHex) < 4.5 && l < 0.9) {
    l += 0.02;
    hex = rgbToHex(hslToRgb([h, s, l]));
  }
  return hex;
}

export function applyAccent(el, dominantHex) {
  const acc = accentFrom(dominantHex);
  const [r, g, b] = hexToRgb(acc);
  el.style.setProperty('--accent', acc);
  el.style.setProperty('--accent-rgb', `${r}, ${g}, ${b}`);
  el.style.setProperty('--hero-tint', dominantHex);
  return acc;
}

/** Color de avatar determinista para artistas (iniciales sobre color generado). */
export function avatarColor(name) {
  const h = (hashString(name) % 360) / 360;
  return rgbToHex(hslToRgb([h, 0.38, 0.34]));
}

export function initials(name) {
  const words = name.replace(/^(the|los|las|el|la)\s+/i, '').split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase();
}

/** Picos pseudo-aleatorios para la forma de onda de la maqueta. */
export function mockPeaks(seedStr, count = 160) {
  const rnd = mulberry32(hashString(seedStr));
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const env = 0.35 + 0.45 * Math.sin(Math.PI * t) + (t > 0.55 && t < 0.72 ? 0.2 : 0) - (t > 0.4 && t < 0.45 ? 0.3 : 0);
    out.push(Math.max(0.08, Math.min(1, env * (0.65 + rnd() * 0.5))));
  }
  return out;
}
