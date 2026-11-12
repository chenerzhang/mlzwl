/**
 * 最小 MP4 box 解析器。
 *
 * 只做 CENC 解密需要的事：遍历 box 树、读取 `stbl` 里各表、找到 `sinf/schi/tenc`。
 * 不解析 sample entry 的具体编码参数，那是 demuxer 的工作。
 *
 * 所有下标访问都经过 `at()` / `u32()`，因为 tsconfig 开了 `noUncheckedIndexedAccess`。
 */

import { ascii, at, u16, u32, u64 } from './bytes.js';

export interface Box {
  type: string;
  /** box 起始偏移（含 header）。 */
  offset: number;
  /** box 总长度（含 header）。 */
  size: number;
  /** header 长度：8，或 `size === 1` 时的 16。 */
  headerSize: number;
  /** body 起始偏移。 */
  body: number;
  /** box 结束偏移（不含）。 */
  end: number;
}

export class Mp4ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Mp4ParseError';
  }
}

/**
 * 列出 `[start, end)` 区间内的同级 box。
 *
 * 遇到未知或损坏的 size 会抛错，而不是静默截断——解密错位比崩溃更难排查。
 */
export function readBoxes(buf: Uint8Array, start = 0, end = buf.length): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = u32(buf, offset);
    const type = ascii(buf, offset + 4, 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) {
        throw new Mp4ParseError(`truncated 64-bit size at ${offset} (${type})`);
      }
      size = u64(buf, offset + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize) {
      throw new Mp4ParseError(`box ${type} at ${offset} has invalid size ${size}`);
    }
    if (offset + size > end) {
      throw new Mp4ParseError(`box ${type} at ${offset} overruns parent by ${offset + size - end} bytes`);
    }
    boxes.push({ type, offset, size, headerSize, body: offset + headerSize, end: offset + size });
    offset += size;
  }
  return boxes;
}

export function findBox(boxes: readonly Box[], type: string): Box | undefined {
  return boxes.find((box) => box.type === type);
}

export function requireBox(boxes: readonly Box[], type: string, context: string): Box {
  const box = findBox(boxes, type);
  if (box === undefined) {
    throw new Mp4ParseError(`missing ${type} inside ${context}`);
  }
  return box;
}

/** 沿路径下钻，例如 `['moov', 'trak', 'mdia']`。 */
export function descend(buf: Uint8Array, boxes: readonly Box[], path: readonly string[]): readonly Box[] {
  let current: readonly Box[] = boxes;
  let context = 'root';
  for (const type of path) {
    const box = requireBox(current, type, context);
    current = readBoxes(buf, box.body, box.end);
    context = type;
  }
  return current;
}

/**
 * `stsz`：样本大小表。
 *
 * `sampleSize !== 0` 表示所有样本等长，此时没有逐样本表。
 */
export interface SampleSizes {
  count: number;
  /** 逐样本大小；等长时全部填同一个值。 */
  sizes: number[];
}

export function readStsz(buf: Uint8Array, box: Box): SampleSizes {
  const sampleSize = u32(buf, box.body + 4);
  const count = u32(buf, box.body + 8);
  if (sampleSize !== 0) {
    return { count, sizes: new Array<number>(count).fill(sampleSize) };
  }
  const sizes = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    sizes[i] = u32(buf, box.body + 12 + i * 4);
  }
  return { count, sizes };
}

/** `stco` / `co64`：chunk 的文件偏移表。 */
export function readChunkOffsets(buf: Uint8Array, boxes: readonly Box[]): number[] {
  const stco = findBox(boxes, 'stco');
  if (stco !== undefined) {
    const count = u32(buf, stco.body + 4);
    const offsets = new Array<number>(count);
    for (let i = 0; i < count; i += 1) {
      offsets[i] = u32(buf, stco.body + 8 + i * 4);
    }
    return offsets;
  }
  const co64 = findBox(boxes, 'co64');
  if (co64 !== undefined) {
    const count = u32(buf, co64.body + 4);
    const offsets = new Array<number>(count);
    for (let i = 0; i < count; i += 1) {
      offsets[i] = u64(buf, co64.body + 8 + i * 8);
    }
    return offsets;
  }
  throw new Mp4ParseError('stbl has neither stco nor co64');
}

export interface StscRun {
  /** 1-based chunk 序号。 */
  firstChunk: number;
  /** 该 run 覆盖的每个 chunk 的样本数。 */
  samplesPerChunk: number;
}

/** `stsc`：chunk → 样本数的 run-length 表。 */
export function readStsc(buf: Uint8Array, box: Box): StscRun[] {
  const count = u32(buf, box.body + 4);
  const runs = new Array<StscRun>(count);
  for (let i = 0; i < count; i += 1) {
    const base = box.body + 8 + i * 12;
    runs[i] = { firstChunk: u32(buf, base), samplesPerChunk: u32(buf, base + 4) };
  }
  return runs;
}

/**
 * 把 `stsc` 的 run 展开成每个 chunk 的样本数。
 *
 * 红果的音频轨 `stsc` 有 1449 个 run，`samplesPerChunk` 在 1 和 2 之间交替。
 * 只读第一个 run 会让音频从第二个 chunk 起整体错位。
 */
export function expandStsc(runs: readonly StscRun[], chunkCount: number): number[] {
  if (runs.length === 0) {
    throw new Mp4ParseError('stsc has no entries');
  }
  const perChunk = new Array<number>(chunkCount).fill(0);
  const sorted = [...runs].sort((a, b) => a.firstChunk - b.firstChunk);
  for (let i = 0; i < sorted.length; i += 1) {
    const run = sorted[i];
    if (run === undefined) {
      continue;
    }
    const next = sorted[i + 1];
    const last = next === undefined ? chunkCount : next.firstChunk - 1;
    for (let chunk = run.firstChunk; chunk <= last && chunk <= chunkCount; chunk += 1) {
      perChunk[chunk - 1] = run.samplesPerChunk;
    }
  }
  return perChunk;
}

/** 由 chunk 偏移、每 chunk 样本数、样本大小表推出每个样本的文件偏移。 */
export function sampleOffsets(
  chunkOffsets: readonly number[],
  perChunk: readonly number[],
  sizes: readonly number[],
): number[] {
  const offsets: number[] = [];
  for (let chunk = 0; chunk < chunkOffsets.length; chunk += 1) {
    const count = perChunk[chunk] ?? 0;
    let cursor = chunkOffsets[chunk];
    if (cursor === undefined) {
      throw new Mp4ParseError(`missing chunk offset ${chunk}`);
    }
    for (let i = 0; i < count; i += 1) {
      const size = sizes[offsets.length];
      if (size === undefined) {
        return offsets;
      }
      offsets.push(cursor);
      cursor += size;
    }
  }
  return offsets;
}

/** `tenc` 解析出的加密参数。 */
export interface TencInfo {
  /** 每样本 IV 长度，红果实测 8（对应 16 字节计数器的高半）。 */
  ivSize: number;
  /** 是否受保护；解密后写回 0。 */
  isProtected: boolean;
  kid: Uint8Array;
  /** 写回 `isProtected = 0` 的字节偏移。 */
  protectedFlagOffset: number;
}

/**
 * 解析 `tenc`。
 *
 * **红果的 `tenc` 有 2 个保留字节，ISO 标准是 1 个。** 从头部按标准偏移读会整体
 * 错位，导致 IV 长度和 KID 都是垃圾值。这里改为从尾部倒推：KID 永远是最后 16 字节。
 */
export function readTenc(buf: Uint8Array, box: Box): TencInfo {
  const bodyLen = box.size - box.headerSize;
  if (bodyLen < 16 + 2) {
    throw new Mp4ParseError(`tenc too short (${bodyLen} bytes)`);
  }
  const kidAt = box.body + bodyLen - 16;
  const ivSize = at(buf, kidAt - 1);
  const isProtected = at(buf, kidAt - 2) !== 0;
  const kid = buf.slice(kidAt, kidAt + 16);
  if (kid.length !== 16) {
    throw new Mp4ParseError('tenc kid truncated');
  }
  return { ivSize, isProtected, kid, protectedFlagOffset: kidAt - 2 };
}

/** `senc` 里一个样本的加密信息。 */
export interface SampleEncryption {
  iv: Uint8Array;
  /** 子样本表；空数组表示整个样本加密。 */
  subsamples: Array<{ clearBytes: number; encryptedBytes: number }>;
}

/**
 * 解析 `senc`。
 *
 * 注意 `senc` 的 body 布局：`version(1) flags(3) sample_count(4)` 之后才是数据，
 * 所以 flags 在 `body` 起始处读，样本数在 `body + 4`。
 */
export function readSenc(buf: Uint8Array, box: Box, ivSize: number): SampleEncryption[] {
  const flags = u32(buf, box.body) & 0x00ffffff;
  const hasSubsamples = (flags & 0x2) !== 0;
  const count = u32(buf, box.body + 4);
  const out: SampleEncryption[] = [];
  let cursor = box.body + 8;
  for (let i = 0; i < count; i += 1) {
    if (cursor + ivSize > box.end) {
      throw new Mp4ParseError(`senc truncated at sample ${i}`);
    }
    const iv = buf.slice(cursor, cursor + ivSize);
    cursor += ivSize;
    const subsamples: Array<{ clearBytes: number; encryptedBytes: number }> = [];
    if (hasSubsamples) {
      if (cursor + 2 > box.end) {
        throw new Mp4ParseError(`senc truncated at subsample count ${i}`);
      }
      const n = u16(buf, cursor);
      cursor += 2;
      for (let s = 0; s < n; s += 1) {
        if (cursor + 6 > box.end) {
          throw new Mp4ParseError(`senc truncated at subsample ${i}/${s}`);
        }
        subsamples.push({ clearBytes: u16(buf, cursor), encryptedBytes: u32(buf, cursor + 2) });
        cursor += 6;
      }
    }
    out.push({ iv, subsamples });
  }
  return out;
}

/** 一条轨道（`trak`）的解密计划。 */
export interface TrackPlan {
  /** 原始 sample entry 类型：`encv` 或 `enca`。 */
  entryType: string;
  /** 解密后应写回的 sample entry 类型：`hvc1` / `avc1` / `mp4a`。 */
  clearType: string;
  sampleEntryOffset: number;
  tenc: TencInfo;
  /** 每个样本的文件绝对偏移。 */
  offsets: number[];
  /** 每个样本的字节长度。 */
  sizes: number[];
  /** 每个样本的加密信息。 */
  samples: SampleEncryption[];
}

const ENCRYPTED_ENTRY_CLEAR_TYPE: Record<string, string> = {
  encv: 'hvc1',
  enca: 'mp4a',
};

/**
 * `moov` 允许的最大字节数。
 *
 * 为什么要有上限：解密后 `moov` 的偏移表要继续有效，所以我们必须把整个 `moov`
 * 读进内存。上游正常文件的 `moov` 是 194 KB 量级（实测 360p 194210、1080p 194198），
 * 8 MB 留了 40 倍余量。超过这个量级说明不是我们认识的容器，应当 fail closed。
 */
export const MAX_MOOV_BYTES = 8 * 1024 * 1024;

/**
 * `moov` 之前允许出现的 box。
 *
 * 判据是「**不是样本数据容器**」，不是「我们实测见过哪些」。真正的约束是
 * **`mdat`/`moof` 这类携带样本数据的 box 不得排在 `moov` 之前**：那样浏览器必须
 * 先拿到文件尾部才能起播，而本项目的解密与 Range 都依赖 `moov` 在文件开头。
 *
 * - `pdin`：progressive download info，faststart 文件常把它紧跟在 `ftyp` 后面。
 * - `uuid`：通用扩展 box，内容由具体实现定义。它与已有的 `free`/`skip` 属同一风险类别：
 *   都是「`moov` 前的任意长度盒子」，放行不引入新的风险类别。不要据此推断它
 *   「不携带媒体负载」——ISO BMFF 允许它包任意数据。
 */
const MOOV_LEADING_ALLOWED = new Set(['ftyp', 'free', 'wide', 'skip', 'pdin', 'uuid']);

/**
 * 校验「索引前置」布局，返回 `moov`。
 *
 * 三项检查，任何一项失败都抛 `Mp4ParseError`：
 * 1. `ftyp` 必须是文件第一个 box，且在偏移 0。
 * 2. `moov` 之前不得出现 `mdat` 等数据 box（只允许 {@link MOOV_LEADING_ALLOWED} 里的类型）。
 * 3. `moov` 不得超过 {@link MAX_MOOV_BYTES}。
 */
function requireFrontLoadedMoov(buf: Uint8Array, top: readonly Box[]): Box {
  const first = top[0];
  if (first === undefined || first.type !== 'ftyp' || first.offset !== 0) {
    throw new Mp4ParseError(`ftyp must be the first box at offset 0 (found ${first?.type ?? 'nothing'})`);
  }
  const moov = findBox(top, 'moov');
  if (moov === undefined) {
    throw new Mp4ParseError('missing moov inside file');
  }
  if (moov.size > MAX_MOOV_BYTES) {
    throw new Mp4ParseError(`moov is too large (${moov.size} > ${MAX_MOOV_BYTES} bytes)`);
  }
  const index = top.indexOf(moov);
  for (let i = 1; i < index; i += 1) {
    const box = top[i];
    if (box !== undefined && !MOOV_LEADING_ALLOWED.has(box.type)) {
      throw new Mp4ParseError(`moov is not front-loaded (${box.type} at ${box.offset} precedes it)`);
    }
  }
  // 读一次以确认 body 落在文件内：`readBoxes` 只校验了父区间。
  if (moov.end > buf.length) {
    throw new Mp4ParseError(`moov overruns file (${moov.end} > ${buf.length})`);
  }
  return moov;
}

/**
 * 从 `sinf/frma` 读出原始编码，读不到时回退固定映射。
 *
 * 为什么要读 `frma`：加密后 sample entry 的类型被改成 `encv`/`enca`，原始编码只
 * 保留在 `frma` 里。上游当前实测是 HEVC（`hvc1`）与 AAC（`mp4a`），但硬编码意味着
 * 上游一旦改用 AVC（`avc1`）或 `ac-3`，我们就会把 codec tag 写错——浏览器据此选
 * 解码器，写错的表现是「能下载但播不了」。
 */
function resolveClearType(
  buf: Uint8Array,
  entry: Box,
  sinf: Box,
  onWarn: ((message: string) => void) | undefined,
): string {
  const fallback = ENCRYPTED_ENTRY_CLEAR_TYPE[entry.type] ?? entry.type;
  const frma = findBox(readBoxes(buf, sinf.body, sinf.end), 'frma');
  let reason = 'no usable sinf/frma';
  if (frma !== undefined && frma.size - frma.headerSize >= 4) {
    const original = ascii(buf, frma.body, 4);
    // 只接受 4 个可打印 ASCII 字符，避免把垃圾字节写进 sample entry。
    if (/^[\x20-\x7e]{4}$/.test(original)) {
      // `frma` 等于 `encv`/`enca` 时写回去等于没解密，而 `tenc` 的保护位已经被清零，
      // 文件会自相矛盾（声明明文却仍是加密 entry）。这种情况按不可用处理，走回退。
      if (original !== entry.type) {
        return original;
      }
      reason = `sinf/frma === ${original}`;
    }
  }
  onWarn?.(`${entry.type} at ${entry.offset} has ${reason}; falling back to ${fallback}`);
  return fallback;
}

export interface PlanTracksOptions {
  /**
   * 回退路径的告警出口。
   *
   * 本包同时被浏览器与服务端引用，不能直接依赖 `console` 或 Nest 的 `Logger`，
   * 所以用回调注入。不传时静默回退，行为与旧版本一致。
   */
  onWarn?: (message: string) => void;
}

/**
 * 遍历 `moov/trak`，为每条受保护的轨道生成解密计划。
 *
 * sample entry 的 header 长度取决于它是视频（`encv`，VisualSampleEntry，8+70 字节）
 * 还是音频（`enca`，AudioSampleEntry，8+20 字节）。这个偏移必须对，否则找不到 `sinf`。
 */
export function planTracks(buf: Uint8Array, options: PlanTracksOptions = {}): TrackPlan[] {
  const top = readBoxes(buf, 0, buf.length);
  const moov = requireFrontLoadedMoov(buf, top);
  const moovChildren = readBoxes(buf, moov.body, moov.end);
  const plans: TrackPlan[] = [];

  for (const trak of moovChildren.filter((box) => box.type === 'trak')) {
    const trakChildren = readBoxes(buf, trak.body, trak.end);
    const mdia = findBox(trakChildren, 'mdia');
    if (mdia === undefined) {
      continue;
    }
    const minf = findBox(readBoxes(buf, mdia.body, mdia.end), 'minf');
    if (minf === undefined) {
      continue;
    }
    const stbl = findBox(readBoxes(buf, minf.body, minf.end), 'stbl');
    if (stbl === undefined) {
      continue;
    }

    const stblChildren = readBoxes(buf, stbl.body, stbl.end);
    const stsd = findBox(stblChildren, 'stsd');
    if (stsd === undefined) {
      continue;
    }
    const entries = readBoxes(buf, stsd.body + 8, stsd.end);
    const entry = entries[0];
    if (entry === undefined) {
      continue;
    }

    const clearType = ENCRYPTED_ENTRY_CLEAR_TYPE[entry.type];
    if (clearType === undefined) {
      continue;
    }

    // SampleEntry 的固定字段长度（在 8 字节 box header 之后）：
    //   VisualSampleEntry = 6+2 + 16+2+2+4+4+4+2+32+2+2 = 78
    //   AudioSampleEntry  = 6+2 + 8+2+2+2+2              = 24（红果实测用 28）
    // 偏移错 1 字节就找不到 sinf，所以这里按实测值写死。
    const childStart = entry.type === 'encv' ? entry.body + 78 : entry.body + 28;
    const entryChildren = readBoxes(buf, childStart, entry.end);
    const sinf = findBox(entryChildren, 'sinf');
    if (sinf === undefined) {
      throw new Mp4ParseError(`encrypted entry ${entry.type} has no sinf`);
    }
    const resolvedClearType = resolveClearType(buf, entry, sinf, options.onWarn);
    const schi = requireBox(readBoxes(buf, sinf.body, sinf.end), 'schi', 'sinf');
    const tenc = readTenc(buf, requireBox(readBoxes(buf, schi.body, schi.end), 'tenc', 'schi'));

    const senc = findBox(stblChildren, 'senc');
    if (senc === undefined) {
      throw new Mp4ParseError('encrypted track has no senc');
    }
    const samples = readSenc(buf, senc, tenc.ivSize);

    const { sizes } = readStsz(buf, requireBox(stblChildren, 'stsz', 'stbl'));
    const chunkOffsets = readChunkOffsets(buf, stblChildren);
    const runs = readStsc(buf, requireBox(stblChildren, 'stsc', 'stbl'));
    const perChunk = expandStsc(runs, chunkOffsets.length);
    const offsets = sampleOffsets(chunkOffsets, perChunk, sizes);

    plans.push({
      entryType: entry.type,
      clearType: resolvedClearType,
      sampleEntryOffset: entry.offset,
      tenc,
      offsets,
      sizes,
      samples,
    });
  }

  return plans;
}
