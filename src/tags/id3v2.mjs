import fs from 'node:fs';
import { parseLrc, formatLrc } from './lrc.mjs';

function syncsafeToInt(b, off) {
  return (
    ((b[off] & 0x7f) << 21) |
    ((b[off + 1] & 0x7f) << 14) |
    ((b[off + 2] & 0x7f) << 7) |
    (b[off + 3] & 0x7f)
  );
}

function intToSyncsafe(val) {
  const b = Buffer.alloc(4);
  b[0] = (val >>> 21) & 0x7f;
  b[1] = (val >>> 14) & 0x7f;
  b[2] = (val >>> 7) & 0x7f;
  b[3] = val & 0x7f;
  return b;
}

function decodeEncodedString(buf, encoding) {
  if (!buf || buf.length === 0) return '';
  if (encoding === 0) {
    return buf.toString('latin1').replace(/\0+$/g, '');
  }
  if (encoding === 1) {
    // UTF-16 with BOM
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.alloc(buf.length - 2);
      for (let i = 2; i + 1 < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1];
        swapped[i - 1] = buf[i];
      }
      return swapped.toString('utf16le').replace(/\0+$/g, '');
    }
    const start = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
    return buf.subarray(start).toString('utf16le').replace(/\0+$/g, '');
  }
  if (encoding === 2) {
    const swapped = Buffer.alloc(buf.length & ~1);
    for (let i = 0; i + 1 < buf.length; i += 2) {
      swapped[i] = buf[i + 1];
      swapped[i + 1] = buf[i];
    }
    return swapped.toString('utf16le').replace(/\0+$/g, '');
  }
  // encoding === 3 (UTF-8)
  return buf.toString('utf8').replace(/\0+$/g, '');
}

function findNullTerm(buf, start, encoding) {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < buf.length; i += 2) {
      if (buf[i] === 0 && buf[i + 1] === 0) return { end: i, next: i + 2 };
    }
    return { end: buf.length, next: buf.length };
  }
  const idx = buf.indexOf(0, start);
  if (idx < 0) return { end: buf.length, next: buf.length };
  return { end: idx, next: idx + 1 };
}

export function parseId3v2Buffer(buf) {
  const tags = {
    tagFormat: null,
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
  };

  if (!buf || buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') {
    return tags;
  }

  const verMajor = buf[3];
  const flags = buf[5];
  const tagBodyLen = syncsafeToInt(buf, 6);
  tags.tagFormat = `ID3v2.${verMajor}`;

  let pos = 10;
  const end = Math.min(buf.length, 10 + tagBodyLen);

  // Skip extended header if present
  if (flags & 0x40) {
    if (pos + 4 > end) return tags;
    const extLen = verMajor === 4 ? syncsafeToInt(buf, pos) : 4 + buf.readUInt32BE(pos);
    pos += extLen;
  }

  while (pos + 10 <= end) {
    const id = buf.toString('ascii', pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsize = verMajor === 4 ? syncsafeToInt(buf, pos + 4) : buf.readUInt32BE(pos + 4);
    if (fsize <= 0 || pos + 10 + fsize > end) break;
    const fbody = buf.subarray(pos + 10, pos + 10 + fsize);
    pos += 10 + fsize;

    if (id.startsWith('T') && id !== 'TXXX') {
      const enc = fbody[0];
      const val = decodeEncodedString(fbody.subarray(1), enc).trim();
      if (id === 'TIT2') tags.title = val;
      else if (id === 'TPE1') tags.artist = val;
      else if (id === 'TALB') tags.album = val;
      else if (id === 'TDRC' || (id === 'TYER' && !tags.year)) tags.year = val;
      else if (id === 'TCOM') tags.composer = val;
      else if (id === 'TCON') tags.genre = val;
      else if (id === 'TRCK') tags.trackNumber = val;
    } else if (id === 'USLT' && fbody.length >= 4) {
      const enc = fbody[0];
      const desc = findNullTerm(fbody, 4, enc);
      const txt = decodeEncodedString(fbody.subarray(desc.next), enc);
      tags.lyrics = txt;
      if (tags.syncedLyrics.length === 0) {
        const parsed = parseLrc(txt);
        if (parsed.length > 0) tags.syncedLyrics = parsed;
      }
    } else if (id === 'SYLT' && fbody.length >= 6) {
      const enc = fbody[0];
      const tsFormat = fbody[4]; // 2 = milliseconds
      const desc = findNullTerm(fbody, 6, enc);
      let sp = desc.next;
      const items = [];
      while (sp < fbody.length) {
        const term = findNullTerm(fbody, sp, enc);
        if (term.next + 4 > fbody.length) break;
        const lineText = decodeEncodedString(fbody.subarray(sp, term.end), enc);
        const tsVal = fbody.readUInt32BE(term.next);
        if (tsFormat === 2) {
          items.push({ timeMs: tsVal, text: lineText });
        }
        sp = term.next + 4;
      }
      if (items.length > 0) {
        items.sort((a, b) => a.timeMs - b.timeMs);
        tags.syncedLyrics = items;
        if (!tags.lyrics) tags.lyrics = formatLrc(items);
      }
    } else if (id === 'APIC' && fbody.length > 4) {
      const enc = fbody[0];
      const mimeTerm = findNullTerm(fbody, 1, 0);
      const mime = fbody.subarray(1, mimeTerm.end).toString('latin1') || 'image/jpeg';
      const picTypePos = mimeTerm.next;
      if (picTypePos < fbody.length) {
        const descTerm = findNullTerm(fbody, picTypePos + 1, enc);
        const imgData = Buffer.from(fbody.subarray(descTerm.next));
        if (imgData.length > 0) {
          tags.coverArt = { mime, data: imgData };
        }
      }
    }
  }

  return tags;
}

function makeFrame(id, payloadBuf) {
  const hdr = Buffer.alloc(10);
  hdr.write(id, 0, 4, 'ascii');
  intToSyncsafe(payloadBuf.length).copy(hdr, 4);
  hdr[8] = 0;
  hdr[9] = 0;
  return Buffer.concat([hdr, payloadBuf]);
}

function makeTextFrame(id, value) {
  const str = String(value ?? '').trim();
  if (!str) return null;
  const textBytes = Buffer.from(str, 'utf8');
  const payload = Buffer.alloc(1 + textBytes.length);
  payload[0] = 0x03; // UTF-8
  textBytes.copy(payload, 1);
  return makeFrame(id, payload);
}

export function buildId3v2Buffer(meta) {
  const frames = [];

  const pushText = (id, v) => {
    const f = makeTextFrame(id, v);
    if (f) frames.push(f);
  };

  pushText('TIT2', meta.title);
  pushText('TPE1', meta.artist);
  pushText('TALB', meta.album);
  pushText('TDRC', meta.year);
  pushText('TCOM', meta.composer);
  pushText('TCON', meta.genre);
  pushText('TRCK', meta.trackNumber);

  let synced = Array.isArray(meta.syncedLyrics) ? meta.syncedLyrics : [];
  let lyricsText = typeof meta.lyrics === 'string' ? meta.lyrics : '';
  if (synced.length === 0 && lyricsText) {
    synced = parseLrc(lyricsText);
  }
  if (!lyricsText && synced.length > 0) {
    lyricsText = formatLrc(synced);
  }

  if (lyricsText) {
    const txtBytes = Buffer.from(lyricsText, 'utf8');
    // [enc=0x03][lang='spa'][desc='\0'][text]
    const uslt = Buffer.alloc(5 + txtBytes.length);
    uslt[0] = 0x03;
    uslt.write('spa', 1, 3, 'ascii');
    uslt[4] = 0x00;
    txtBytes.copy(uslt, 5);
    frames.push(makeFrame('USLT', uslt));
  }

  if (synced.length > 0) {
    // [enc=0x03][lang='spa'][tsFormat=0x02 ms][contentType=0x01 lyrics][desc='\0'] + [text '\0' + uint32BE(ms)]*
    const parts = [Buffer.from([0x03, 0x73, 0x70, 0x61, 0x02, 0x01, 0x00])];
    for (const item of synced) {
      const tb = Buffer.from(String(item.text ?? ''), 'utf8');
      const rec = Buffer.alloc(tb.length + 1 + 4);
      tb.copy(rec, 0);
      rec[tb.length] = 0;
      rec.writeUInt32BE(Math.max(0, Math.round(Number(item.timeMs) || 0)), tb.length + 1);
      parts.push(rec);
    }
    frames.push(makeFrame('SYLT', Buffer.concat(parts)));
  }

  if (meta.coverArt && Buffer.isBuffer(meta.coverArt.data) && meta.coverArt.data.length > 0) {
    const mime = String(meta.coverArt.mime || 'image/jpeg');
    const mimeBytes = Buffer.from(mime, 'latin1');
    // [enc=0x03][mime '\0'][picType=0x03 front cover][desc='\0'][imgData]
    const apic = Buffer.alloc(1 + mimeBytes.length + 1 + 1 + 1 + meta.coverArt.data.length);
    let o = 0;
    apic[o++] = 0x03;
    mimeBytes.copy(apic, o);
    o += mimeBytes.length;
    apic[o++] = 0x00;
    apic[o++] = 0x03; // Cover (front)
    apic[o++] = 0x00; // Empty description
    meta.coverArt.data.copy(apic, o);
    frames.push(makeFrame('APIC', apic));
  }

  const body = Buffer.concat(frames);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 3, 'ascii');
  header[3] = 0x04; // ID3v2.4
  header[4] = 0x00;
  header[5] = 0x00;
  intToSyncsafe(body.length).copy(header, 6);
  return Buffer.concat([header, body]);
}

export function readId3File(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'DSD ') {
    const metaOffset = Number(buf.readBigUInt64LE(20));
    if (metaOffset > 0 && metaOffset < buf.length) {
      return parseId3v2Buffer(buf.subarray(metaOffset));
    }
    return parseId3v2Buffer(null);
  }

  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const cid = buf.toString('ascii', pos, pos + 4);
      const csz = buf.readUInt32LE(pos + 4);
      if ((cid === 'ID3 ' || cid === 'id3 ') && pos + 8 + csz <= buf.length) {
        return parseId3v2Buffer(buf.subarray(pos + 8, pos + 8 + csz));
      }
      pos += 8 + csz + (csz & 1);
    }
    return parseId3v2Buffer(null);
  }

  return parseId3v2Buffer(buf);
}

export function writeId3File(filePath, mergedMeta) {
  const buf = fs.readFileSync(filePath);
  const id3Buf = buildId3v2Buffer(mergedMeta);

  // 1. Sony DSF: append ID3v2 at audio end and update DSD header total_size (offset 12) & metadata_offset (offset 20)
  if (buf.length >= 28 && buf.toString('ascii', 0, 4) === 'DSD ') {
    const existingMetaOff = Number(buf.readBigUInt64LE(20));
    const audioPart = existingMetaOff > 28 && existingMetaOff <= buf.length ? buf.subarray(0, existingMetaOff) : buf;
    const out = Buffer.concat([audioPart, id3Buf]);
    out.writeBigUInt64LE(BigInt(out.length), 12);
    out.writeBigUInt64LE(BigInt(audioPart.length), 20);
    fs.writeFileSync(filePath, out);
    return;
  }

  // 2. RIFF/WAVE: replace or append 'ID3 ' chunk while keeping all PCM chunks untouched
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    const keptChunks = [buf.subarray(0, 12)];
    let pos = 12;
    while (pos + 8 <= buf.length) {
      const cid = buf.toString('ascii', pos, pos + 4);
      const csz = buf.readUInt32LE(pos + 4);
      const padded = csz + (csz & 1);
      const endPos = Math.min(buf.length, pos + 8 + padded);
      if (cid !== 'ID3 ' && cid !== 'id3 ') {
        keptChunks.push(buf.subarray(pos, endPos));
      }
      pos = endPos;
    }
    const pad = id3Buf.length & 1 ? Buffer.from([0]) : Buffer.alloc(0);
    const chunkHdr = Buffer.alloc(8);
    chunkHdr.write('ID3 ', 0, 4, 'ascii');
    chunkHdr.writeUInt32LE(id3Buf.length, 4);
    keptChunks.push(chunkHdr, id3Buf, pad);
    const out = Buffer.concat(keptChunks);
    out.writeUInt32LE(out.length - 8, 4);
    fs.writeFileSync(filePath, out);
    return;
  }

  // 3. MP3: replace leading ID3v2 header while keeping 100% of MPEG audio frames untouched
  let audioOffset = 0;
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const flags = buf[5];
    const footer = flags & 0x10 ? 10 : 0;
    audioOffset = 10 + syncsafeToInt(buf, 6) + footer;
    if (audioOffset > buf.length) audioOffset = 0;
  }
  const out = Buffer.concat([id3Buf, buf.subarray(audioOffset)]);
  fs.writeFileSync(filePath, out);
}
