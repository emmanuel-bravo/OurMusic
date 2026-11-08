/*
 * OurMusic — Set de iconos propio (clean-room).
 * Rejilla 24×24, trazo 1.75 px, extremos y uniones redondeados.
 * Cada entrada es el contenido interno de un <svg viewBox="0 0 24 24">.
 * Los iconos con relleno usan la clase "f" (fill: currentColor; stroke: none).
 */
export const ICONS = {
  // Transporte
  play: '<path class="f" d="M8 5.2v13.6a1 1 0 0 0 1.5.86l11-6.8a1 1 0 0 0 0-1.72l-11-6.8A1 1 0 0 0 8 5.2z"/>',
  pause: '<rect class="f" x="6.5" y="5" width="4" height="14" rx="1.2"/><rect class="f" x="13.5" y="5" width="4" height="14" rx="1.2"/>',
  prev: '<path class="f" d="M18 6.2v11.6a.9.9 0 0 1-1.4.75L8.4 12.75a.9.9 0 0 1 0-1.5l8.2-5.8A.9.9 0 0 1 18 6.2z"/><path d="M6 5.5v13"/>',
  next: '<path class="f" d="M6 6.2v11.6a.9.9 0 0 0 1.4.75l8.2-5.8a.9.9 0 0 0 0-1.5L7.4 5.45A.9.9 0 0 0 6 6.2z"/><path d="M18 5.5v13"/>',
  shuffle: '<path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 4.8C14.3 16 15.5 17 17.5 17H21"/><path d="M3 17h3.5c1.5 0 2.5-.6 3.4-1.6"/><path d="M14.1 8.6c.9-1 1.9-1.6 3.4-1.6H21"/><path d="M18.5 4.5 21 7l-2.5 2.5"/><path d="M18.5 14.5 21 17l-2.5 2.5"/>',
  repeat: '<path d="M4 11V9.5A3.5 3.5 0 0 1 7.5 6H19"/><path d="m16 3 3 3-3 3"/><path d="M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H5"/><path d="m8 21-3-3 3-3"/>',
  volume: '<path class="f" d="M4 9.5h3l4.6-3.8a.8.8 0 0 1 1.4.6v11.4a.8.8 0 0 1-1.4.6L7 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1z"/><path d="M16 9a4.2 4.2 0 0 1 0 6"/><path d="M18.6 6.4a8 8 0 0 1 0 11.2"/>',

  // Paneles
  queue: '<path d="M4 6h11"/><path d="M4 11h11"/><path d="M4 16h6"/><path class="f" d="M14 14.6v5.3a.6.6 0 0 0 .9.5l4.4-2.65a.6.6 0 0 0 0-1.03l-4.4-2.66a.6.6 0 0 0-.9.54z"/>',
  lyrics: '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.2 3.2c-.4.3-.8 0-.8-.4V17a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8 9.5h8"/><path d="M8 13h5"/>',
  dsp: '<path d="M6 4v5"/><path d="M6 13v7"/><circle cx="6" cy="11" r="2"/><path d="M12 4v9"/><path d="M12 17v3"/><circle cx="12" cy="15" r="2"/><path d="M18 4v2"/><path d="M18 10v10"/><circle cx="18" cy="8" r="2"/>',
  expand: '<path d="M14 4h6v6"/><path d="M20 4l-6.5 6.5"/><path d="M10 20H4v-6"/><path d="M4 20l6.5-6.5"/>',

  // Navegación de biblioteca
  note: '<path d="M9 18V6.2a1 1 0 0 1 .8-1l8-1.6a1 1 0 0 1 1.2 1V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/><path d="M9 9.5l10-2"/>',
  disc: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 6.2a5.8 5.8 0 0 1 5.8 5.8"/>',
  artist: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c.8-3.6 3.8-5.8 7.5-5.8s6.7 2.2 7.5 5.8"/>',
  genre: '<path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2a1.5 1.5 0 0 1 1.06.44l7.3 7.3a1.5 1.5 0 0 1 0 2.12l-7.2 7.2a1.5 1.5 0 0 1-2.12 0l-7.3-7.3a1.5 1.5 0 0 1-.44-1.06z"/><circle cx="8.2" cy="8.2" r="1.4"/>',
  composer: '<path d="M4 20l3.5-1 10.8-10.8a2 2 0 0 0 0-2.8l-.7-.7a2 2 0 0 0-2.8 0L4 15.5 4 20z"/><path d="M13.5 6.2l4.3 4.3"/><path d="M14 20h6"/>',
  folder: '<path d="M3.5 7.5V17a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-6.3L10.5 5.2a1.5 1.5 0 0 0-1.2-.7H5.5a2 2 0 0 0-2 2z"/>',
  smart: '<path d="M12 3.5l1.7 4.6 4.8.2-3.8 3 1.3 4.7-4-2.7-4 2.7 1.3-4.7-3.8-3 4.8-.2z"/><path d="M19 15.5l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6z"/>',
  playlist: '<path d="M4 6.5h12"/><path d="M4 11.5h12"/><path d="M4 16.5h7"/><path d="M17.5 19V12.5l3-1"/><circle cx="16" cy="19" r="1.6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/><circle cx="12" cy="12" r="6.6"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path d="m6.5 10.5-1.4 1.5 1.4 1.5"/>',
  eye: '<path d="M2.8 12S6 5.8 12 5.8 21.2 12 21.2 12 18 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',

  // Utilidades
  search: '<circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 4.5 4.5"/>',
  chevronLeft: '<path d="m14.5 5.5-6.5 6.5 6.5 6.5"/>',
  chevronRight: '<path d="m9.5 5.5 6.5 6.5-6.5 6.5"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  more: '<circle class="f" cx="5.5" cy="12" r="1.6"/><circle class="f" cx="12" cy="12" r="1.6"/><circle class="f" cx="18.5" cy="12" r="1.6"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10-7.5 10z"/>',
  heartFill: '<path class="f" d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10-7.5 10z"/>',
  grid: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  listView: '<path d="M9 6.5h11"/><path d="M9 12h11"/><path d="M9 17.5h11"/><circle class="f" cx="5" cy="6.5" r="1.2"/><circle class="f" cx="5" cy="12" r="1.2"/><circle class="f" cx="5" cy="17.5" r="1.2"/>',
  sort: '<path d="M7 4.5v15"/><path d="m4 16.5 3 3 3-3"/><path d="M17 19.5v-15"/><path d="m14 7.5 3-3 3 3"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  close: '<path d="m6 6 12 12"/><path d="M18 6 6 18"/>',
  addQueue: '<path d="M4 6.5h11"/><path d="M4 11.5h11"/><path d="M4 16.5h6"/><path d="M17.5 13.5v7"/><path d="M14 17h7"/>',
  playNext: '<path class="f" d="M4 5.6v6.8a.6.6 0 0 0 .9.5l5.4-3.4a.6.6 0 0 0 0-1L4.9 5.1a.6.6 0 0 0-.9.5z"/><path d="M13 7.5h7"/><path d="M4 16.5h16"/><path d="M13 12h7"/>',
  bars: '<path d="M5 19v-6"/><path d="M9.7 19V6"/><path d="M14.3 19v-9"/><path d="M19 19v-4"/>',

  // Ruta de señal
  file: '<path d="M6.5 3.5h7l5 5v11a1.5 1.5 0 0 1-1.5 1.5h-10.5A1.5 1.5 0 0 1 5 19.5v-14.5a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M13.5 3.5v5h5"/><path d="M8.5 14.5h7"/><path d="M8.5 17.5h4.5"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
  resample: '<path d="M3 12c1.6-4 3.2-4 4.8 0s3.2 4 4.8 0 3.2-4 4.8 0 2.4 4 3.6 1.5"/>',
  output: '<rect x="5.5" y="3" width="13" height="18" rx="2.5"/><circle cx="12" cy="14.5" r="3.4"/><circle class="f" cx="12" cy="7.5" r="1.3"/>',
  wave: '<path d="M3 12h1.5M6 9v6M9 6v12M12 9.5v5M15 4.5v15M18 8v8M21 12h-1"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><circle class="f" cx="12" cy="7.8" r="1.1"/>',
  bolt: '<path d="M13.5 3 5.5 13.5H12L10.5 21l8-10.5H12z"/>',
  grip: '<circle class="f" cx="9" cy="6.5" r="1.2"/><circle class="f" cx="15" cy="6.5" r="1.2"/><circle class="f" cx="9" cy="12" r="1.2"/><circle class="f" cx="15" cy="12" r="1.2"/><circle class="f" cx="9" cy="17.5" r="1.2"/><circle class="f" cx="15" cy="17.5" r="1.2"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2"/><path d="M6.5 7l.8 11.5a2 2 0 0 0 2 1.8h5.4a2 2 0 0 0 2-1.8L17.5 7"/><path d="M10 11v5M14 11v5"/>',
  columns: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/><path d="M15 4.5v15"/>',
  headphones: '<path d="M4 13v-1a8 8 0 0 1 16 0v1"/><rect x="3" y="13" width="4" height="6" rx="1.5"/><rect x="17" y="13" width="4" height="6" rx="1.5"/>',
};

export function icon(name, { size = 20, cls = '' } = {}) {
  const body = ICONS[name] || ICONS.info;
  return `<svg class="ic ${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
}
