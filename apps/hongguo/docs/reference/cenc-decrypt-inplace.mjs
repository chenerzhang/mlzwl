// In-place CENC decrypt: byte-length preserving, offsets unchanged.
import { readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
const [, , inPath, keyHex, outPath] = process.argv;
const buf = Buffer.from(readFileSync(inPath));
const key = Buffer.from(keyHex, 'hex');
function boxes(start, end) {
  let off = start;
  const out = [];
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) {
      size = Number(buf.readBigUInt64BE(off + 8));
      hdr = 16;
    }
    if (size === 0) size = end - off;
    out.push({ type, off, size, hdr, body: off + hdr, end: off + size });
    off += size;
  }
  return out;
}
const top = boxes(0, buf.length);
const moov = top.find((b) => b.type === 'moov');
for (const trak of boxes(moov.body, moov.end).filter((b) => b.type === 'trak')) {
  const mdia = boxes(trak.body, trak.end).find((b) => b.type === 'mdia');
  const minf = boxes(mdia.body, mdia.end).find((b) => b.type === 'minf');
  const stbl = boxes(minf.body, minf.end).find((b) => b.type === 'stbl');
  const kids = boxes(stbl.body, stbl.end);
  const stsd = kids.find((b) => b.type === 'stsd');
  const entry = boxes(stsd.body + 8, stsd.end)[0];
  const sinf = boxes(entry.type === 'encv' ? entry.body + 78 : entry.body + 28, entry.end).find(
    (b) => b.type === 'sinf',
  );
  if (!sinf) continue;
  const schi = boxes(sinf.body, sinf.end).find((b) => b.type === 'schi');
  const tenc = boxes(schi.body, schi.end).find((b) => b.type === 'tenc');
  const kidAt = tenc.body + (tenc.size - tenc.hdr) - 16;
  const ivSize = buf[kidAt - 1];
  const senc = kids.find((b) => b.type === 'senc');
  const stsz = kids.find((b) => b.type === 'stsz');
  const stco = kids.find((b) => b.type === 'stco');
  const stsc = kids.find((b) => b.type === 'stsc');
  const hasSubs = (buf.readUInt32BE(senc.body) & 0x2) !== 0;
  const sampleSize = buf.readUInt32BE(stsz.body + 4);
  const sampleCount = buf.readUInt32BE(stsz.body + 8);
  const sizes = [];
  for (let i = 0; i < sampleCount; i++) sizes.push(sampleSize || buf.readUInt32BE(stsz.body + 12 + i * 4));
  const chunkCount = buf.readUInt32BE(stco.body + 4);
  const chunkOffsets = [];
  for (let i = 0; i < chunkCount; i++) chunkOffsets.push(buf.readUInt32BE(stco.body + 8 + i * 4));
  const runs = [];
  for (let i = 0; i < buf.readUInt32BE(stsc.body + 4); i++) {
    const at = stsc.body + 8 + i * 12;
    runs.push({ firstChunk: buf.readUInt32BE(at), spc: buf.readUInt32BE(at + 4) });
  }
  const sampleOffsets = [];
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    let spc = runs[0].spc;
    for (const run of runs) if (chunk >= run.firstChunk) spc = run.spc;
    let off = chunkOffsets[chunk - 1];
    for (let i = 0; i < spc && sampleOffsets.length < sampleCount; i++) {
      sampleOffsets.push(off);
      off += sizes[sampleOffsets.length - 1];
    }
  }
  let sencOff = senc.body + 8;
  const sencCount = buf.readUInt32BE(senc.body + 4);
  for (let i = 0; i < sencCount; i++) {
    const iv = Buffer.alloc(16);
    buf.copy(iv, 0, sencOff, sencOff + ivSize);
    sencOff += ivSize;
    let subs = [];
    if (hasSubs) {
      const n = buf.readUInt16BE(sencOff);
      sencOff += 2;
      for (let s = 0; s < n; s++) {
        subs.push({ clear: buf.readUInt16BE(sencOff), enc: buf.readUInt32BE(sencOff + 2) });
        sencOff += 6;
      }
    }
    const decipher = createDecipheriv('aes-128-ctr', key, iv);
    let at = sampleOffsets[i];
    if (subs.length === 0) decipher.update(buf.subarray(at, at + sizes[i])).copy(buf, at);
    else
      for (const sub of subs) {
        at += sub.clear;
        if (sub.enc > 0) {
          decipher.update(buf.subarray(at, at + sub.enc)).copy(buf, at);
          at += sub.enc;
        }
      }
  }
  buf.write(entry.type === 'encv' ? 'hvc1' : 'mp4a', entry.off + 4, 'latin1');
  // flip tenc isProtected to 0 so a demuxer that reads it sees clear content
  buf[kidAt - 2] = 0;
  console.log(entry.type, 'samples', sencCount, 'ivSize', ivSize);
}
writeFileSync(outPath, buf);
