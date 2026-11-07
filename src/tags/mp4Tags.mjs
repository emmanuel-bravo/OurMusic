import fs from 'node:fs';
import { parseLrc, formatLrc } from './lrc.mjs';

function makeBox(typeStr, payloadBuf) {
  const hdr = Buffer.alloc(8);
  hdr.writeUInt32BE(8 + payloadBuf.length, 0);
  hdr.write(typeStr, 4, 4, 'latin1');
  return Buffer.concat([hdr, payloadBuf]);
}

function parseGainDb(raw) {
  if (raw === undefined || raw === null) return null;
  const m = String(raw).trim().match(/^([+-]?\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

function parsePeakVal(raw) {
  if (raw === undefined || raw === null) return null;
  const v = Number(String(raw).trim());
  return Number.isFinite(v) && v > 0 ? v : null;
}

function listBoxes(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos + 8 <= end) {
    let sz = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdrLen = 8;
    if (sz === 1) {
      if (pos + 16 > end) break;
      sz = Number(buf.readBigUInt64BE(pos + 8));
      hdrLen = 16;
    } else if (sz === 0) {
      sz = end - pos;
    }
    if (sz < hdrLen || pos + sz > end) break;
    out.push({
      type,
      offset: pos,
      size: sz,
      hdrLen,
      bodyStart: pos + hdrLen,
      bodyEnd: pos + sz,
    });
    pos += sz;
  }
  return out;
}

function parseDataAtom(buf, bodyStart, bodyEnd) {
  const children = listBoxes(buf, bodyStart, bodyEnd);
  const dataBox = children.find((c) => c.type === 'data');
  if (!dataBox || dataBox.bodyStart + 8 > dataBox.bodyEnd) return null;
  const typeIndicator = buf.readUInt32BE(dataBox.bodyStart);
  const valBuf = buf.subarray(dataBox.bodyStart + 8, dataBox.bodyEnd);
  return { typeIndicator, valBuf, children };
}

function buildIlstTextItem(fourcc, value) {
  const str = String(value ?? '').trim();
  if (!str) return null;
  const utf8 = Buffer.from(str, 'utf8');
  const dataHdr = Buffer.alloc(8);
  dataHdr.writeUInt32BE(1, 0);
  dataHdr.writeUInt32BE(0, 4);
  const dataBox = makeBox('data', Buffer.concat([dataHdr, utf8]));
  return makeBox(fourcc, dataBox);
}

function buildIlstFreeformItem(name, value) {
  const str = String(value ?? '').trim();
  if (!str) return null;
  const meanBox = makeBox('mean', Buffer.concat([Buffer.alloc(4, 0), Buffer.from('com.apple.iTunes', 'ascii')]));
  const nameBox = makeBox('name', Buffer.concat([Buffer.alloc(4, 0), Buffer.from(name, 'utf8')]));
  const dataHdr = Buffer.alloc(8);
  dataHdr.writeUInt32BE(1, 0);
  dataHdr.writeUInt32BE(0, 4);
  const dataBox = makeBox('data', Buffer.concat([dataHdr, Buffer.from(str, 'utf8')]));
  return makeBox('----', Buffer.concat([meanBox, nameBox, dataBox]));
}

function buildIlstTrackItem(trackStr) {
  const s = String(trackStr ?? '').trim();
  if (!s) return null;
  const parts = s.split('/');
  const trk = parseInt(parts[0], 10) || 0;
  const tot = parts[1] ? parseInt(parts[1], 10) || 0 : 0;
  if (trk <= 0) return null;
  const payload = Buffer.alloc(16);
  payload.writeUInt32BE(0, 0);
  payload.writeUInt32BE(0, 4);
  payload.writeUInt16BE(0, 8);
  payload.writeUInt16BE(trk, 10);
  payload.writeUInt16BE(tot, 12);
  payload.writeUInt16BE(0, 14);
  return makeBox('trkn', makeBox('data', payload));
}

function buildIlstCoverItem(coverArt) {
  if (!coverArt || !Buffer.isBuffer(coverArt.data) || coverArt.data.length === 0) return null;
  const isPng = String(coverArt.mime || '').toLowerCase().includes('png');
  const dataHdr = Buffer.alloc(8);
  dataHdr.writeUInt32BE(isPng ? 14 : 13, 0);
  dataHdr.writeUInt32BE(0, 4);
  return makeBox('covr', makeBox('data', Buffer.concat([dataHdr, coverArt.data])));
}

function shiftMoovChunkOffsets(moovBuf, deltaBytes) {
  if (deltaBytes === 0) return;
  const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf']);

  function walk(start, end) {
    const boxes = listBoxes(moovBuf, start, end);
    for (const b of boxes) {
      if (CONTAINERS.has(b.type)) {
        walk(b.bodyStart, b.bodyEnd);
      } else if (b.type === 'stco' && b.bodyStart + 8 <= b.bodyEnd) {
        const count = moovBuf.readUInt32BE(b.bodyStart + 4);
        let p = b.bodyStart + 8;
        for (let i = 0; i < count && p + 4 <= b.bodyEnd; i++) {
          const oldOff = moovBuf.readUInt32BE(p);
          moovBuf.writeUInt32BE(oldOff + deltaBytes, p);
          p += 4;
        }
      } else if (b.type === 'co64' && b.bodyStart + 8 <= b.bodyEnd) {
        const count = moovBuf.readUInt32BE(b.bodyStart + 4);
        let p = b.bodyStart + 8;
        for (let i = 0; i < count && p + 8 <= b.bodyEnd; i++) {
          const oldOff = moovBuf.readBigUInt64BE(p);
          moovBuf.writeBigUInt64BE(oldOff + BigInt(deltaBytes), p);
          p += 8;
        }
      }
    }
  }

  walk(0, moovBuf.length);
}

/**
 * Atom-only O(moov) MP4/M4A tag reader: leaps over 'mdat' ALAC/AAC audio payloads
 * and reads exclusively the 'moov' atom.
 */
export function readMp4Tags(filePath, { includeCoverArt = true } = {}) {
  const tags = {
    tagFormat: 'MP4 ilst (M4A/ALAC)',
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

  let moovBuf = null;
  let moovHdrLen = 8;
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    let pos = 0;
    const hdr = Buffer.allocUnsafe(16);

    while (pos + 8 <= fileSize) {
      const got = fs.readSync(fd, hdr, 0, Math.min(16, fileSize - pos), pos);
      if (got < 8) break;
      let sz = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      let hdrLen = 8;
      if (sz === 1) {
        if (got < 16) break;
        sz = Number(hdr.readBigUInt64BE(8));
        hdrLen = 16;
      } else if (sz === 0) {
        sz = fileSize - pos;
      }
      if (sz < hdrLen || pos + sz > fileSize) break;
      if (type === 'moov') {
        moovBuf = Buffer.allocUnsafe(sz);
        if (fs.readSync(fd, moovBuf, 0, sz, pos) !== sz) moovBuf = null;
        moovHdrLen = hdrLen;
        break;
      }
      pos += sz;
    }
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }

  if (!moovBuf) return tags;

  const moovChildren = listBoxes(moovBuf, moovHdrLen, moovBuf.length);
  const udta = moovChildren.find((b) => b.type === 'udta');
  if (!udta) return tags;

  const udtaChildren = listBoxes(moovBuf, udta.bodyStart, udta.bodyEnd);
  const meta = udtaChildren.find((b) => b.type === 'meta');
  if (!meta || meta.bodyStart + 4 > meta.bodyEnd) return tags;

  const metaChildren = listBoxes(moovBuf, meta.bodyStart + 4, meta.bodyEnd);
  const ilst = metaChildren.find((b) => b.type === 'ilst');
  if (!ilst) return tags;

  const items = listBoxes(moovBuf, ilst.bodyStart, ilst.bodyEnd);
  for (const item of items) {
    const parsed = parseDataAtom(moovBuf, item.bodyStart, item.bodyEnd);
    if (!parsed) continue;
    const { typeIndicator, valBuf, children } = parsed;

    if (item.type === '\xa9nam') tags.title = valBuf.toString('utf8');
    else if (item.type === '\xa9ART') tags.artist = valBuf.toString('utf8');
    else if (item.type === '\xa9alb') tags.album = valBuf.toString('utf8');
    else if (item.type === '\xa9day') tags.year = valBuf.toString('utf8');
    else if (item.type === '\xa9wrt') tags.composer = valBuf.toString('utf8');
    else if (item.type === '\xa9gen') tags.genre = valBuf.toString('utf8');
    else if (item.type === '\xa9lyr') {
      const lyr = valBuf.toString('utf8');
      tags.lyrics = lyr;
      tags.syncedLyrics = parseLrc(lyr);
    } else if (item.type === 'trkn' && valBuf.length >= 4) {
      const trk = valBuf.readUInt16BE(2);
      const tot = valBuf.length >= 6 ? valBuf.readUInt16BE(4) : 0;
      if (trk > 0) tags.trackNumber = tot > 0 ? `${trk}/${tot}` : String(trk);
    } else if (item.type === 'covr' && includeCoverArt && valBuf.length > 0) {
      const mime = typeIndicator === 14 ? 'image/png' : 'image/jpeg';
      tags.coverArt = { mime, data: Buffer.from(valBuf) };
    } else if (item.type === '----') {
      const nameBox = children.find((c) => c.type === 'name');
      if (nameBox && nameBox.bodyStart + 4 <= nameBox.bodyEnd) {
        const key = moovBuf
          .subarray(nameBox.bodyStart + 4, nameBox.bodyEnd)
          .toString('utf8')
          .trim()
          .toUpperCase();
        const val = valBuf.toString('utf8').trim();
        if (key === 'REPLAYGAIN_TRACK_GAIN') tags.replayGainTrackDb = parseGainDb(val);
        else if (key === 'REPLAYGAIN_TRACK_PEAK') tags.replayGainTrackPeak = parsePeakVal(val);
        else if (key === 'REPLAYGAIN_ALBUM_GAIN') tags.replayGainAlbumDb = parseGainDb(val);
        else if (key === 'REPLAYGAIN_ALBUM_PEAK') tags.replayGainAlbumPeak = parsePeakVal(val);
      }
    }
  }

  return tags;
}

export function writeMp4Tags(filePath, mergedMeta) {
  const buf = fs.readFileSync(filePath);
  const top = listBoxes(buf, 0, buf.length);
  const moovIdx = top.findIndex((b) => b.type === 'moov');
  const mdatIdx = top.findIndex((b) => b.type === 'mdat');
  if (moovIdx < 0) {
    throw new Error('Contenedor MP4/M4A inválido: no contiene átomo moov');
  }

  const moov = top[moovIdx];
  const moovChildren = listBoxes(buf, moov.bodyStart, moov.bodyEnd);

  let lyricsStr = typeof mergedMeta.lyrics === 'string' ? mergedMeta.lyrics : '';
  if (!lyricsStr && Array.isArray(mergedMeta.syncedLyrics) && mergedMeta.syncedLyrics.length > 0) {
    lyricsStr = formatLrc(mergedMeta.syncedLyrics);
  }

  const ilstEntries = [
    buildIlstTextItem('\xa9nam', mergedMeta.title),
    buildIlstTextItem('\xa9ART', mergedMeta.artist),
    buildIlstTextItem('\xa9alb', mergedMeta.album),
    buildIlstTextItem('\xa9day', mergedMeta.year),
    buildIlstTextItem('\xa9wrt', mergedMeta.composer),
    buildIlstTextItem('\xa9gen', mergedMeta.genre),
    buildIlstTrackItem(mergedMeta.trackNumber),
    buildIlstTextItem('\xa9lyr', lyricsStr),
    buildIlstCoverItem(mergedMeta.coverArt),
    Number.isFinite(mergedMeta.replayGainTrackDb)
      ? buildIlstFreeformItem('replaygain_track_gain', `${mergedMeta.replayGainTrackDb.toFixed(2)} dB`)
      : null,
    Number.isFinite(mergedMeta.replayGainTrackPeak)
      ? buildIlstFreeformItem('replaygain_track_peak', mergedMeta.replayGainTrackPeak.toFixed(6))
      : null,
    Number.isFinite(mergedMeta.replayGainAlbumDb)
      ? buildIlstFreeformItem('replaygain_album_gain', `${mergedMeta.replayGainAlbumDb.toFixed(2)} dB`)
      : null,
    Number.isFinite(mergedMeta.replayGainAlbumPeak)
      ? buildIlstFreeformItem('replaygain_album_peak', mergedMeta.replayGainAlbumPeak.toFixed(6))
      : null,
  ].filter(Boolean);

  const ilstBox = makeBox('ilst', Buffer.concat(ilstEntries));

  const hdlrPayload = Buffer.alloc(25);
  hdlrPayload.write('mdir', 8, 4, 'ascii');
  hdlrPayload.write('appl', 12, 4, 'ascii');
  const hdlrBox = makeBox('hdlr', hdlrPayload);

  const metaVerFlags = Buffer.alloc(4, 0);
  const metaBox = makeBox('meta', Buffer.concat([metaVerFlags, hdlrBox, ilstBox]));

  const existingUdta = moovChildren.find((b) => b.type === 'udta');
  const keptUdtaParts = [];
  if (existingUdta) {
    for (const uc of listBoxes(buf, existingUdta.bodyStart, existingUdta.bodyEnd)) {
      if (uc.type !== 'meta') {
        keptUdtaParts.push(buf.subarray(uc.offset, uc.bodyEnd));
      }
    }
  }
  keptUdtaParts.push(metaBox);
  const udtaBox = makeBox('udta', Buffer.concat(keptUdtaParts));

  const newMoovParts = [];
  for (const mc of moovChildren) {
    if (mc.type !== 'udta' && mc.type !== 'free') {
      newMoovParts.push(buf.subarray(mc.offset, mc.bodyEnd));
    }
  }
  newMoovParts.push(udtaBox);

  const newMoovBuf = Buffer.from(makeBox('moov', Buffer.concat(newMoovParts)));

  if (mdatIdx >= 0 && moovIdx < mdatIdx) {
    const delta = newMoovBuf.length - moov.size;
    shiftMoovChunkOffsets(newMoovBuf, delta);
  }

  const outTop = [];
  for (let i = 0; i < top.length; i++) {
    if (i === moovIdx) {
      outTop.push(newMoovBuf);
    } else {
      outTop.push(buf.subarray(top[i].offset, top[i].bodyEnd));
    }
  }

  fs.writeFileSync(filePath, Buffer.concat(outTop));
}
