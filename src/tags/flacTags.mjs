import fs from 'node:fs';
import { parseLrc, formatLrc } from './lrc.mjs';

function parseGainDb(raw) {
  if (raw === undefined || raw === null) return null;
  const m = String(raw).trim().match(/^([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function parseR128Q78Db(raw) {
  if (raw === undefined || raw === null) return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  // R128_*_GAIN is Q7.8 fixed-point relative to -23 LUFS; ReplayGain 2.0 reference is -18 LUFS (+5 dB)
  return n / 256.0 + 5.0;
}

function parsePeakVal(raw) {
  if (raw === undefined || raw === null) return null;
  const v = Number(String(raw).trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

function parseVorbisCommentBlock(body) {
  const fields = new Map();
  if (!body || body.length < 8) return { vendor: 'OurMusic 2.0', fields };

  let pos = 0;
  const vendorLen = body.readUInt32LE(pos);
  pos += 4;
  if (pos + vendorLen + 4 > body.length) return { vendor: 'OurMusic 2.0', fields };
  const vendor = body.subarray(pos, pos + vendorLen).toString('utf8');
  pos += vendorLen;

  const count = body.readUInt32LE(pos);
  pos += 4;

  for (let i = 0; i < count && pos + 4 <= body.length; i++) {
    const len = body.readUInt32LE(pos);
    pos += 4;
    if (pos + len > body.length) break;
    const raw = body.subarray(pos, pos + len).toString('utf8');
    pos += len;
    const eq = raw.indexOf('=');
    if (eq > 0) {
      const key = raw.slice(0, eq).toUpperCase();
      const val = raw.slice(eq + 1);
      fields.set(key, val);
    }
  }
  return { vendor, fields };
}

function buildVorbisCommentBlock(vendor, entries) {
  const vendorBytes = Buffer.from(vendor || 'OurMusic Clean-Room Tag Engine 2.0', 'utf8');
  const encodedComments = [];

  for (const [key, val] of entries) {
    const strVal = String(val ?? '').trim();
    if (!strVal) continue;
    const lineBytes = Buffer.from(`${key}=${strVal}`, 'utf8');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(lineBytes.length, 0);
    encodedComments.push(lenBuf, lineBytes);
  }

  const hdr = Buffer.alloc(4 + vendorBytes.length + 4);
  hdr.writeUInt32LE(vendorBytes.length, 0);
  vendorBytes.copy(hdr, 4);
  hdr.writeUInt32LE(encodedComments.length / 2, 4 + vendorBytes.length);

  return Buffer.concat([hdr, ...encodedComments]);
}

function parsePictureBlock(body) {
  if (!body || body.length < 32) return null;
  let pos = 0;
  pos += 4; // picture type
  const mimeLen = body.readUInt32BE(pos);
  pos += 4;
  if (pos + mimeLen + 4 > body.length) return null;
  const mime = body.subarray(pos, pos + mimeLen).toString('ascii') || 'image/jpeg';
  pos += mimeLen;

  const descLen = body.readUInt32BE(pos);
  pos += 4;
  if (pos + descLen + 20 > body.length) return null;
  pos += descLen;
  pos += 16; // width, height, depth, indexed colors

  const dataLen = body.readUInt32BE(pos);
  pos += 4;
  if (pos + dataLen > body.length || dataLen === 0) return null;
  return {
    mime,
    data: Buffer.from(body.subarray(pos, pos + dataLen)),
  };
}

function buildPictureBlock(coverArt) {
  const mimeBytes = Buffer.from(String(coverArt.mime || 'image/jpeg'), 'ascii');
  const data = coverArt.data;
  const buf = Buffer.alloc(4 + 4 + mimeBytes.length + 4 + 16 + 4 + data.length);
  let pos = 0;
  buf.writeUInt32BE(3, pos); // 3 = Cover (front)
  pos += 4;
  buf.writeUInt32BE(mimeBytes.length, pos);
  pos += 4;
  mimeBytes.copy(buf, pos);
  pos += mimeBytes.length;
  buf.writeUInt32BE(0, pos); // desc length = 0
  pos += 4;
  pos += 16;
  buf.writeUInt32BE(data.length, pos);
  pos += 4;
  data.copy(buf, pos);
  return buf;
}

/**
 * Header-only O(metadata) FLAC tag reader: reads only VorbisComment and Picture metadata blocks,
 * never loading compressed FLAC audio frames into memory.
 */
export function readFlacTags(filePath, { includeCoverArt = true } = {}) {
  const tags = {
    tagFormat: 'VorbisComment (FLAC)',
    title: '',
    artist: '',
    album: '',
    year: '',
    composer: '',
    genre: '',
    trackNumber: '',
    lyrics: '',
    syncedLyrics: [],
    coverArt: null,
    replayGainTrackDb: null,
    replayGainTrackPeak: null,
    replayGainAlbumDb: null,
    replayGainAlbumPeak: null,
  };

  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 8) return tags;

    const magic = Buffer.allocUnsafe(4);
    if (fs.readSync(fd, magic, 0, 4, 0) !== 4 || magic.toString('ascii', 0, 4) !== 'fLaC') {
      return tags;
    }

    let pos = 4;
    let isLast = false;
    const bhdr = Buffer.allocUnsafe(4);

    while (!isLast && pos + 4 <= fileSize) {
      if (fs.readSync(fd, bhdr, 0, 4, pos) !== 4) break;
      const hdr = bhdr[0];
      isLast = (hdr & 0x80) !== 0;
      const blockType = hdr & 0x7f;
      const blockLen = (bhdr[1] << 16) | (bhdr[2] << 8) | bhdr[3];
      pos += 4;
      if (pos + blockLen > fileSize) break;

      if (blockType === 4) {
        const body = Buffer.allocUnsafe(blockLen);
        if (fs.readSync(fd, body, 0, blockLen, pos) === blockLen) {
          const { fields } = parseVorbisCommentBlock(body);
          tags.title = fields.get('TITLE') || '';
          tags.artist = fields.get('ARTIST') || '';
          tags.album = fields.get('ALBUM') || '';
          tags.year = fields.get('DATE') || fields.get('YEAR') || '';
          tags.composer = fields.get('COMPOSER') || '';
          tags.genre = fields.get('GENRE') || '';
          tags.trackNumber = fields.get('TRACKNUMBER') || '';
          const lyr = fields.get('LYRICS') || fields.get('UNSYNCEDLYRICS') || '';
          tags.lyrics = lyr;
          tags.syncedLyrics = parseLrc(lyr);

          tags.replayGainTrackDb =
            parseGainDb(fields.get('REPLAYGAIN_TRACK_GAIN')) ??
            parseR128Q78Db(fields.get('R128_TRACK_GAIN'));
          tags.replayGainTrackPeak = parsePeakVal(fields.get('REPLAYGAIN_TRACK_PEAK'));
          tags.replayGainAlbumDb =
            parseGainDb(fields.get('REPLAYGAIN_ALBUM_GAIN')) ??
            parseR128Q78Db(fields.get('R128_ALBUM_GAIN'));
          tags.replayGainAlbumPeak = parsePeakVal(fields.get('REPLAYGAIN_ALBUM_PEAK'));
        }
      } else if (blockType === 6 && includeCoverArt && !tags.coverArt && blockLen > 0) {
        const body = Buffer.allocUnsafe(blockLen);
        if (fs.readSync(fd, body, 0, blockLen, pos) === blockLen) {
          tags.coverArt = parsePictureBlock(body);
        }
      }

      pos += blockLen;
    }
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }

  return tags;
}

export function writeFlacTags(filePath, mergedMeta) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 8 || buf.toString('ascii', 0, 4) !== 'fLaC') {
    throw new Error('Archivo FLAC inválido: falta cabecera fLaC');
  }

  const keptBlocks = [];
  let existingVendor = 'OurMusic Clean-Room Tag Engine 2.0';
  const extraFields = new Map();

  let pos = 4;
  let isLast = false;
  while (!isLast && pos + 4 <= buf.length) {
    const hdr = buf[pos];
    isLast = (hdr & 0x80) !== 0;
    const blockType = hdr & 0x7f;
    const blockLen = (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3];
    pos += 4;
    if (pos + blockLen > buf.length) {
      throw new Error('Bloque de metadatos FLAC truncado');
    }
    const body = buf.subarray(pos, pos + blockLen);
    pos += blockLen;

    if (blockType === 4) {
      const parsed = parseVorbisCommentBlock(body);
      if (parsed.vendor) existingVendor = parsed.vendor;
      for (const [k, v] of parsed.fields) {
        if (
          ![
            'TITLE',
            'ARTIST',
            'ALBUM',
            'DATE',
            'YEAR',
            'COMPOSER',
            'GENRE',
            'TRACKNUMBER',
            'LYRICS',
            'UNSYNCEDLYRICS',
          ].includes(k)
        ) {
          extraFields.set(k, v);
        }
      }
    } else if (blockType === 6 || blockType === 1) {
      // Drop old PICTURE and PADDING blocks; we emit fresh VORBIS_COMMENT + PICTURE
    } else {
      keptBlocks.push({ type: blockType, body });
    }
  }

  if (Number.isFinite(mergedMeta.replayGainTrackDb)) {
    extraFields.set('REPLAYGAIN_TRACK_GAIN', `${mergedMeta.replayGainTrackDb.toFixed(2)} dB`);
  }
  if (Number.isFinite(mergedMeta.replayGainTrackPeak)) {
    extraFields.set('REPLAYGAIN_TRACK_PEAK', mergedMeta.replayGainTrackPeak.toFixed(6));
  }
  if (Number.isFinite(mergedMeta.replayGainAlbumDb)) {
    extraFields.set('REPLAYGAIN_ALBUM_GAIN', `${mergedMeta.replayGainAlbumDb.toFixed(2)} dB`);
  }
  if (Number.isFinite(mergedMeta.replayGainAlbumPeak)) {
    extraFields.set('REPLAYGAIN_ALBUM_PEAK', mergedMeta.replayGainAlbumPeak.toFixed(6));
  }

  const audioFrames = buf.subarray(pos);

  let lyricsStr = typeof mergedMeta.lyrics === 'string' ? mergedMeta.lyrics : '';
  if (!lyricsStr && Array.isArray(mergedMeta.syncedLyrics) && mergedMeta.syncedLyrics.length > 0) {
    lyricsStr = formatLrc(mergedMeta.syncedLyrics);
  }

  const commentEntries = [
    ['TITLE', mergedMeta.title],
    ['ARTIST', mergedMeta.artist],
    ['ALBUM', mergedMeta.album],
    ['DATE', mergedMeta.year],
    ['COMPOSER', mergedMeta.composer],
    ['GENRE', mergedMeta.genre],
    ['TRACKNUMBER', mergedMeta.trackNumber],
    ['LYRICS', lyricsStr],
    ...extraFields.entries(),
  ];

  const vcBody = buildVorbisCommentBlock(existingVendor, commentEntries);
  keptBlocks.push({ type: 4, body: vcBody });

  if (mergedMeta.coverArt && Buffer.isBuffer(mergedMeta.coverArt.data) && mergedMeta.coverArt.data.length > 0) {
    const picBody = buildPictureBlock(mergedMeta.coverArt);
    if (picBody.length <= 0xffffff) {
      keptBlocks.push({ type: 6, body: picBody });
    }
  }

  const outParts = [Buffer.from('fLaC', 'ascii')];
  for (let i = 0; i < keptBlocks.length; i++) {
    const blk = keptBlocks[i];
    const lastBit = i === keptBlocks.length - 1 ? 0x80 : 0x00;
    const bhdr = Buffer.alloc(4);
    bhdr[0] = lastBit | (blk.type & 0x7f);
    bhdr[1] = (blk.body.length >>> 16) & 0xff;
    bhdr[2] = (blk.body.length >>> 8) & 0xff;
    bhdr[3] = blk.body.length & 0xff;
    outParts.push(bhdr, blk.body);
  }
  outParts.push(audioFrames);

  fs.writeFileSync(filePath, Buffer.concat(outParts));
}
