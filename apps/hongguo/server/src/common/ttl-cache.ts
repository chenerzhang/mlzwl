/**
 * 带 TTL 与请求去重的内存缓存。
 *
 * 为什么需要：上游 `discover` 单次耗时约 2.5 秒（实测三次 2.5–2.7s）。首页
 * 每次进入都打一次，用户就要盯着骨架屏。推荐流本身变化很慢，缓存 60 秒
 * 完全够用。
 *
 * 两个关键行为：
 * 1. **TTL**：过期后重新取，避免内容长期不更新。
 * 2. **请求去重（inflight dedupe）**：多个并发请求同时未命中时只发一次上游
 *    请求，其余等待同一个 Promise。否则首屏多个组件同时请求会把上游打爆。
 *
 * 只做内存缓存：这是单机个人项目，进程重启丢缓存可以接受；引入 Redis 的
 * 复杂度远超收益。
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    /** 条目上限。超出时按插入顺序淘汰最旧的（Map 保序）。 */
    private readonly maxEntries = 256,
  ) {}

  /** 同步读，未命中或已过期返回 undefined。 */
  peek(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * 读缓存；未命中则调用 `load` 并写入。
   *
   * `load` 抛错时**不缓存错误**，下次会重试——否则一次网络抖动会让这个 key
   * 在 TTL 内一直返回错误。
   */
  async get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) {
      return cached;
    }

    const running = this.inflight.get(key);
    if (running !== undefined) {
      return running;
    }

    const task = load()
      .then((value) => {
        this.store(key, value);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }

  private store(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** 测试用：清空全部状态。 */
  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }
}
