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

/**
 * 一个下载任务。
 *
 * `definition` 在**入队时冻结**，之后不再读全局偏好：
 * 用户批量提交 5 集 1080p 后切到 360p，前两集还在跑，剩下 3 集必须仍是 1080p。
 * 若执行时才去读当前选择，一次批量操作会产出混合清晰度的文件，而界面提交时
 * 显示的是一个档位。
 */
export interface DownloadTask {
  episodeId: string;
  /** 冻结的档位；`undefined` 表示由服务端默认选档。 */
  definition?: string;
}

export interface DownloadQueueHandlers {
  /** 任务真正开始执行。返回的 Promise 结束时槽位才会释放。 */
  run: (task: DownloadTask) => Promise<void>;
}

export class DownloadQueue {
  private readonly limit: number;
  private readonly run: (task: DownloadTask) => Promise<void>;
  /**
   * 正在执行的任务，按**集号**索引。
   *
   * 并发限制按集算而不是按档算：同一集的两个档同时下载会重复占用带宽，
   * 而且用户几乎不会需要。同一集同一时刻只允许一个任务。
   */
  private readonly active = new Set<string>();
  /** 排队中的任务，保持先来先服务。 */
  private readonly waiting: DownloadTask[] = [];

  constructor(limit: number, handlers: DownloadQueueHandlers) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`下载并发上限必须是正整数，收到 ${String(limit)}`);
    }
    this.limit = limit;
    this.run = handlers.run;
  }

  /** 当前是否已有该集在跑或在排队。 */
  has(episodeId: string): boolean {
    return this.active.has(episodeId) || this.waiting.some((task) => task.episodeId === episodeId);
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
    return this.waiting.map((task) => task.episodeId);
  }

  /** 排队中该集冻结的档位；不在队列里时返回 `undefined`。 */
  waitingDefinition(episodeId: string): string | undefined {
    return this.waiting.find((task) => task.episodeId === episodeId)?.definition;
  }

  /** 是否已排满（新任务必须排队）。 */
  get saturated(): boolean {
    return this.active.size >= this.limit;
  }

  /**
   * 提交一个任务。已在跑或在排队的同一集会直接被忽略。
   * 返回 `true` 表示已接受（立刻开始或进入排队），`false` 表示重复提交。
   */
  enqueue(task: DownloadTask): boolean {
    if (this.has(task.episodeId)) {
      return false;
    }
    if (this.active.size < this.limit) {
      this.start(task);
      return true;
    }
    this.waiting.push(task);
    return true;
  }

  /** 取消排队中的任务。已在执行的任务由调用方自己 abort。 */
  dequeue(episodeId: string): boolean {
    const index = this.waiting.findIndex((task) => task.episodeId === episodeId);
    if (index < 0) {
      return false;
    }
    this.waiting.splice(index, 1);
    return true;
  }

  /** 清空排队队列，返回被移除的任务，供调用方逐个上报「已取消」。 */
  clearWaiting(): readonly DownloadTask[] {
    const removed = [...this.waiting];
    this.waiting.length = 0;
    return removed;
  }

  private start(task: DownloadTask): void {
    this.active.add(task.episodeId);
    void Promise.resolve()
      .then(() => this.run(task))
      // 任务错误由下载状态层记录；队列只负责消费 rejection，避免全局 unhandledrejection。
      .catch(() => undefined)
      .finally(() => {
        this.active.delete(task.episodeId);
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
