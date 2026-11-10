// Browser-side pure-JS CENC decrypt using WebCrypto AES-CTR.
export async function decryptCenc(bytes, keyHex) {
  const buf = bytes;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const u32 = (o) => dv.getUint32(o);
  const str = (o, n) => new TextDecoder('latin1').decode(buf.subarray(o, o + n));
  function boxes(start, end) {
    let off = start;
    const out = [];
    while (off + 8 <= end) {
      let size = u32(off);
      const type = str(off + 4, 4);
      let hdr = 8;
      if (size === 1) {
        size = Number(dv.getBigUint64(off + 8));
        hdr = 16;
      }
      if (size === 0) size = end - off;
      out.push({ type, off, size, hdr, body: off + hdr, end: off + size });
      off += size;
    }
    return out;
  }
  const keyBytes = new Uint8Array(keyHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', false, ['decrypt']);
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
    // tenc 布局：version(1) flags(3) reserved(?) isProtected(1) ivSize(1) KID(16) [constantIV]
    // 不同 muxer 写的 reserved 字节数不一样（实测样本是 2 字节，ISO 标准是 1 字节），
    // 所以不能硬编码偏移。从 KID 反推：KID 占最后 16 字节，ivSize 在其前 1 字节，
    // isProtected 再前 1 字节。这样对两种布局都成立。
    const tencBodyLen = tenc.size - tenc.hdr;
    const kidAt = tenc.body + tencBodyLen - 16;
    const ivSize = buf[kidAt - 1];
    const isProtectedAt = kidAt - 2;
    const senc = kids.find((b) => b.type === 'senc');
    const stsz = kids.find((b) => b.type === 'stsz');
    const stco = kids.find((b) => b.type === 'stco');
    const stsc = kids.find((b) => b.type === 'stsc');
    const hasSubs = (u32(senc.body) & 0x2) !== 0;
    const sampleSize = u32(stsz.body + 4),
      sampleCount = u32(stsz.body + 8);
    const sizes = [];
    for (let i = 0; i < sampleCount; i++) sizes.push(sampleSize || u32(stsz.body + 12 + i * 4));
    const chunkCount = u32(stco.body + 4);
    const chunkOffsets = [];
    for (let i = 0; i < chunkCount; i++) chunkOffsets.push(u32(stco.body + 8 + i * 4));
    const runs = [];
    for (let i = 0; i < u32(stsc.body + 4); i++) {
      const at = stsc.body + 8 + i * 12;
      runs.push({ firstChunk: u32(at), spc: u32(at + 4) });
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
    const sencCount = u32(senc.body + 4);
    for (let i = 0; i < sencCount; i++) {
      const counter = new Uint8Array(16);
      counter.set(buf.subarray(sencOff, sencOff + ivSize), 0);
      sencOff += ivSize;
      const subs = [];
      if (hasSubs) {
        const n = (buf[sencOff] << 8) | buf[sencOff + 1];
        sencOff += 2;
        for (let s = 0; s < n; s++) {
          subs.push({ clear: (buf[sencOff] << 8) | buf[sencOff + 1], enc: u32(sencOff + 2) });
          sencOff += 6;
        }
      }
      let at = sampleOffsets[i];
      const parts = subs.length ? subs : [{ clear: 0, enc: sizes[i] }];
      for (const sub of parts) {
        at += sub.clear;
        if (sub.enc > 0) {
          const plain = new Uint8Array(
            await crypto.subtle.decrypt({ name: 'AES-CTR', counter, length: 64 }, key, buf.subarray(at, at + sub.enc)),
          );
          buf.set(plain, at);
          at += sub.enc;
        }
      }
    }
    buf.set(new TextEncoder().encode(entry.type === 'encv' ? 'hvc1' : 'mp4a'), entry.off + 4);
    buf[isProtectedAt] = 0;
  }
  return buf;
}
