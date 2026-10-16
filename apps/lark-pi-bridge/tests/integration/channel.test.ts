import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CardActionEvent, CommentEvent } from '@larksuite/channel';
import type { AgentAdapter, AgentInteractionPort, AgentRun, AgentRunOptions } from '../../src/agent/types.js';
import {
  CHANNEL_KEEPALIVE_INTERVAL_MS,
  CHANNEL_RECONNECT_GRACE_MS,
  startChannel,
  type ChannelPort,
} from '../../src/bot/channel.js';
import { resolveAppPaths } from '../../src/config/app-paths.js';
import { removeWorkspace, setDefaultWorkspace, setWorkspace } from '../../src/config/profile-management.js';
import { createProfileConfig } from '../../src/config/profile-schema.js';
import { saveRootConfig } from '../../src/config/store.js';

class FakeChannel implements ChannelPort {
  readonly options: Parameters<NonNullable<Parameters<typeof startChannel>[0]['createChannel']>>[0] | undefined;
  handler?: (message: Parameters<NonNullable<Parameters<ChannelPort['on']>[0]['message']>>[0]) => Promise<void>;
  cardActionHandler?: (event: CardActionEvent) => unknown;
  errorHandler?: (error: Error) => void;
  reconnectingHandler?: () => void;
  reconnectedHandler?: () => void;
  connectionStatus: NonNullable<ReturnType<NonNullable<ChannelPort['getConnectionStatus']>>> = {
    state: 'connected',
    reconnectAttempts: 0,
    lastConnectTime: Date.now(),
  };

  constructor(options?: Parameters<NonNullable<Parameters<typeof startChannel>[0]['createChannel']>>[0]) {
    this.options = options;
  }
  commentHandler?: (comment: CommentEvent) => Promise<void>;
  replies: string[] = [];
  sent: Array<{ to: string; input: Parameters<ChannelPort['send']>[1] }> = [];
  commentReplies: string[] = [];
  connected = false;

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  getConnectionStatus() {
    return this.connectionStatus;
  }
  getBotIdentity(): { openId: string; name: string } {
    return { openId: 'ou_bot', name: 'Bridge Bot' };
  }
  on(handlers: Parameters<ChannelPort['on']>[0]): void {
    this.handler = handlers.message;
    this.commentHandler = handlers.comment;
    this.cardActionHandler = handlers.cardAction;
    this.errorHandler = handlers.error;
    this.reconnectingHandler = handlers.reconnecting;
    this.reconnectedHandler = handlers.reconnected;
  }
  async send(to: string, input: Parameters<ChannelPort['send']>[1]): Promise<{ messageId: string }> {
    this.sent.push({ to, input });
    return { messageId: `sent-${this.sent.length}` };
  }
  async reply(
    _message: Parameters<ChannelPort['reply']>[0],
    input: Parameters<ChannelPort['reply']>[1],
  ): Promise<void> {
    this.replies.push('text' in input ? input.text : 'markdown' in input ? input.markdown : '[non-text reply]');
  }
  async stream(to: string, input: Parameters<ChannelPort['stream']>[1]): Promise<{ messageId: string }> {
    if (!('markdown' in input)) {
      throw new Error('unexpected card stream');
    }
    let content = '';
    await input.markdown({
      messageId: 'stream-reply',
      append: async (chunk) => {
        content += chunk;
      },
      setContent: async (next) => {
        content = next;
      },
    });
    this.replies.push(`${to}:${content}`);
    return { messageId: 'stream-reply' };
  }
  async downloadResourceWithMeta(): Promise<{ buffer: Buffer; contentType?: string }> {
    return { buffer: Buffer.from('image') };
  }
  comments = {
    resolveTarget: async (fileToken: string, fileType: string) => ({ fileToken, fileType: fileType as 'docx' }),
    fetch: async () => ({ commentId: 'comment', quote: 'comment question', isWhole: false, replies: [] }),
    reply: async (_target: unknown, _commentId: string, text: string) => {
      this.commentReplies.push(text);
    },
  } as ChannelPort['comments'];
  async deliverComment(comment: CommentEvent): Promise<void> {
    if (!this.commentHandler) {
      throw new Error('comment handler not installed');
    }
    await this.commentHandler(comment);
  }
  async deliverCardAction(event: CardActionEvent): Promise<unknown> {
    if (!this.cardActionHandler) {
      throw new Error('card action handler not installed');
    }
    return this.cardActionHandler(event);
  }
  async deliver(message: {
    messageId: string;
    chatId: string;
    chatType: 'p2p' | 'group';
    senderId: string;
    content: string;
    threadId?: string;
    mentionedBot?: boolean;
    resources?: Array<{ type: 'image'; fileKey: string }>;
  }): Promise<void> {
    if (!this.handler) {
      throw new Error('message handler not installed');
    }
    await this.handler({
      ...message,
      chatMode: message.chatType,
      rawContentType: 'text',
      resources: message.resources ?? [],
      mentions: [],
      mentionAll: false,
      mentionedBot: message.mentionedBot ?? true,
      createTime: Date.now(),
    });
  }
}

let idSequence = 0;
function randomId(): string {
  idSequence += 1;
  return `message-${idSequence}`;
}

function findCardToken(value: unknown): string {
  if (!value || typeof value !== 'object') {
    throw new Error('interaction card did not contain an action token');
  }
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.token === 'string') {
      return record.token;
    }
    for (const item of Object.values(record)) {
      try {
        return findCardToken(item);
      } catch {
        // Keep searching the bounded test fixture.
      }
    }
  } else {
    for (const item of value) {
      try {
        return findCardToken(item);
      } catch {
        // Keep searching the bounded test fixture.
      }
    }
  }
  throw new Error('interaction card did not contain an action token');
}

function cardAction(token: string, openId: string, value: Record<string, string>): CardActionEvent {
  return {
    messageId: 'private-card',
    chatId: 'private-chat',
    operator: { openId },
    action: { tag: 'button', value: { token, ...value } },
  };
}

describe('startChannel with a typed fake channel', () => {
  it('enforces one active App ID across profiles, processes and different bridge homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-app-lock-'));
    try {
      const cwd = await realpath(root);
      const profile = createProfileConfig({
        app: { id: 'cli_shared', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: cwd,
        access: { allowedUsers: ['ou_allowed'] },
      });
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi',
        async isAvailable() {
          return true;
        },
        run() {
          throw new Error('not used');
        },
      };
      const appLockRoot = join(root, 'global-app-locks');
      const firstPaths = resolveAppPaths({ rootDir: join(root, 'home-one'), profile: 'one', appLockRoot });
      const secondPaths = resolveAppPaths({ rootDir: join(root, 'home-two'), profile: 'two', appLockRoot });
      await saveRootConfig(firstPaths.configFile, {
        schemaVersion: 3,
        activeProfile: 'one',
        profiles: { one: profile },
      });
      await saveRootConfig(secondPaths.configFile, {
        schemaVersion: 3,
        activeProfile: 'two',
        profiles: { two: profile },
      });
      const first = await startChannel({
        profile,
        paths: firstPaths,
        agent,
        createChannel: () => new FakeChannel(),
      });
      await expect(
        startChannel({
          profile,
          paths: secondPaths,
          agent,
          createChannel: () => new FakeChannel(),
        }),
      ).rejects.toThrow(/cannot activate App ID cli_shared/);
      await first.disconnect();
      const second = await startChannel({
        profile,
        paths: secondPaths,
        agent,
        createChannel: () => new FakeChannel(),
      });
      await second.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects unauthorized ingress, processes commands, persists a session, and shuts down without a real connection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-'));
    try {
      const paths = resolveAppPaths({
        rootDir: root,
        profile: 'test',
        appLockRoot: join(root, 'global-app-locks'),
      });
      const cwd = await realpath(root);
      const profile = createProfileConfig({
        app: { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: cwd,
        access: { allowedUsers: ['ou_allowed'] },
        permissions: { defaultAccess: 'read-only', maxAccess: 'read-only' },
        preferences: { piConfigScope: 'user', model: 'test-provider/test-model', runIdleTimeoutMinutes: 1 },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      const runs: AgentRunOptions[] = [];
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi',
        async isAvailable() {
          return true;
        },
        setBotIdentity: vi.fn(),
        closeIdleSessions: vi.fn(async () => {}),
        run(options: AgentRunOptions): AgentRun {
          runs.push(options);
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system' as const, sessionId: `session-${runs.length}` };
                yield { type: 'text' as const, delta: 'Pi reply' };
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            stop: vi.fn(async () => {}),
            async waitForExit() {
              return true;
            },
          };
        },
      };
      let fake: FakeChannel | undefined;
      const bridge = await startChannel({
        profile,
        paths,
        agent,
        createChannel: (options) => (fake = new FakeChannel(options)),
      });
      if (!fake) {
        throw new Error('fake channel was not created');
      }
      expect(fake.connected).toBe(true);
      expect(agent.closeIdleSessions).toHaveBeenCalledOnce();
      expect(fake.options?.safety?.chatQueue).toEqual({ enabled: false });
      expect(fake.options?.keepalive?.enabled).toBe(true);
      expect(fake.options?.keepalive?.intervalMs).toBe(CHANNEL_KEEPALIVE_INTERVAL_MS);
      expect(fake.options?.handshakeTimeoutMs).toBe(15_000);
      expect(fake.options?.httpTimeoutMs).toBe(15_000);
      expect(fake.options?.wsConfig?.pingTimeout).toBe(45);
      expect(CHANNEL_RECONNECT_GRACE_MS).toBe(120_000);
      fake.connectionStatus = { state: 'failed', reconnectAttempts: 3 };
      fake.errorHandler?.(new Error('synthetic failure'));
      await expect(bridge.failure).rejects.toThrow(/不可恢复/);
      await fake.deliver({
        messageId: 'unauthorized',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_denied',
        content: 'hello',
      });
      expect(runs).toHaveLength(0);
      expect(fake.replies).toHaveLength(0);

      await fake.deliver({
        messageId: 'timeout',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/timeout 9',
      });
      expect(fake.replies.at(-1)).toContain('9 分钟');

      await fake.deliver({
        messageId: 'access-denied',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/access full',
      });
      expect(fake.replies.at(-1)).toContain('超过当前 profile 上限 read-only');

      await fake.deliver({
        messageId: 'access-read-only',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/access read-only',
      });
      expect(fake.replies.at(-1)).toContain('read-only');

      await fake.deliver({
        messageId: 'status-without-workspace',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/status',
      });
      expect(fake.replies.at(-1)).toContain('没有活跃 Pi session');

      await fake.deliver({
        messageId: 'run-one',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'hello Pi',
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]?.sessionId).toBeUndefined();
      expect(runs[0]?.accessMode).toBe('read-only');
      expect(runs[0]?.scopeId).toBe('chat');
      expect(runs[0]?.model).toBeUndefined();
      expect(runs[0]?.policyFingerprint).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(runs[0]?.prompt).toContain('<user_input>\nhello Pi\n</user_input>');
      expect(fake.replies.at(-1)).toBe('chat:Pi reply');

      await fake.deliver({
        messageId: 'run-two',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'continue',
      });
      expect(runs).toHaveLength(2);
      expect(runs[1]?.sessionId).toBe('session-1');

      await fake.deliver({
        messageId: 'new',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/new',
      });
      expect(fake.replies.at(-1)).toContain('新会话');
      await fake.deliver({
        messageId: 'run-three',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'fresh',
      });
      expect(runs).toHaveLength(3);
      expect(runs[2]?.sessionId).toBeUndefined();

      await fake.deliverComment({
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-a',
        operator: { openId: 'ou_allowed' },
        mentionedBot: true,
        timestamp: Date.now(),
      });
      expect(runs).toHaveLength(4);
      expect(runs[3]?.prompt).toContain('<bridge_comment_context>');
      expect(fake.commentReplies.at(-1)).toContain('Pi reply');

      fake.comments.fetch = async () => ({ commentId: 'comment', quote: '/new', isWhole: false, replies: [] });
      await fake.deliverComment({
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-a',
        operator: { openId: 'ou_allowed' },
        mentionedBot: true,
        timestamp: Date.now(),
      });
      expect(runs).toHaveLength(4);
      expect(fake.commentReplies.at(-1)).toContain('新会话');

      await bridge.disconnect();
      expect(fake.connected).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('controls and restores the scoped RPC model and thinking level through chat commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-model-control-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
      const profile = createProfileConfig({
        app: { id: 'cli_model_control', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: await realpath(root),
        access: { allowedUsers: ['ou_allowed'] },
        preferences: { transport: 'rpc' },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      const runs: AgentRunOptions[] = [];
      let model = { provider: 'provider-a', id: 'model-a', name: 'Model A', reasoning: true };
      let thinkingLevel: 'off' | 'medium' | 'high' = 'medium';
      const sessionState = () => ({ sessionId: 'session-model', isStreaming: false, model, thinkingLevel });
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi RPC',
        async isAvailable() {
          return true;
        },
        async getSessionState() {
          return sessionState();
        },
        async listModels() {
          return {
            state: sessionState(),
            models: [
              { provider: 'provider-a', id: 'model-a', name: 'Model A', reasoning: true },
              { provider: 'provider-a', id: 'model-b', name: 'Model B', reasoning: false },
            ],
          };
        },
        async setModel(_options, provider, id) {
          model = { provider, id, name: 'Model B', reasoning: false };
          thinkingLevel = 'off';
          return sessionState();
        },
        async listThinkingLevels() {
          return { state: sessionState(), levels: model.reasoning ? ['off', 'medium', 'high'] : ['off'] };
        },
        async setThinkingLevel(_options, level) {
          thinkingLevel = level as typeof thinkingLevel;
          return sessionState();
        },
        run(options): AgentRun {
          runs.push(options);
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system' as const, sessionId: 'session-model' };
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            async stop() {},
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      const deliver = (content: string) =>
        fake.deliver({ messageId: randomId(), chatId: 'chat', chatType: 'p2p', senderId: 'ou_allowed', content });

      await deliver('/model');
      expect(fake.replies.at(-1)).toContain('没有活跃 Pi session');
      await deliver('/model use provider-a/model-b');
      expect(fake.replies.at(-1)).toContain('请先发送一条普通消息');
      await deliver('start');
      await deliver('/model list');
      expect(fake.replies.at(-1)).toContain('provider-a/model-a');
      await deliver('/thinking list');
      expect(fake.replies.at(-1)).toContain('medium（当前）');
      await deliver('/thinking high');
      expect(fake.replies.at(-1)).toContain('已切换为 high');
      await deliver('/model use provider-a/model-b');
      expect(fake.replies.at(-1)).toContain('provider-a/model-b');
      expect(fake.replies.at(-1)).toContain('思考级别：off');
      await deliver('/thinking high');
      expect(fake.replies.at(-1)).toContain('当前模型不支持 high');
      await deliver('/status');
      expect(fake.replies.at(-1)).toContain('当前 Pi session：session-model');
      expect(fake.replies.at(-1)).toContain('模型：provider-a/model-b');
      expect(fake.replies.at(-1)).toContain('思考级别：off');
      await deliver('continue after restart');
      expect(runs.at(-1)).toMatchObject({
        sessionId: 'session-model',
        model: 'provider-a/model-b',
        thinkingLevel: 'off',
      });
      await deliver('/new');
      await deliver('fresh defaults');
      expect(runs.at(-1)?.sessionId).toBeUndefined();
      expect(runs.at(-1)?.model).toBeUndefined();
      expect(runs.at(-1)?.thinkingLevel).toBeUndefined();
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allowlists raw /pi commands and completes a private confirm card without wrapping the command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-command-ui-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
      const cwd = await realpath(root);
      const profile = createProfileConfig({
        app: { id: 'cli_pi_commands', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: cwd,
        access: { allowedUsers: ['ou_allowed'], allowedChats: ['chat-group'] },
        preferences: { transport: 'rpc' },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      const runs: AgentRunOptions[] = [];
      let interactionPort: AgentInteractionPort | undefined;
      let resolveInteraction: ((value: unknown) => void) | undefined;
      const interactionResponse = new Promise((resolve) => {
        resolveInteraction = resolve;
      });
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi RPC',
        async isAvailable() {
          return true;
        },
        setInteractionPort(port) {
          interactionPort = port;
        },
        async listCommands() {
          return [
            { name: 'plan', source: 'extension', description: 'Plan work' },
            { name: 'template', source: 'prompt', description: 'Prompt template' },
            { name: 'skill:check', source: 'skill', description: 'Skill command' },
          ];
        },
        run(options): AgentRun {
          runs.push(options);
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system' as const, sessionId: 'pi-command-session' };
                const response = await interactionPort?.handle(
                  {
                    runId: options.runId,
                    scopeId: options.scopeId!,
                    actorOpenId: options.interaction!.actorOpenId,
                    surface: options.interaction!.surface,
                    privateReplyTarget: options.interaction!.privateReplyTarget,
                  },
                  { method: 'confirm', title: 'Confirm plan', message: 'Proceed?' },
                );
                resolveInteraction?.(response);
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            async stop() {
              interactionPort?.cancelRun(options.runId);
            },
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      await fake.deliver({
        messageId: 'list',
        chatId: 'chat-dm',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/pi commands',
      });
      expect(fake.replies.at(-1)).toContain('/plan [extension] — Plan work');
      expect(fake.replies.at(-1)).not.toContain('sourceInfo');

      await fake.deliver({
        messageId: 'unknown',
        chatId: 'chat-dm',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/pi /login',
      });
      expect(runs).toHaveLength(0);
      expect(fake.replies.at(-1)).toContain('Pi 未公开命令 /login');

      const running = fake.deliver({
        messageId: 'run-command',
        chatId: 'chat-group',
        chatType: 'group',
        senderId: 'ou_allowed',
        content: '/pi /plan keep  two spaces',
      });
      await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
      expect(runs[0]).toMatchObject({
        prompt: '/plan keep  two spaces',
        promptMode: 'pi-command',
        scopeId: 'chat-group',
        interaction: { actorOpenId: 'ou_allowed', surface: 'group' },
      });
      expect(runs[0]?.prompt).not.toContain('<user_input>');
      expect('card' in fake.sent[0]!.input).toBe(true);
      expect(fake.replies).toContain('Pi 正在等待你在私聊中完成交互。');
      const card = (fake.sent[0]!.input as { card: unknown }).card;
      const token = findCardToken(card);
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(JSON.stringify(card)).not.toContain('Pi request');
      const wrongActor = await fake.deliverCardAction(
        cardAction(token, 'ou_other', { action: 'confirm', method: 'confirm' }),
      );
      expect(wrongActor).toEqual({ toast: { type: 'error', content: '只有发起该 Pi 请求的用户可以操作。' } });
      const accepted = await fake.deliverCardAction(
        cardAction(token, 'ou_allowed', { action: 'confirm', method: 'confirm' }),
      );
      expect(accepted).toEqual({ toast: { type: 'success', content: '已确认。' } });
      await running;
      await expect(interactionResponse).resolves.toEqual({ confirmed: true });
      const replay = await fake.deliverCardAction(
        cardAction(token, 'ou_allowed', { action: 'confirm', method: 'confirm' }),
      );
      expect(replay).toEqual({ toast: { type: 'warning', content: '该交互已过期或已经处理。' } });
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cancels a pending private interaction when the channel disconnects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-ui-disconnect-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
      const cwd = await realpath(root);
      const profile = createProfileConfig({
        app: { id: 'cli_ui_disconnect', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: cwd,
        access: { allowedUsers: ['ou_allowed'] },
        preferences: { transport: 'rpc' },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      let interactionPort: AgentInteractionPort | undefined;
      let resolveInteraction!: (value: unknown) => void;
      const interactionResponse = new Promise((resolve) => {
        resolveInteraction = resolve;
      });
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi RPC',
        async isAvailable() {
          return true;
        },
        setInteractionPort(port) {
          interactionPort = port;
        },
        run(options): AgentRun {
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system' as const, sessionId: 'pending-ui-session' };
                const response = await interactionPort?.handle(
                  {
                    runId: options.runId,
                    scopeId: options.scopeId!,
                    actorOpenId: options.interaction!.actorOpenId,
                    surface: options.interaction!.surface,
                    privateReplyTarget: options.interaction!.privateReplyTarget,
                  },
                  { method: 'confirm', title: 'Confirm', message: 'Proceed?' },
                );
                resolveInteraction(response);
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            async stop() {
              interactionPort?.cancelRun(options.runId);
            },
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      const running = fake.deliver({
        messageId: 'pending-ui',
        chatId: 'chat-dm',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'ask for confirmation',
      });
      await vi.waitFor(() => expect(fake.replies).toContain('[non-text reply]'));
      await bridge.disconnect();
      await expect(interactionResponse).resolves.toEqual({ cancelled: true });
      await running;
      expect(fake.connected).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rereads workspace state per ingress, isolates sessions, and never exposes local paths in command replies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-workspaces-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
      const alpha = join(root, 'alpha');
      const beta = join(root, 'beta');
      const moved = join(root, 'moved');
      const temporary = join(root, 'temporary');
      await Promise.all([alpha, beta, moved, temporary].map((path) => mkdir(path)));
      const profile = createProfileConfig({
        app: { id: 'cli_workspaces', secret: '${TEST_SECRET}', tenant: 'feishu' },
        access: { allowedUsers: ['ou_user'], admins: ['ou_admin'] },
        workspaces: { defaultAlias: 'alpha', named: { alpha, beta } },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      const runs: AgentRunOptions[] = [];
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi',
        async isAvailable() {
          return true;
        },
        run(options): AgentRun {
          runs.push(options);
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'system' as const, sessionId: `session-${runs.length}` };
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            async stop() {},
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      const deliver = (content: string, senderId = 'ou_user') =>
        fake.deliver({ messageId: randomId(), chatId: 'chat', chatType: 'p2p', senderId, content });

      await deliver('/workspace');
      expect(fake.replies.at(-1)).toContain('alpha');
      expect(fake.replies.at(-1)).toContain('profile 默认');
      await deliver('/workspace list');
      expect(fake.replies.at(-1)).toContain('alpha [current, default]');
      await deliver('/workspace use beta');
      await deliver('beta turn');
      expect(runs.at(-1)?.cwd).toBe(await realpath(beta));
      const betaSession = 'session-1';

      await setWorkspace(paths, { alias: 'beta', path: moved });
      await deliver('moved turn');
      expect(runs.at(-1)?.cwd).toBe(await realpath(moved));
      expect(runs.at(-1)?.sessionId).toBeUndefined();
      await setWorkspace(paths, { alias: 'beta', path: beta });
      await deliver('return turn');
      expect(runs.at(-1)?.cwd).toBe(await realpath(beta));
      expect(runs.at(-1)?.sessionId).toBe(betaSession);

      await deliver('/workspace default set beta');
      expect(fake.replies.at(-1)).toContain('只有 profile 管理员');
      await deliver('/workspace default set beta', 'ou_admin');
      expect(fake.replies.at(-1)).toContain('默认 workspace 已设置为「beta」');
      await deliver('/workspace use default');
      await deliver('/workspace current');
      expect(fake.replies.at(-1)).toContain('profile 默认');
      expect(fake.replies.at(-1)).toContain('beta');

      await setDefaultWorkspace(paths, 'alpha');
      await deliver('/workspace use beta');
      await removeWorkspace(paths, 'beta');
      const beforeMissing = runs.length;
      await deliver('must not silently fall back');
      expect(runs).toHaveLength(beforeMissing);
      expect(fake.replies.at(-1)).toContain('alias 不存在：beta');

      await setWorkspace(paths, { alias: 'temporary', path: temporary });
      await deliver('/workspace use temporary');
      await rm(temporary, { recursive: true });
      const beforeUnavailable = runs.length;
      await deliver('unavailable');
      expect(runs).toHaveLength(beforeUnavailable);
      expect(fake.replies.at(-1)).toContain('目录不可用');

      await deliver('/unknown-command');
      expect(fake.replies.at(-1)).toContain('未知 bridge 命令');
      expect(runs).toHaveLength(beforeUnavailable);
      expect(fake.replies.join('\n')).not.toContain(root);

      fake.comments.fetch = async () => ({
        commentId: 'comment',
        quote: '/workspace use alpha',
        isWhole: false,
        replies: [],
      });
      await fake.deliverComment({
        fileToken: 'doc-token',
        fileType: 'docx',
        commentId: 'comment-workspace',
        operator: { openId: 'ou_user' },
        mentionedBot: true,
        timestamp: Date.now(),
      });
      expect(fake.commentReplies.at(-1)).toContain('固定使用 profile 默认 workspace');
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows unmentioned messages only in explicitly exempted authorized groups', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-mention-policy-'));
    try {
      const paths = resolveAppPaths({ rootDir: root, profile: 'test', appLockRoot: join(root, 'app-locks') });
      const profile = createProfileConfig({
        app: { id: 'cli_mention_policy', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: await realpath(root),
        access: {
          allowedChats: ['oc_quiet', 'oc_active'],
          mentionOptionalChats: ['oc_active'],
        },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      const runs: AgentRunOptions[] = [];
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi',
        async isAvailable() {
          return true;
        },
        run(options): AgentRun {
          runs.push(options);
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'done' as const, terminationReason: 'normal' as const };
              },
            },
            async stop() {},
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      await fake.deliver({
        messageId: 'quiet-unmentioned',
        chatId: 'oc_quiet',
        chatType: 'group',
        senderId: 'ou_member',
        content: 'ignore me',
        mentionedBot: false,
      });
      expect(runs).toHaveLength(0);
      await fake.deliver({
        messageId: 'active-unmentioned',
        chatId: 'oc_active',
        chatType: 'group',
        senderId: 'ou_member',
        content: 'run me',
        mentionedBot: false,
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ scopeId: 'oc_active' });
      await fake.deliver({
        messageId: 'quiet-mentioned',
        chatId: 'oc_quiet',
        chatType: 'group',
        senderId: 'ou_member',
        content: 'run me too',
        mentionedBot: true,
      });
      expect(runs).toHaveLength(2);
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('lets /stop bypass an in-flight message while RunExecutor retains per-scope exclusion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-pi-channel-stop-'));
    try {
      const paths = resolveAppPaths({
        rootDir: root,
        profile: 'test',
        appLockRoot: join(root, 'global-app-locks'),
      });
      const cwd = await realpath(root);
      const profile = createProfileConfig({
        app: { id: 'cli_test', secret: '${TEST_SECRET}', tenant: 'feishu' },
        workspace: cwd,
        access: { allowedUsers: ['ou_allowed'] },
      });
      await saveRootConfig(paths.configFile, { schemaVersion: 3, activeProfile: 'test', profiles: { test: profile } });
      let releaseEvents: (() => void) | undefined;
      let stopped = false;
      const stop = vi.fn(async () => {
        stopped = true;
        releaseEvents?.();
      });
      const agent: AgentAdapter = {
        id: 'pi',
        displayName: 'Pi',
        async isAvailable() {
          return true;
        },
        run(options: AgentRunOptions): AgentRun {
          return {
            runId: options.runId,
            events: {
              async *[Symbol.asyncIterator]() {
                await new Promise<void>((resolve) => {
                  releaseEvents = resolve;
                });
                yield {
                  type: 'done' as const,
                  terminationReason: stopped ? ('interrupted' as const) : ('normal' as const),
                };
              },
            },
            stop,
            async waitForExit() {
              return true;
            },
          };
        },
      };
      const fake = new FakeChannel();
      const bridge = await startChannel({ profile, paths, agent, createChannel: () => fake });
      const running = fake.deliver({
        messageId: 'run',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'long request',
      });
      await vi.waitFor(() => expect(releaseEvents).toBeTypeOf('function'));
      await fake.deliver({
        messageId: 'busy',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: 'second ordinary prompt',
      });
      expect(fake.replies.at(-1)).toBe('当前话题已有 Pi 运行。请等待完成，或使用 /steer、/follow-up、/stop。');
      await fake.deliver({
        messageId: 'stop',
        chatId: 'chat',
        chatType: 'p2p',
        senderId: 'ou_allowed',
        content: '/stop',
      });
      expect(stop).toHaveBeenCalledWith('interrupted');
      expect(fake.replies).toContain('已请求停止当前 Pi 运行。');
      await running;
      await bridge.disconnect();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
