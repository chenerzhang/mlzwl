import { parseContentLength } from './download-state';

export interface DownloadProgress {
  received: number;
  total: number | null;
}

export interface DownloadEpisodeOptions {
  episodeId: string;
  signal: AbortSignal;
  onProgress: (progress: DownloadProgress) => void;
}

/** 从同源媒体接口流式下载单集，避免接触或暴露任何上游地址。 */
export async function downloadEpisode({
  episodeId,
  signal,
  onProgress,
}: DownloadEpisodeOptions): Promise<{ blob: Blob; filename: string }> {
  const response = await fetch(`/api/media/${encodeURIComponent(episodeId)}`, { signal });
  if (!response.ok) {
    let message: string | undefined;
    try {
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') {
        message = body.message;
      }
    } catch {
      // 非 JSON 错误响应交给下面的 HTTP 状态兜底。
    }
    // 读取错误体时也可能收到取消，不能把它误报成 HTTP 失败。
    signal.throwIfAborted();
    throw new Error(message?.trim() === '' || message === undefined ? `下载失败（HTTP ${response.status}）` : message);
  }

  const total = parseContentLength(response.headers.get('content-length'));
  const reader = response.body?.getReader();
  if (reader === undefined) {
    throw new Error('浏览器不支持流式下载');
  }

  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let received = 0;
  while (true) {
    // fetch 与 reader 都接受同一个 signal；这里补检查可覆盖响应到达后、下一次读取前取消。
    signal.throwIfAborted();
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    // 复制成普通 ArrayBuffer，满足 BlobPart 类型并避免底层流复用缓冲区。
    chunks.push(Uint8Array.from(value));
    received += value.byteLength;
    onProgress({ received, total });
  }

  // 最后一片读完到组装 Blob 之间仍可能收到取消，取消就不能继续触发保存。
  signal.throwIfAborted();
  return {
    blob: new Blob(chunks, { type: 'video/mp4' }),
    filename: `${episodeId}.mp4`,
  };
}

/** 触发浏览器保存 Blob；延后一轮释放 URL，兼容需要异步接管下载的浏览器。 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
