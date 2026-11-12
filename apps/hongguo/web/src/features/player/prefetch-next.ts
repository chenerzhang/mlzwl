export interface PrefetchOptions {
  /** 要预热的媒体地址（相对路径）。 */
  url: string;
  /** 取消信号。 */
  signal: AbortSignal;
  /** 注入的 fetch，测试用。 */
  fetchImpl?: typeof fetch;
}

/**
 * 预热一段媒体：发一次 2 字节 Range 请求，让服务端在后台完成下载 + 解密 + 落盘。
 *
 * 服务端收到 Range 请求仍会走完整的 `cache.get()`，所以第一个字节返回时媒体文件
 * 已经在磁盘上；切集时 `<video>` 再来请求就是本地命中。请求发完立刻丢弃响应体，
 * 既不读也不需要它：真正的收益在服务端的副作用，读 2 字节以外的内容只是抢带宽。
 *
 * 预热是纯优化，任何失败都必须静默：网络错误、被 abort、服务端 5xx 都不该影响
 * 正在播放的这一集，所以这里只回 `boolean`，绝不抛。
 */
export async function prefetchMedia(options: PrefetchOptions): Promise<boolean> {
  const { url, signal, fetchImpl = fetch } = options;
  try {
    const response = await fetchImpl(url, { headers: { range: 'bytes=0-1' }, signal });
    // `ok` 覆盖 200–299，服务的 206 分片响应已经算成功。
    const ok = response.ok;
    // 不读 body：`cancel()` 立刻释放连接，避免把整集拉下来。
    // `cancel()` 自身抛错不算预热失败——预热只看服务端是否已经把这个文件建好。
    try {
      await response.body?.cancel();
    } catch {
      // 忽略：连接已释放或流已结束，不影响结论。
    }
    return ok;
  } catch {
    return false;
  }
}
