// Prototype: pure-JS CENC (cenc-aes-ctr) decryption + MP4 box patch.
// Usage: node cenc-decrypt.mjs <enc.mp4> <key-hex> <out.mp4>
import { readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';

const [, , inPath, keyHex, outPath] = process.argv;
const buf = readFileSync(inPath);
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
const traks = boxes(moov.body, moov.end).filter((b) => b.type === 'trak');

const result = Buffer.from(buf);
const removals = [];

for (const trak of traks) {
  const mdia = boxes(trak.body, trak.end).find((b) => b.type === 'mdia');
  const minf = boxes(mdia.body, mdia.end).find((b) => b.type === 'minf');
  const stbl = boxes(minf.body, minf.end).find((b) => b.type === 'stbl');
  const kids = boxes(stbl.body, stbl.end);
  const stsd = kids.find((b) => b.type === 'stsd');
  const entry = boxes(stsd.body + 8, stsd.end)[0];
  const childStart = entry.type === 'encv' ? entry.body + 78 : entry.body + 28;
  const entryKids = boxes(childStart, entry.end);
  const sinf = entryKids.find((b) => b.type === 'sinf');
  if (!sinf) continue;
  const schi = boxes(sinf.body, sinf.end).find((b) => b.type === 'schi');
  const tenc = boxes(schi.body, schi.end).find((b) => b.type === 'tenc');
  // tenc 的 reserved 字节数不固定（红果样本 2B，ISO 标准 1B），所以从尾部反推字段位置。
  const kidAt = tenc.body + (tenc.size - tenc.hdr) - 16;
  const ivSize = buf[kidAt - 1];
  const isProtected = buf[kidAt - 2];
  const kid = buf.subarray(kidAt, kidAt + 16).toString('hex');

  const senc = kids.find((b) => b.type === 'senc');
  const stsz = kids.find((b) => b.type === 'stsz');
  const stco = kids.find((b) => b.type === 'stco');
  const stsc = kids.find((b) => b.type === 'stsc');
  const sencFlags = buf.readUInt32BE(senc.body) & 0xffffff;
  const hasSubs = (sencFlags & 0x2) !== 0;
  console.log(
    `${entry.type}: protected=${isProtected} ivSize=${ivSize} KID=${kid} sencFlags=0x${sencFlags.toString(16)} subs=${hasSubs}`,
  );

  const sampleSize = buf.readUInt32BE(stsz.body + 4);
  const sampleCount = buf.readUInt32BE(stsz.body + 8);
  const sizes = [];
  for (let i = 0; i < sampleCount; i++) sizes.push(sampleSize || buf.readUInt32BE(stsz.body + 12 + i * 4));

  const chunkCount = buf.readUInt32BE(stco.body + 4);
  const chunkOffsets = [];
  for (let i = 0; i < chunkCount; i++) chunkOffsets.push(buf.readUInt32BE(stco.body + 8 + i * 4));

  const stscCount = buf.readUInt32BE(stsc.body + 4);
  const runs = [];
  for (let i = 0; i < stscCount; i++) {
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

  let sencOff = senc.body + 4;
  const sencCount = buf.readUInt32BE(sencOff);
  sencOff += 4;
  for (let i = 0; i < sencCount; i++) {
    // CENC: an 8-byte per-sample IV is the high half of a 16-byte counter block.
    const iv = Buffer.alloc(16);
    buf.copy(iv, 0, sencOff, sencOff + ivSize);
    sencOff += ivSize;
    let subs = [];
    if (hasSubs) {
      const subCount = buf.readUInt16BE(sencOff);
      sencOff += 2;
      for (let s = 0; s < subCount; s++) {
        subs.push({ clear: buf.readUInt16BE(sencOff), enc: buf.readUInt32BE(sencOff + 2) });
        sencOff += 6;
      }
    }
    const decipher = createDecipheriv('aes-128-ctr', key, iv);
    let at = sampleOffsets[i];
    if (subs.length === 0) {
      const size = sizes[i];
      decipher.update(buf.subarray(at, at + size)).copy(result, at);
    } else {
      for (const sub of subs) {
        at += sub.clear;
        if (sub.enc > 0) {
          decipher.update(buf.subarray(at, at + sub.enc)).copy(result, at);
          at += sub.enc;
        }
      }
    }
  }
  console.log(`  decrypted ${sencCount} samples of ${sampleCount}`);
  result.write(entry.type === 'encv' ? 'hvc1' : 'mp4a', entry.off + 4, 'latin1');
  removals.push(sinf);
  for (const k of ['senc', 'saiz', 'saio']) {
    const box = kids.find((b) => b.type === k);
    if (box) removals.push(box);
  }
}

const removedBytes = removals.reduce((n, b) => n + b.size, 0);
const out = Buffer.alloc(result.length - removedBytes);
const sorted = [...removals].sort((a, b) => a.off - b.off);
let read = 0;
let write = 0;
for (const box of sorted) {
  result.copy(out, write, read, box.off);
  write += box.off - read;
  read = box.off + box.size;
}
result.copy(out, write, read);

const containers = [];
function collect(start, end) {
  for (const b of boxes(start, end)) {
    if (
      b.type === 'moov' ||
      b.type === 'trak' ||
      b.type === 'mdia' ||
      b.type === 'minf' ||
      b.type === 'stbl' ||
      b.type === 'stsd' ||
      b.type === 'encv' ||
      b.type === 'enca'
    ) {
      containers.push(b);
      const inner =
        b.type === 'stsd' ? b.body + 8 : b.type === 'encv' ? b.body + 78 : b.type === 'enca' ? b.body + 28 : b.body;
      collect(inner, b.end);
    }
  }
}
collect(0, buf.length);
for (const box of containers) {
  const inside = removals.filter((r) => r.off > box.off && r.end <= box.end);
  if (inside.length === 0) continue;
  out.writeUInt32BE(box.size - inside.reduce((n, r) => n + r.size, 0), box.off);
}
writeFileSync(outPath, out);
console.log('wrote', outPath, out.length, 'removed', removedBytes);
