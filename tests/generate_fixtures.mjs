import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Write a standard RIFF/WAVE PCM file (16-bit or 24-bit signed little-endian).
 */
export function writeWavPcm(filePath, { sampleRate, channels, bitDepth, frames, sampleFn }) {
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitDepth, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  const maxPos = (1 << (bitDepth - 1)) - 1;
  const minNeg = -(1 << (bitDepth - 1));

  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const val = sampleFn(f, c); // integer in [minNeg, maxPos]
      const iv = Math.max(minNeg, Math.min(maxPos, Math.round(val)));
      if (bitDepth === 16) {
        buf.writeInt16LE(iv, off);
        off += 2;
      } else if (bitDepth === 24) {
        const u = iv < 0 ? iv + 0x1000000 : iv;
        buf[off] = u & 0xff;
        buf[off + 1] = (u >> 8) & 0xff;
        buf[off + 2] = (u >> 16) & 0xff;
        off += 3;
      } else {
        throw new Error(`Unsupported bitDepth ${bitDepth}`);
      }
    }
  }

  fs.writeFileSync(filePath, buf);
}

/**
 * Parse a RIFF/WAVE integer PCM file into { sampleRate, channels, bitDepth, frames, samples: Int32Array }.
 */
export function readWavPcm(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`Invalid WAV file: ${filePath}`);
  }
  let pos = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitDepth = 0;
  let dataStart = 0;
  let dataSize = 0;

  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const sz = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bitDepth = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      dataStart = body;
      dataSize = Math.min(sz, buf.length - body);
      break;
    }
    pos = body + sz + (sz & 1);
  }

  const bytesPerSample = bitDepth / 8;
  const totalSamples = Math.floor(dataSize / bytesPerSample);
  const frames = Math.floor(totalSamples / channels);
  const samples = new Int32Array(frames * channels);

  let off = dataStart;
  for (let i = 0; i < frames * channels; i++) {
    if (bitDepth === 16) {
      samples[i] = buf.readInt16LE(off);
      off += 2;
    } else if (bitDepth === 24) {
      let v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
      if (v & 0x800000) v |= ~0xffffff;
      samples[i] = v;
      off += 3;
    } else if (bitDepth === 32) {
      samples[i] = buf.readInt32LE(off);
      off += 4;
    }
  }
  return { sampleRate, channels, bitDepth, frames, samples };
}

/**
 * Generate a Sony DSF (DSD64..DSD1024 stereo) 1-bit Sigma-Delta file.
 */
export function writeDsfSine(
  filePath,
  durationSec = 0.08,
  freqL = 1000,
  freqR = 1500,
  dsdRate = 2822400,
) {
  const blockSize = 4096;
  const totalBitsPerCh = Math.floor((dsdRate * durationSec) / (blockSize * 8)) * (blockSize * 8);
  const numBlocksPerCh = totalBitsPerCh / (blockSize * 8);
  const audioDataBytes = numBlocksPerCh * 2 * blockSize;

  // DSD chunk (28) + fmt chunk (52) + data chunk header (12) + audioDataBytes
  const totalFileSize = 28 + 52 + 12 + audioDataBytes;
  const buf = Buffer.alloc(totalFileSize);

  // 'DSD ' chunk (28 bytes)
  buf.write('DSD ', 0, 'ascii');
  buf.writeBigUInt64LE(28n, 4);
  buf.writeBigUInt64LE(BigInt(totalFileSize), 12);
  buf.writeBigUInt64LE(0n, 20); // metadata offset (0 = none yet)

  // 'fmt ' chunk (52 bytes)
  buf.write('fmt ', 28, 'ascii');
  buf.writeBigUInt64LE(52n, 32);
  buf.writeUInt32LE(1, 40); // format version 1
  buf.writeUInt32LE(0, 44); // format ID 0 = DSD raw
  buf.writeUInt32LE(2, 48); // channel type 2 = stereo
  buf.writeUInt32LE(2, 52); // channel num = 2
  buf.writeUInt32LE(dsdRate, 56);
  buf.writeUInt32LE(1, 60); // bits per sample = 1 (LSB-first)
  buf.writeBigUInt64LE(BigInt(totalBitsPerCh), 64);
  buf.writeUInt32LE(blockSize, 72);
  buf.writeUInt32LE(0, 76);

  // 'data' chunk header (12 bytes)
  buf.write('data', 80, 'ascii');
  buf.writeBigUInt64LE(BigInt(12 + audioDataBytes), 84);

  // 2nd-order 1-bit Sigma-Delta modulation per channel
  const chBytes = [Buffer.alloc(numBlocksPerCh * blockSize), Buffer.alloc(numBlocksPerCh * blockSize)];
  const freqs = [freqL, freqR];
  for (let c = 0; c < 2; c++) {
    let i1 = 0.0;
    let i2 = 0.0;
    let fb = 0.0;
    const dst = chBytes[c];
    let bitIdx = 0;
    for (let n = 0; n < totalBitsPerCh; n++) {
      const x = 0.45 * Math.sin((2 * Math.PI * freqs[c] * n) / dsdRate);
      i1 += x - fb;
      i2 += i1 - 1.5 * fb;
      const bit = i2 >= 0 ? 1 : 0;
      fb = bit ? 1.0 : -1.0;
      if (bit) {
        // DSF bits_per_sample=1 is LSB-first
        dst[bitIdx >> 3] |= 1 << (bitIdx & 7);
      }
      bitIdx++;
    }
  }

  let off = 92;
  for (let b = 0; b < numBlocksPerCh; b++) {
    chBytes[0].copy(buf, off, b * blockSize, (b + 1) * blockSize);
    off += blockSize;
    chBytes[1].copy(buf, off, b * blockSize, (b + 1) * blockSize);
    off += blockSize;
  }

  fs.writeFileSync(filePath, buf);
}

/**
 * Generate a Philips DSDIFF (.dff) DSD64..DSD1024 stereo file (MSB-first byte-interleaved).
 */
export function writeDffSine(filePath, durationSec = 0.06, freq = 1000, dsdRate = 2822400) {
  const bytesPerCh = Math.floor((dsdRate * durationSec) / 8 / 4) * 4;
  const totalBitsPerCh = bytesPerCh * 8;
  const dsdBodyLen = bytesPerCh * 2;

  // Build PROP chunk payload: 'SND ' + FS + CHNL + CMPR
  const fsChunk = Buffer.alloc(16);
  fsChunk.write('FS  ', 0, 'ascii');
  fsChunk.writeBigUInt64BE(4n, 4);
  fsChunk.writeUInt32BE(dsdRate, 12);

  const chnlChunk = Buffer.alloc(22);
  chnlChunk.write('CHNL', 0, 'ascii');
  chnlChunk.writeBigUInt64BE(10n, 4);
  chnlChunk.writeUInt16BE(2, 12);
  chnlChunk.write('SLFTSRGT', 14, 'ascii');

  const cmprChunk = Buffer.alloc(12 + 18);
  cmprChunk.write('CMPR', 0, 'ascii');
  cmprChunk.writeBigUInt64BE(18n, 4);
  cmprChunk.write('DSD ', 12, 'ascii');
  cmprChunk.writeUInt8(13, 16);
  cmprChunk.write('not compressed', 17, 'ascii');

  const propPayload = Buffer.concat([Buffer.from('SND ', 'ascii'), fsChunk, chnlChunk, cmprChunk]);
  const propChunk = Buffer.alloc(12 + propPayload.length);
  propChunk.write('PROP', 0, 'ascii');
  propChunk.writeBigUInt64BE(BigInt(propPayload.length), 4);
  propPayload.copy(propChunk, 12);

  const fverChunk = Buffer.alloc(16);
  fverChunk.write('FVER', 0, 'ascii');
  fverChunk.writeBigUInt64BE(4n, 4);
  fverChunk.writeUInt32BE(0x01050000, 12);

  const dsdHeader = Buffer.alloc(12);
  dsdHeader.write('DSD ', 0, 'ascii');
  dsdHeader.writeBigUInt64BE(BigInt(dsdBodyLen), 4);

  const dsdData = Buffer.alloc(dsdBodyLen);
  let i1L = 0, i2L = 0, fbL = 0;
  let i1R = 0, i2R = 0, fbR = 0;
  for (let b = 0; b < bytesPerCh; b++) {
    let byteL = 0;
    let byteR = 0;
    for (let k = 0; k < 8; k++) {
      const n = b * 8 + k;
      const xL = 0.45 * Math.sin((2 * Math.PI * freq * n) / dsdRate);
      const xR = 0.45 * Math.cos((2 * Math.PI * freq * n) / dsdRate);
      i1L += xL - fbL; i2L += i1L - 1.5 * fbL;
      const bitL = i2L >= 0 ? 1 : 0; fbL = bitL ? 1 : -1;
      i1R += xR - fbR; i2R += i1R - 1.5 * fbR;
      const bitR = i2R >= 0 ? 1 : 0; fbR = bitR ? 1 : -1;
      // DSDIFF is MSB-first
      if (bitL) byteL |= 0x80 >> k;
      if (bitR) byteR |= 0x80 >> k;
    }
    dsdData[b * 2] = byteL;
    dsdData[b * 2 + 1] = byteR;
  }

  const formPayloadLen = 4 + fverChunk.length + propChunk.length + dsdHeader.length + dsdData.length;
  const frm8Header = Buffer.alloc(16);
  frm8Header.write('FRM8', 0, 'ascii');
  frm8Header.writeBigUInt64BE(BigInt(formPayloadLen), 4);
  frm8Header.write('DSD ', 12, 'ascii');

  fs.writeFileSync(filePath, Buffer.concat([frm8Header, fverChunk, propChunk, dsdHeader, dsdData]));
}

function hasGst() {
  try {
    execFileSync('gst-launch-1.0', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function generateAllFixtures(outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  const ref16 = path.join(outDir, 'ref_16_44k.wav');
  const ref24 = path.join(outDir, 'ref_24_96k.wav');
  const eqTestWav = path.join(outDir, 'eq_dual_tone.wav');
  const gap1 = path.join(outDir, 'gap_part1.wav');
  const gap2 = path.join(outDir, 'gap_part2.wav');
  const flac16 = path.join(outDir, 'sample_16_44k.flac');
  const flac24 = path.join(outDir, 'sample_24_96k.flac');
  const alac16 = path.join(outDir, 'sample_16_44k.m4a');
  const mp3File = path.join(outDir, 'sample_320k.mp3');
  const dsfFile = path.join(outDir, 'sample_dsd64.dsf');
  const dffFile = path.join(outDir, 'sample_dsd64.dff');

  // 1. 44.1 kHz / 16-bit stereo multi-tone
  writeWavPcm(ref16, {
    sampleRate: 44100,
    channels: 2,
    bitDepth: 16,
    frames: 22050, // 0.5 s
    sampleFn: (f, c) => {
      const t = f / 44100;
      return c === 0
        ? Math.round(14000 * Math.sin(2 * Math.PI * 440 * t) + 6000 * Math.sin(2 * Math.PI * 1320 * t))
        : Math.round(14000 * Math.sin(2 * Math.PI * 660 * t) + 5000 * Math.cos(2 * Math.PI * 1760 * t));
    },
  });

  // 2. 96 kHz / 24-bit stereo Hi-Res
  writeWavPcm(ref24, {
    sampleRate: 96000,
    channels: 2,
    bitDepth: 24,
    frames: 24000, // 0.25 s
    sampleFn: (f, c) => {
      const t = f / 96000;
      return c === 0
        ? Math.round(3200000 * Math.sin(2 * Math.PI * 910 * t) + 1200000 * Math.sin(2 * Math.PI * 7200 * t))
        : Math.round(3200000 * Math.cos(2 * Math.PI * 910 * t) + 1200000 * Math.sin(2 * Math.PI * 14000 * t));
    },
  });

  // 3. Pure 910 Hz tone on Left + 60 Hz tone on Right (for exact Biquad frequency selectivity test)
  writeWavPcm(eqTestWav, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    frames: 24000, // 0.5 s
    sampleFn: (f, c) => {
      const t = f / 48000;
      return c === 0
        ? Math.round(8000 * Math.sin(2 * Math.PI * 910 * t))
        : Math.round(8000 * Math.sin(2 * Math.PI * 60 * t));
    },
  });

  // 4. Phase-continuous split sine wave for Gapless Playback verification (split right at peak frame 12025!)
  const splitFrame = 12025;
  const totalGapFrames = 24000;
  const gapWave = (globalFrame, c) => {
    const phase = (2 * Math.PI * 480 * globalFrame) / 48000;
    return Math.round(18000 * (c === 0 ? Math.sin(phase) : Math.cos(phase)));
  };
  writeWavPcm(gap1, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    frames: splitFrame,
    sampleFn: (f, c) => gapWave(f, c),
  });
  writeWavPcm(gap2, {
    sampleRate: 48000,
    channels: 2,
    bitDepth: 16,
    frames: totalGapFrames - splitFrame,
    sampleFn: (f, c) => gapWave(splitFrame + f, c),
  });

  // 5. Real compressed FLAC, ALAC (.m4a), and MP3 via GStreamer encoders
  if (hasGst()) {
    execFileSync('gst-launch-1.0', [
      '-q', 'filesrc', `location=${ref16}`, '!', 'wavparse', '!', 'flacenc', '!', 'filesink', `location=${flac16}`,
    ]);
    execFileSync('gst-launch-1.0', [
      '-q', 'filesrc', `location=${ref24}`, '!', 'wavparse', '!', 'flacenc', '!', 'filesink', `location=${flac24}`,
    ]);
    execFileSync('gst-launch-1.0', [
      '-q', 'filesrc', `location=${ref16}`, '!', 'wavparse', '!', 'avenc_alac', '!', 'mp4mux', '!', 'filesink', `location=${alac16}`,
    ]);
    execFileSync('gst-launch-1.0', [
      '-q', 'filesrc', `location=${ref16}`, '!', 'wavparse', '!', 'audioconvert', '!',
      'lamemp3enc', 'target=bitrate', 'bitrate=320', 'cbr=true', '!', 'filesink', `location=${mp3File}`,
    ]);
  }

  // 6. DSD64 (.dsf and .dff)
  writeDsfSine(dsfFile, 0.08, 1000, 1500);
  writeDffSine(dffFile, 0.06, 1000);

  return {
    ref16, ref24, eqTestWav, gap1, gap2,
    flac16, flac24, alac16, mp3File, dsfFile, dffFile,
    splitFrame, totalGapFrames,
  };
}
