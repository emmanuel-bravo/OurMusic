/*
 * OurMusic — Datos ficticios para los bocetos (Rondas 1 y 2).
 */
export const ALBUMS = [
  { title: 'Nocturnes for Glass', artist: 'Lumen Atlas', year: 2019, genre: 'Jazz', codec: 'FLAC', bits: 24, rate: 192, tracks: 9, palette: ['#1d2a44', '#e8a25c', '#5b7fb8', '#f3d8a7'], style: 'horizon' },
  { title: 'Marea Baja', artist: 'Coral Vázquez', year: 2021, genre: 'Bolero', codec: 'FLAC', bits: 16, rate: 44.1, tracks: 11, palette: ['#0f3b3f', '#e46f55', '#7ec4b8', '#f2e2c4'], style: 'waves' },
  { title: 'Northern Static', artist: 'The Quiet Engines', year: 2017, genre: 'Post-rock', codec: 'FLAC', bits: 24, rate: 48, tracks: 7, palette: ['#2a2f36', '#9fb3c8', '#e8eef2', '#5f6f80'], style: 'stripes' },
  { title: 'Cuarteto del Alba', artist: 'Ensemble Aurora', year: 2015, genre: 'Clásica', codec: 'DSD', bits: 1, rate: 5644.8, dsd: 'DSD128', tracks: 12, palette: ['#3a1f2b', '#e7b6a1', '#b8546b', '#f6e7da'], style: 'rings' },
  { title: 'Saltwater Hymns', artist: 'Mira Okafor', year: 2022, genre: 'Soul', codec: 'ALAC', bits: 24, rate: 48, tracks: 10, palette: ['#14324a', '#f0b13c', '#2f86a6', '#f7e3b0'], style: 'orbs' },
  { title: 'Ciudad de Neón', artist: 'Los Satélites', year: 2020, genre: 'Synthpop', codec: 'MP3', bits: 0, rate: 44.1, kbps: 320, tracks: 12, palette: ['#1a1033', '#ff4fa3', '#45d6ff', '#ffe36e'], style: 'bauhaus' },
  { title: 'Field Recordings Vol. 2', artist: 'Henrik Lund', year: 2018, genre: 'Ambient', codec: 'WAV', bits: 24, rate: 192, tracks: 6, palette: ['#22302a', '#9cc59a', '#d9e6c9', '#4d7a5c'], style: 'waves' },
  { title: 'Desierto Rojo', artist: 'Sol de Arena', year: 2016, genre: 'Rock', codec: 'FLAC', bits: 16, rate: 44.1, tracks: 10, palette: ['#4a1c12', '#f08a3c', '#ffd27a', '#a33a22'], style: 'horizon' },
  { title: 'Paper Lanterns', artist: 'Yuki Tanabe Trio', year: 2023, genre: 'Jazz', codec: 'FLAC', bits: 24, rate: 96, tracks: 8, palette: ['#2b1d16', '#f2c46d', '#d0643c', '#f7ead1'], style: 'orbs' },
  { title: 'Sinfonía n.º 3 «Volcánica»', artist: 'Filarmónica de Valle Alto', year: 2012, genre: 'Clásica', codec: 'DSD', bits: 1, rate: 2822.4, dsd: 'DSD64', tracks: 4, palette: ['#1b1b1f', '#d9472f', '#f2a541', '#e9e2d0'], style: 'bauhaus' },
  { title: 'Low Orbit', artist: 'Kestrel', year: 2024, genre: 'Electrónica', codec: 'FLAC', bits: 24, rate: 44.1, tracks: 9, palette: ['#0c1a2b', '#6a8dff', '#b6f0ff', '#2c3f8f'], style: 'rings' },
  { title: 'Raíces', artist: 'María Itzel', year: 2019, genre: 'Folk', codec: 'ALAC', bits: 16, rate: 44.1, tracks: 13, palette: ['#2f2416', '#c9a86a', '#7a9a5b', '#efe2c2'], style: 'stripes' },
  { title: 'Velvet Machinery', artist: 'Duo Carmine', year: 2014, genre: 'Funk', codec: 'FLAC', bits: 24, rate: 96, tracks: 10, palette: ['#3a0f1e', '#ff6b6b', '#ffc15e', '#7a1f3d'], style: 'stripes' },
  { title: 'Horizonte Lento', artist: 'Ana Belmonte', year: 2021, genre: 'Piano', codec: 'DSD', bits: 1, rate: 11289.6, dsd: 'DSD256', tracks: 8, palette: ['#1f2433', '#c7cbe0', '#8d93b8', '#f1efe8'], style: 'horizon' },
  { title: 'Glass Harbor', artist: 'Lumen Atlas', year: 2016, genre: 'Jazz', codec: 'FLAC', bits: 24, rate: 96, tracks: 8, palette: ['#14262b', '#58b6b0', '#e0c27a', '#cfe9e4'], style: 'waves' },
  { title: 'Electric Solstice', artist: 'Nova Parade', year: 2018, genre: 'Indie', codec: 'MP3', bits: 0, rate: 44.1, kbps: 245, tracks: 11, palette: ['#251433', '#b58cff', '#ff9e6d', '#f5e1ff'], style: 'orbs' },
  { title: 'Cantos de Agua', artist: 'Coro Ixchel', year: 2010, genre: 'Coral', codec: 'FLAC', bits: 24, rate: 88.2, tracks: 14, palette: ['#102a33', '#6fc3d8', '#f4f1e6', '#2b6f84'], style: 'rings' },
  { title: 'Midnight Ledger', artist: 'Silas Grey', year: 2013, genre: 'Blues', codec: 'FLAC', bits: 16, rate: 44.1, tracks: 10, palette: ['#191714', '#c98b4a', '#6e5a43', '#ead7b8'], style: 'bauhaus' },
];

export const NOW_PLAYING = {
  album: ALBUMS[0],
  title: 'Tidal Lamps',
  artist: 'Lumen Atlas',
  trackNo: 3,
  elapsed: '3:12',
  duration: '7:41',
  progress: 0.416,
  kbps: 4812,
  sizeMb: 247.6,
  output: 'WASAPI Exclusivo',
  device: 'DAC USB «Escritorio»',
  bitPerfect: true,
};

export const ALBUM_TRACKS = [
  { n: 1, title: 'Harbor Lights', dur: '5:12' },
  { n: 2, title: 'Blue Hour Waltz', dur: '6:03' },
  { n: 3, title: 'Tidal Lamps', dur: '7:41', playing: true, lyrics: true },
  { n: 4, title: 'Fog Signals', dur: '4:58', lyrics: true },
  { n: 5, title: 'Lantern Keeper', dur: '6:27' },
  { n: 6, title: 'Quiet Arithmetic', dur: '5:35' },
  { n: 7, title: 'Salt & Silver', dur: '4:12', liked: true },
  { n: 8, title: 'Nocturne in Grey', dur: '8:04' },
  { n: 9, title: 'Last Ferry Home', dur: '6:19' },
];

export const ALL_TRACKS = [
  { idx: 1, title: 'Tidal Lamps', artist: 'Lumen Atlas', album: ALBUMS[0], year: 2019, genre: 'Jazz', composer: 'E. Lindqvist', dur: '7:41', lufs: '-14.1', kbps: '4,812', playing: true, lyrics: true },
  { idx: 2, title: 'Salitre y Sombra', artist: 'Coral Vázquez', album: ALBUMS[1], year: 2021, genre: 'Bolero', composer: 'C. Vázquez', dur: '4:18', lufs: '-12.8', kbps: '892', lyrics: true },
  { idx: 3, title: 'Adagio en Re menor', artist: 'Ensemble Aurora', album: ALBUMS[3], year: 2015, genre: 'Clásica', composer: 'J. S. Bach', dur: '9:04', lufs: '-18.4', kbps: '11,289' },
  { idx: 4, title: 'Substation 9', artist: 'The Quiet Engines', album: ALBUMS[2], year: 2017, genre: 'Post-rock', composer: 'M. Hale', dur: '6:52', lufs: '-13.5', kbps: '1,640' },
  { idx: 5, title: 'Amber Tide', artist: 'Mira Okafor', album: ALBUMS[4], year: 2022, genre: 'Soul', composer: 'M. Okafor', dur: '3:56', lufs: '-11.9', kbps: '1,580', lyrics: true },
  { idx: 6, title: 'Avenida Cobalto', artist: 'Los Satélites', album: ALBUMS[5], year: 2020, genre: 'Synthpop', composer: 'R. Ortega', dur: '4:05', lufs: '-9.8', kbps: '320' },
  { idx: 7, title: 'Glacier Melt (Take 3)', artist: 'Henrik Lund', album: ALBUMS[6], year: 2018, genre: 'Ambient', composer: 'H. Lund', dur: '11:20', lufs: '-20.2', kbps: '9,216' },
  { idx: 8, title: 'Koto at Dusk', artist: 'Yuki Tanabe Trio', album: ALBUMS[8], year: 2023, genre: 'Jazz', composer: 'Y. Tanabe', dur: '5:47', lufs: '-15.0', kbps: '2,890', lyrics: true },
  { idx: 9, title: 'Preludio de Invierno', artist: 'Ana Belmonte', album: ALBUMS[13], year: 2021, genre: 'Piano', composer: 'A. Belmonte', dur: '6:14', lufs: '-17.6', kbps: '22,579' },
  { idx: 10, title: 'Mirage Highway', artist: 'Sol de Arena', album: ALBUMS[7], year: 2016, genre: 'Rock', composer: 'D. Mendoza', dur: '4:39', lufs: '-10.4', kbps: '965' },
  { idx: 11, title: 'Perigee', artist: 'Kestrel', album: ALBUMS[10], year: 2024, genre: 'Electrónica', composer: 'S. Novak', dur: '5:11', lufs: '-11.2', kbps: '1,420' },
  { idx: 12, title: 'Tierra de Maíz', artist: 'María Itzel', album: ALBUMS[11], year: 2019, genre: 'Folk', composer: 'M. Itzel', dur: '3:48', lufs: '-13.1', kbps: '845', lyrics: true },
];

export const QUEUE_UP_NEXT = [
  { title: 'Koto at Dusk', artist: 'Yuki Tanabe Trio', album: ALBUMS[8], dur: '5:47', badge: '24/96', source: 'Añadida manualmente' },
  { title: 'Salitre y Sombra', artist: 'Coral Vázquez', album: ALBUMS[1], dur: '4:18', badge: '16/44.1', source: 'Reproducir a continuación' },
];

export const QUEUE_CONTEXT = [
  { title: 'Fog Signals', artist: 'Lumen Atlas', album: ALBUMS[0], dur: '4:58', badge: '24/192' },
  { title: 'Lantern Keeper', artist: 'Lumen Atlas', album: ALBUMS[0], dur: '6:27', badge: '24/192' },
  { title: 'Quiet Arithmetic', artist: 'Lumen Atlas', album: ALBUMS[0], dur: '5:35', badge: '24/192' },
  { title: 'Salt & Silver', artist: 'Lumen Atlas', album: ALBUMS[0], dur: '4:12', badge: '24/192' },
  { title: 'Nocturne in Grey', artist: 'Lumen Atlas', album: ALBUMS[0], dur: '8:04', badge: '24/192' },
];

export const EQ_10_BANDS = [
  { freq: '31', gain: +2.5 },
  { freq: '62', gain: +3.2 },
  { freq: '125', gain: +1.5 },
  { freq: '250', gain: -0.8 },
  { freq: '500', gain: -1.4 },
  { freq: '1k', gain: +0.6 },
  { freq: '2k', gain: +1.8 },
  { freq: '4k', gain: +2.6 },
  { freq: '8k', gain: +2.1 },
  { freq: '16k', gain: +1.2 },
];

export const PEQ_NODES = [
  { idx: 1, type: 'Low-Shelf', freq: '65 Hz', gain: '+3.0 dB', q: '0.71', active: true },
  { idx: 2, type: 'Peaking', freq: '280 Hz', gain: '-1.8 dB', q: '1.80', active: true },
  { idx: 3, type: 'Notch', freq: '910 Hz', gain: '-6.0 dB', q: '8.50', active: true },
  { idx: 4, type: 'Peaking', freq: '3,400 Hz', gain: '+2.4 dB', q: '1.20', active: true },
  { idx: 5, type: 'High-Shelf', freq: '11,500 Hz', gain: '+1.8 dB', q: '0.71', active: true },
];

export const SYNCED_LYRICS = [
  { time: '02:48.10', text: 'El puerto duerme tras la niebla de cristal,', state: 'past' },
  { time: '02:56.40', text: 'las boyas marcan el compás del oleaje lento.', state: 'past' },
  { time: '03:04.20', text: 'Cada linterna suspendida sobre el muelle gris', state: 'past' },
  { time: '03:12.00', text: 'encendió su reflejo de ámbar en el agua.', state: 'active' },
  { time: '03:21.50', text: 'Escucha el pulso de la noche sin reloj,', state: 'next' },
  { time: '03:30.15', text: 'donde la sal conserva intacta la memoria', state: 'next' },
  { time: '03:39.80', text: 'y el último transbordador apaga sus motores.', state: 'next' },
  { time: '03:49.00', text: 'Bajo el faro de lumen pálido regresa la marea.', state: 'next' },
];

export const ARTISTS_LIST = [
  { name: 'Lumen Atlas', albums: 2, tracks: 17, badge: 'FLAC 24/192' },
  { name: 'Coral Vázquez', albums: 1, tracks: 11, badge: 'FLAC 16/44.1' },
  { name: 'Ensemble Aurora', albums: 3, tracks: 28, badge: 'DSD128' },
  { name: 'The Quiet Engines', albums: 2, tracks: 15, badge: 'FLAC 24/48' },
  { name: 'Mira Okafor', albums: 1, tracks: 10, badge: 'ALAC 24/48' },
  { name: 'Yuki Tanabe Trio', albums: 2, tracks: 16, badge: 'FLAC 24/96' },
  { name: 'Ana Belmonte', albums: 2, tracks: 19, badge: 'DSD256' },
  { name: 'Henrik Lund', albums: 1, tracks: 6, badge: 'WAV 24/192' },
  { name: 'Los Satélites', albums: 2, tracks: 22, badge: 'MP3 320' },
  { name: 'María Itzel', albums: 1, tracks: 13, badge: 'ALAC 16/44.1' },
  { name: 'Kestrel', albums: 1, tracks: 9, badge: 'FLAC 24/44.1' },
  { name: 'Duo Carmine', albums: 1, tracks: 10, badge: 'FLAC 24/96' },
];

export const GENRES_LIST = [
  { name: 'Jazz Contemporáneo', albums: 34, tracks: 312, color: '#c98542' },
  { name: 'Clásica y Cámara', albums: 29, tracks: 418, color: '#9c4158' },
  { name: 'Ambient / Paisaje Sonoro', albums: 18, tracks: 124, color: '#3f7662' },
  { name: 'Post-rock e Instrumental', albums: 21, tracks: 165, color: '#4c678a' },
  { name: 'Bolero y Raíz Acústica', albums: 15, tracks: 178, color: '#b5563f' },
  { name: 'Electrónica IDM', albums: 24, tracks: 230, color: '#4c5bb8' },
];

export const PLAYLISTS = ['Domingo lento', 'Para concentrarse', 'Vinilos digitalizados', 'Viaje nocturno'];
export const SMART_LISTS = ['Hi-Res y DSD', 'Letras sincronizadas', 'Colección sin pérdida'];

export function formatBadge(a) {
  if (a.codec === 'DSD') return { label: a.dsd, hires: true };
  if (a.codec === 'MP3') return { label: `MP3 ${a.kbps}`, hires: false };
  const hires = a.bits > 16 || a.rate > 48;
  return { label: `${a.bits}/${a.rate}`, hires };
}

export function formatLong(a) {
  if (a.codec === 'DSD') return `${a.dsd} · ${(a.rate / 1000).toFixed(4)} MHz`;
  if (a.codec === 'MP3') return `MP3 · ${a.kbps} kbps`;
  return `${a.codec} · ${a.bits}-bit/${a.rate} kHz`;
}
