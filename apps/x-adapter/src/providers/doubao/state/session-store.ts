import { createHash } from 'node:crypto';

export type DoubaoSession = {
  conversationId: string;
  sectionId: string;
  lastMessageIndex: number;
  modelItemKey: string;
  reasoningEffort: number;
};

type SessionEntry = DoubaoSession & { expiresAt: number; lastUsedAt: number };

export class DoubaoSessionStore {
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(
    private readonly options: { ttlMs: number; maxEntries: number } = {
      ttlMs: 6 * 60 * 60 * 1000,
      maxEntries: 200,
    },
  ) {}

  get(key: string): DoubaoSession | undefined {
    const entry = key ? this.sessions.get(key) : undefined;
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return undefined;
    }
    entry.lastUsedAt = Date.now();
    return sessionValue(entry);
  }

  set(key: string, session: DoubaoSession): void {
    if (!key || !session.conversationId) {
      return;
    }
    const now = Date.now();
    this.sessions.set(key, { ...session, expiresAt: now + this.options.ttlMs, lastUsedAt: now });
    this.prune();
  }

  delete(key: string): void {
    if (key) {
      this.sessions.delete(key);
    }
  }

  size(): number {
    this.pruneExpired();
    return this.sessions.size;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.sessions) {
      if (entry.expiresAt <= now) {
        this.sessions.delete(key);
      }
    }
  }

  private prune(): void {
    this.pruneExpired();
    while (this.sessions.size > this.options.maxEntries) {
      let oldest: [string, SessionEntry] | undefined;
      for (const entry of this.sessions) {
        if (!oldest || entry[1].lastUsedAt < oldest[1].lastUsedAt) {
          oldest = entry;
        }
      }
      if (!oldest) {
        return;
      }
      this.sessions.delete(oldest[0]);
    }
  }
}

function sessionValue(entry: SessionEntry): DoubaoSession {
  return {
    conversationId: entry.conversationId,
    sectionId: entry.sectionId,
    lastMessageIndex: entry.lastMessageIndex,
    modelItemKey: entry.modelItemKey,
    reasoningEffort: entry.reasoningEffort,
  };
}

export function resolveDoubaoSessionKey(request: {
  session_id?: string;
  previous_response_id?: string;
  metadata?: Record<string, unknown>;
}): string {
  const upstreamConversationId =
    typeof request.metadata?.conversation_id === 'string' ? request.metadata.conversation_id.trim() : '';
  if (upstreamConversationId) {
    return `conversation:${stableHash(upstreamConversationId)}`;
  }
  const explicit = request.session_id || request.previous_response_id || '';
  return explicit ? `explicit:${stableHash({ explicit })}` : '';
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await action();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  size(): number {
    return this.tails.size;
  }
}
