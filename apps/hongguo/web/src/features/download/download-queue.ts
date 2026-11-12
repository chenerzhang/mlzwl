/**
 * 下载并发闸门。
 *
 * 每集下载会把整段媒体累积在内存里（实测 1080p 约 19 MB），如果用户连续点几十集，
 * 浏览器会同时发起几十个 fetch 并各自聚合完整 Blob，内存占用按集数线性增长。
 * 这里把并发压到固定上限，其余任务排队；排队项可取消，取消后立即让位。
 *
 * 做成纯逻辑（不碰 DOM、不碰 React）是为了能单测：并发上限这类配置一旦被人改回
 * 「无上限」，只有直接测这个类才能发现。
 */
export interface DownloadQueueHandlers {
  /** 任务真正开始执行。返回的 Promise 结束时槽位才会释放。 */
  run: (episodeId: string) => Promise<void>;
}

export class DownloadQueue {
  private readonly limit: number;
  private readonly run: (episodeId: string) => Promise<void>;
  /** 正在执行的任务。 */
  private readonly active = new Set<string>();
  /** 排队中的任务，保持先来先服务。 */
  private readonly waiting: string[] = [];

  constructor(limit: number, handlers: DownloadQueueHandlers) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`下载并发上限必须是正整数，收到 ${String(limit)}`);
    }
    this.limit = limit;
    this.run = handlers.run;
  }

  /** 当前是否已有该集在跑或在排队。 */
  has(episodeId: string): boolean {
    return this.active.has(episodeId) || this.waiting.includes(episodeId);
  }

  /** 正在执行的任务数。 */
  get activeCount(): number {
    return this.active.size;
  }

  /** 排队中的任务数。 */
  get waitingCount(): number {
    return this.waiting.length;
  }

  /** 排队中的集号，按先后顺序。供 UI 显示「排队中」。 */
  waitingIds(): readonly string[] {
    return [...this.waiting];
  }

  /** 是否已排满（新任务必须排队）。 */
  get saturated(): boolean {
    return this.active.size >= this.limit;
  }

  /**
   * 提交一个任务。已在跑或在排队的同一集会直接被忽略。
   * 返回 `true` 表示已接受（立刻开始或进入排队），`false` 表示重复提交。
   */
  enqueue(episodeId: string): boolean {
    if (this.has(episodeId)) {
      return false;
    }
    if (this.active.size < this.limit) {
      this.start(episodeId);
      return true;
    }
    this.waiting.push(episodeId);
    return true;
  }

  /** 取消排队中的任务。已在执行的任务由调用方自己 abort。 */
  dequeue(episodeId: string): boolean {
    const index = this.waiting.indexOf(episodeId);
    if (index < 0) {
      return false;
    }
    this.waiting.splice(index, 1);
    return true;
  }

  /** 清空排队队列，返回被移除的任务，供调用方逐个上报「已取消」。 */
  clearWaiting(): readonly string[] {
    const removed = [...this.waiting];
    this.waiting.length = 0;
    return removed;
  }

  private start(episodeId: string): void {
    this.active.add(episodeId);
    void Promise.resolve()
      .then(() => this.run(episodeId))
      // 任务错误由下载状态层记录；队列只负责消费 rejection，避免全局 unhandledrejection。
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(episodeId);
        this.pump();
      });
  }

  /** 有空位就按先来先服务补齐。 */
  private pump(): void {
    while (this.active.size < this.limit && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (next === undefined) {
        return;
      }
      this.start(next);
    }
  }
}
