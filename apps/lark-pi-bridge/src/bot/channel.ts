import { randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import {
  createLarkChannel,
  type CardActionEvent,
  type CardActionResponse,
  type CommentEvent,
  type LarkChannel,
  type NormalizedMessage,
  type SendInput,
  type SendOptions,
  type WSConnectionStatus,
} from '@larksuite/channel';
import type { AgentAdapter } from '../agent/types.js';
import type { AppPaths } from '../config/app-paths.js';
import { clampAccess } from '../config/permissions.js';
import type { ProfileConfig, ProfileWorkspaces } from '../config/profile-schema.js';
import { loadProfileWorkspaces, setDefaultWorkspace } from '../config/profile-management.js';
import { larkSdkLogger, log } from '../core/logger.js';
import { resolveAppSecret } from '../config/store.js';
import {
  applySessionCommand,
  parseBridgeCommand,
  type BridgeCommand,
  type WorkspaceBridgeCommand,
} from '../commands/index.js';
import { streamAgentReply } from '../card/stream-reply.js';
import { TextReplyRenderer } from '../card/text-renderer.js';
import { AttachmentStore } from '../media/attachments.js';
import { policyFingerprint } from '../policy/fingerprint.js';
import { inspectWorkspaceRegistry, resolveEffectiveWorkspace } from '../policy/workspace.js';
import { runtimeProfileModel } from '../runtime/agent-runtime.js';
import type { AtomicFileHooks } from '../runtime/atomic-json-file.js';
import { acquireRuntimeLock, type AcquiredRuntimeLock } from '../runtime/locks.js';
import { ProcessPoolFullError, RunExecutor, ScopeBusyError, type ScopeLease } from '../runtime/run-executor.js';
import { stopAfterIdle } from '../runtime/timeout.js';
import { SessionCatalog } from '../session/catalog.js';
import { pruneSessions, SESSION_STORAGE_SOFT_LIMIT_BYTES } from '../session/retention.js';
import { ScopeSettingsStore } from '../session/scope-settings.js';
import { HandoffBindingStore, type HandoffBinding } from '../session/handoff-store.js';
import {
  currentFileIdentity,
  HandoffLocatorError,
  locateHandoffSession,
  removeOwnedForkSession,
  safeCwdDirectoryName,
  sameFileIdentity,
  snapshotProfileSessionDirectory,
  trustedPiSessionRoots,
  validateProfileForkSession,
} from '../session/handoff.js';
import { LarkInteractionBroker } from './interaction-broker.js';

const MAX_COMMENT_REPLY_CHARS = 12_000;
export const CHANNEL_KEEPALIVE_INTERVAL_MS = 20_000;
export const CHANNEL_RECONNECT_GRACE_MS = 2 * 60_000;
export const SESSION_RETENTION_INTERVAL_MS = 24 * 60 * 60_000;

export interface ChannelPort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus?(): WSConnectionStatus | undefined;
  getBotIdentity(): { openId: string; name?: string };
  on(handlers: {
    message?: (message: NormalizedMessage) => Promise<void>;
    comment?: (comment: CommentEvent) => Promise<void>;
    cardAction?: (event: CardActionEvent) => CardActionResponse | Promise<CardActionResponse | void> | void;
    error?: (error: Error) => void;
    reconnecting?: () => void;
    reconnected?: () => void;
  }): unknown;
  send(to: string, input: SendInput, options?: SendOptions): Promise<unknown>;
  reply(
    message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
    input: SendInput,
    options?: SendOptions,
  ): Promise<unknown>;
  stream: LarkChannel['stream'];
  fetchMessage(messageId: string): Promise<NormalizedMessage | undefined>;
  downloadResourceWithMeta: LarkChannel['downloadResourceWithMeta'];
  comments: Pick<LarkChannel['comments'], 'resolveTarget' | 'fetch' | 'reply'>;
}

export interface StartChannelDeps {
  profile: ProfileConfig;
  paths: AppPaths;
  agent: AgentAdapter;
  /** Tests can inject a channel-shaped fake; production uses @larksuite/channel. */
  createChannel?: (options: Parameters<typeof createLarkChannel>[0]) => ChannelPort;
  /** Test-only bounded source roots; production derives trusted Pi roots. */
  handoffRoots?: readonly string[];
  /** Test-only pre-commit failure injection for persistence transactions. */
  persistenceHooks?: { catalog?: AtomicFileHooks; settings?: AtomicFileHooks; handoffs?: AtomicFileHooks };
}

export interface BridgeChannel {
  channel: ChannelPort;
  activity(): { active: number; starting: number; scopes: string[] };
  health(): { channel?: WSConnectionStatus; lastInboundTime?: number; failed: boolean };
  /** Rejects only when the channel can no longer recover its connection. */
  failure: Promise<never>;
  /** Stop accepting ingress and atomically report whether rebuilding is safe. */
  quiesce(): { active: number; starting: number; scopes: string[] };
  resume(): void;
  disconnect(): Promise<void>;
}

export function channelPolicy(profile: ProfileConfig): {
  dmMode: 'open' | 'allowlist';
  dmAllowlist?: string[];
  groupAllowlist?: string[];
  requireMention: boolean;
  respondToMentionAll: boolean;
  botLoopGuard: { enabled: true; onTrip: 'reject' };
} {
  return {
    dmMode: profile.mode === 'team' ? 'open' : 'allowlist',
    dmAllowlist:
      profile.mode === 'team' ? undefined : unique([...profile.access.allowedUsers, ...profile.access.admins]),
    groupAllowlist: profile.mode === 'team' ? undefined : profile.access.allowedChats,
    // Per-chat mention exceptions are enforced below after normalization. The
    // SDK gate must pass authorized unmentioned group events through first.
    requireMention: profile.access.requireMentionInGroup && profile.access.mentionOptionalChats.length === 0,
    respondToMentionAll: false,
    botLoopGuard: { enabled: true, onTrip: 'reject' },
  };
}

/**
 * Lark ingress is intentionally thin: it only handles regular IM messages.
 * Access checks and Lark app credential use stay at the channel boundary; Pi
 * receives only a constructed prompt and never the App Secret.
 */
export async function startChannel(deps: StartChannelDeps): Promise<BridgeChannel> {
  const { profile, paths, agent } = deps;
  const create = deps.createChannel ?? createLarkChannel;
  const catalog = new SessionCatalog(paths.sessionCatalogFile, deps.persistenceHooks?.catalog);
  await catalog.load();
  const scopeSettings = new ScopeSettingsStore(paths.scopeSettingsFile, deps.persistenceHooks?.settings);
  await scopeSettings.load();
  const handoffs = new HandoffBindingStore(paths.handoffBindingsFile, deps.persistenceHooks?.handoffs);
  await handoffs.load();
  const executor = new RunExecutor(agent, profile.preferences.maxConcurrentRuns ?? 10);
  const attachments = new AttachmentStore(paths.mediaDir);
  const appSecret = await resolveAppSecret(profile.accounts.app, paths.configFile, paths.profileDir);
  let appLock: AcquiredRuntimeLock | undefined;
  let accepting = true;
  let ingress = 0;
  let lastInboundTime: number | undefined;
  let failed = false;
  let rejectFailure: ((error: Error) => void) | undefined;
  let reconnectDeadline: NodeJS.Timeout | undefined;
  let retentionTimer: NodeJS.Timeout | undefined;
  let retentionTask: Promise<void> | undefined;
  let shuttingDown = false;
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  // The process-level owner observes this promise. Keep it handled while
  // startChannel is still acquiring resources so a synchronous SDK callback
  // cannot become an unhandled rejection.
  void failure.catch(() => {});
  const fail = (error: unknown): void => {
    if (!rejectFailure) {
      return;
    }
    const reject = rejectFailure;
    rejectFailure = undefined;
    failed = true;
    reject(error instanceof Error ? error : new Error(String(error)));
  };
  const clearReconnectDeadline = (): void => {
    if (reconnectDeadline) {
      clearTimeout(reconnectDeadline);
      reconnectDeadline = undefined;
    }
  };
  const runSessionRetention = (): Promise<void> => {
    if (retentionTask) {
      return retentionTask;
    }
    if (!profile.preferences.sessionRetention.enabled) {
      return Promise.resolve();
    }
    const activity = executor.activity();
    if (activity.active || activity.starting || ingress) {
      log.info('session', 'retention-skipped-busy', {
        active: activity.active,
        starting: activity.starting,
        ingress,
      });
      return Promise.resolve();
    }
    accepting = false;
    const task = (async () => {
      try {
        await agent.closeIdleSessions?.();
        const latestActivity = executor.activity();
        if (latestActivity.active || latestActivity.starting || ingress) {
          return;
        }
        const summary = await pruneSessions({
          sessionDir: paths.piSessionDir,
          catalogFile: paths.sessionCatalogFile,
          policy: profile.preferences.sessionRetention,
          dryRun: false,
        });
        log.info('session', 'retention-complete', { ...summary });
        if (summary.softLimitExceeded) {
          log.warn('session', 'storage-soft-limit-exceeded', {
            storedBytes: summary.remainingBytes,
            softLimitBytes: SESSION_STORAGE_SOFT_LIMIT_BYTES,
          });
        }
        await catalog.load();
      } catch (error) {
        log.warn('session', 'retention-failed', { message: error instanceof Error ? error.message : String(error) });
      } finally {
        if (!failed && !shuttingDown) {
          accepting = true;
        }
      }
    })();
    retentionTask = task;
    void task.then(() => {
      if (retentionTask === task) {
        retentionTask = undefined;
      }
    });
    return task;
  };
  const channel = create({
    appId: profile.accounts.app.id,
    appSecret,
    domain: profile.accounts.app.tenant === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn',
    source: 'lark-pi-bridge',
    logger: larkSdkLogger,
    policy: channelPolicy(profile),
    // The SDK queue awaits the full message handler, which would place /stop
    // behind the active Pi run. Keep SDK policy/dedup/stale checks but let the
    // bridge RunExecutor own per-scope concurrency so control commands can
    // reach and interrupt an in-flight child immediately.
    safety: { chatQueue: { enabled: false } },
    outbound: { allowedFileDirs: [paths.mediaDir] },
    resolveChatMode: true,
    // A healthy tick is an in-memory status read. At 20 seconds the watchdog
    // remains below the SDK's 30-second sleep detector while taking about one
    // minute (three failed ticks) to force a reconnect.
    keepalive: {
      enabled: true,
      intervalMs: CHANNEL_KEEPALIVE_INTERVAL_MS,
      onUnrecoverable: (error) => fail(new Error('飞书长连接无法恢复', { cause: error })),
    },
    // The SDK's independent pong watchdog catches a socket that remains OPEN
    // locally but no longer receives frames after sleep/NAT/network changes.
    wsConfig: { pingTimeout: 45 },
    handshakeTimeoutMs: 15_000,
    httpTimeoutMs: 15_000,
  }) as ChannelPort;
  const interactionBroker = new LarkInteractionBroker(channel);
  agent.setInteractionPort?.(interactionBroker);

  channel.on({
    error: (error) => {
      log.error('channel', 'transport-error', { message: error.message });
      if (channel.getConnectionStatus?.()?.state === 'failed') {
        fail(new Error('飞书长连接进入不可恢复状态', { cause: error }));
      }
    },
    reconnecting: () => {
      const status = channel.getConnectionStatus?.();
      log.warn('channel', 'reconnecting', {
        state: status?.state,
        reconnectAttempts: status?.reconnectAttempts,
      });
      if (!reconnectDeadline) {
        reconnectDeadline = setTimeout(() => {
          reconnectDeadline = undefined;
          const latest = channel.getConnectionStatus?.();
          if (latest?.state !== 'connected') {
            fail(
              new Error(
                `飞书长连接在 ${CHANNEL_RECONNECT_GRACE_MS / 1_000} 秒内未恢复（state=${latest?.state ?? 'unknown'}）`,
              ),
            );
          }
        }, CHANNEL_RECONNECT_GRACE_MS);
        reconnectDeadline.unref();
      }
    },
    reconnected: () => {
      clearReconnectDeadline();
      const status = channel.getConnectionStatus?.();
      log.info('channel', 'reconnected', {
        state: status?.state,
        reconnectAttempts: status?.reconnectAttempts,
      });
    },
    message: async (message) => {
      lastInboundTime = Date.now();
      if (!accepting) {
        await channel.reply(message, { text: 'bridge 正在刷新配置，请稍后重试。' }).catch(() => {});
        return;
      }
      ingress += 1;
      try {
        if (!allowed(profile, message.senderId, message.chatId, message.chatType)) {
          return;
        }
        if (!mentionAllowed(profile, message)) {
          return;
        }
        const command = parseBridgeCommand(message.content);
        if (command?.type === 'invalid' && command.command.toLowerCase() === '/handoff') {
          await channel.reply(message, { text: command.message }, { replyInThread: true });
          return;
        }
        if (command?.type === 'handoff') {
          await handleHandoffCommand({
            channel,
            message,
            command,
            executor,
            catalog,
            scopeSettings,
            handoffs,
            paths,
            roots: deps.handoffRoots,
          });
          return;
        }
        if (command?.type === 'handoff-off' && !message.threadId) {
          await channel.reply(message, { text: '/handoff off 必须在 handoff 话题内执行。' }, { replyInThread: true });
          return;
        }
        const scopeId = message.threadId ? `${message.chatId}:${message.threadId}` : message.chatId;
        const handoff = await handoffs.getLatest(scopeId);
        await scopeSettings.getLatest(scopeId);
        const workspaces = await loadProfileWorkspaces(paths);
        if (command?.type === 'invalid') {
          await channel.reply(message, { text: command.message });
          return;
        }
        if (isWorkspaceCommand(command)) {
          if (handoff && executor.isScopeBusy(scopeId)) {
            await channel.reply(message, { text: runStartErrorText(new ScopeBusyError(scopeId)) });
            return;
          }
          await handleWorkspaceCommand({
            channel,
            message,
            command,
            workspaces,
            scopeId,
            scopeSettings,
            profile,
            paths,
            handoff,
            handoffs,
            catalog,
            executor,
          });
          return;
        }
        if (
          handoff &&
          (command?.type === 'stop' ||
            command?.type === 'steer' ||
            command?.type === 'follow-up' ||
            command?.type === 'timeout' ||
            command?.type === 'new' ||
            command?.type === 'resume' ||
            command?.type === 'handoff-off') &&
          executor.isScopeBusy(scopeId) &&
          command.type !== 'stop' &&
          command.type !== 'steer' &&
          command.type !== 'follow-up'
        ) {
          await channel.reply(message, { text: runStartErrorText(new ScopeBusyError(scopeId)) });
          return;
        }
        if (command?.type === 'stop') {
          const result = await executor.stop(scopeId);
          await channel.reply(message, {
            text:
              result === 'stopped'
                ? '已请求停止当前 Pi 运行。'
                : result === 'starting'
                  ? '当前 scope 正在执行不可取消的启动或 handoff 操作；未声称停止，请稍后重试。'
                  : '当前 scope 没有活跃 Pi 运行。',
          });
          return;
        }
        if (command?.type === 'steer' || command?.type === 'follow-up') {
          try {
            const disposition = await executor.control(scopeId, command.type, command.prompt);
            await channel.reply(message, {
              text:
                disposition === 'queued'
                  ? `已将 ${command.type} 消息加入当前 RPC 运行。`
                  : `当前 RPC ${command.type} 消息已处理。`,
            });
          } catch (error) {
            await channel.reply(message, {
              text: error instanceof Error ? error.message : '当前无法处理 RPC 控制命令。',
            });
          }
          return;
        }
        if (command?.type === 'timeout') {
          await executor.withScopeLease(scopeId, () =>
            scopeSettings.update(scopeId, { idleTimeoutMinutes: command.minutes }),
          );
          await channel.reply(message, { text: `当前 scope 的 idle timeout 已设置为 ${command.minutes} 分钟。` });
          return;
        }
        const savedSettings = scopeSettings.get(scopeId);
        const normalWorkspace = handoff
          ? undefined
          : await resolveEffectiveWorkspace(workspaces, savedSettings?.workspaceAlias);
        if (normalWorkspace && !normalWorkspace.ok) {
          await channel.reply(message, { text: normalWorkspace.message });
          return;
        }
        if (command?.type === 'access') {
          if (handoff) {
            await channel.reply(message, { text: 'handoff 固定使用 full tools + --approve；/access 不会修改该策略。' });
            return;
          }
          const accessMode = clampAccess(command.accessMode, profile.permissions.maxAccess);
          if (accessMode !== command.accessMode) {
            await channel.reply(message, {
              text: `请求的访问模式超过当前 profile 上限 ${profile.permissions.maxAccess}。`,
            });
            return;
          }
          await executor.withScopeLease(scopeId, () =>
            scopeSettings.update(scopeId, { accessMode, model: undefined, thinkingLevel: undefined }),
          );
          await channel.reply(message, { text: `当前 scope 的访问模式已设置为 ${accessMode}。` });
          return;
        }
        if (isModelThinkingCommand(command) || command?.type === 'status') {
          await executor.withScopeLease(scopeId, async (lease) => {
            const latestHandoff = await handoffs.getLatest(scopeId);
            const latestSettings = await scopeSettings.getLatest(scopeId);
            const latestWorkspaces = await loadProfileWorkspaces(paths);
            const latestWorkspace = latestHandoff
              ? { ok: true as const, cwdRealpath: latestHandoff.cwdRealpath }
              : await resolveEffectiveWorkspace(latestWorkspaces, latestSettings?.workspaceAlias);
            if (!latestWorkspace.ok) {
              throw new Error(latestWorkspace.message);
            }
            const latestAccess = latestHandoff
              ? ('full' as const)
              : clampAccess(
                  latestSettings?.accessMode ?? profile.permissions.defaultAccess,
                  profile.permissions.maxAccess,
                );
            const latestIdentity = {
              scopeId,
              cwdRealpath: latestWorkspace.cwdRealpath,
              policyFingerprint: policyFingerprint({
                cwdRealpath: latestWorkspace.cwdRealpath,
                accessMode: latestAccess,
                profile: paths.profile,
                scopeId,
              }),
            };
            await handleModelThinkingCommand({
              command,
              reply: (text) => channel.reply(message, { text }),
              executor: lease,
              catalog,
              identity: latestIdentity,
              scopeId,
              workspace: latestWorkspace.cwdRealpath,
              accessMode: latestAccess,
              profile,
              scopeSettings,
              handoff: latestHandoff,
            });
          });
          return;
        }
        if (command?.type === 'pi-commands' || command?.type === 'pi-command') {
          await executor.withScopeLease(scopeId, async (lease) => {
            const latestHandoff = await handoffs.getLatest(scopeId);
            const latestSettings = await scopeSettings.getLatest(scopeId);
            const latestWorkspaces = await loadProfileWorkspaces(paths);
            const latestWorkspace = latestHandoff
              ? { ok: true as const, cwdRealpath: latestHandoff.cwdRealpath }
              : await resolveEffectiveWorkspace(latestWorkspaces, latestSettings?.workspaceAlias);
            if (!latestWorkspace.ok) {
              throw new Error(latestWorkspace.message);
            }
            const latestAccess = latestHandoff
              ? ('full' as const)
              : clampAccess(
                  latestSettings?.accessMode ?? profile.permissions.defaultAccess,
                  profile.permissions.maxAccess,
                );
            const latestIdentity = {
              scopeId,
              cwdRealpath: latestWorkspace.cwdRealpath,
              policyFingerprint: policyFingerprint({
                cwdRealpath: latestWorkspace.cwdRealpath,
                accessMode: latestAccess,
                profile: paths.profile,
                scopeId,
              }),
            };
            await handlePiCommand({
              command,
              channel,
              message,
              executor: lease,
              catalog,
              handoffs,
              identity: latestIdentity,
              scopeId,
              workspace: latestWorkspace.cwdRealpath,
              accessMode: latestAccess,
              profile,
              handoff: latestHandoff,
              actorOpenId: message.senderId,
              surface:
                message.chatType === 'p2p'
                  ? 'p2p'
                  : message.threadId || message.chatMode === 'topic'
                    ? 'topic'
                    : 'group',
            });
          });
          return;
        }
        if (command) {
          if (command.type === 'handoff-off') {
            if (handoff) {
              await executor.withScopeLease(scopeId, () =>
                exitHandoffTransaction({
                  binding: handoff,
                  profile: paths.profile,
                  scopeId,
                  catalog,
                  handoffs,
                  scopeSettings,
                }),
              );
            }
            await channel.reply(message, {
              text: handoff ? '已退出 handoff；fork 已归档但未删除。' : '当前话题没有 handoff。',
            });
            return;
          }
          const response = await executor.withScopeLease(scopeId, async () => {
            const latestHandoff = await handoffs.getLatest(scopeId);
            const latestSettings = await scopeSettings.getLatest(scopeId);
            const latestWorkspaces = await loadProfileWorkspaces(paths);
            const latestWorkspace = latestHandoff
              ? { ok: true as const, cwdRealpath: latestHandoff.cwdRealpath }
              : await resolveEffectiveWorkspace(latestWorkspaces, latestSettings?.workspaceAlias);
            if (!latestWorkspace.ok) {
              throw new Error(latestWorkspace.message);
            }
            const latestAccess = latestHandoff
              ? ('full' as const)
              : clampAccess(
                  latestSettings?.accessMode ?? profile.permissions.defaultAccess,
                  profile.permissions.maxAccess,
                );
            const latestIdentity = {
              scopeId,
              cwdRealpath: latestWorkspace.cwdRealpath,
              policyFingerprint: policyFingerprint({
                cwdRealpath: latestWorkspace.cwdRealpath,
                accessMode: latestAccess,
                profile: paths.profile,
                scopeId,
              }),
            };
            if (command.type === 'new') {
              const previousCatalog = catalog.activeFor(latestIdentity);
              const previousSettings = scopeSettings.get(scopeId);
              const previousBinding = latestHandoff;
              try {
                await catalog.archive(latestIdentity);
                await scopeSettings.update(scopeId, { model: undefined, thinkingLevel: undefined });
              } catch (error) {
                const restored = await Promise.allSettled([
                  catalog.restore(previousCatalog, latestIdentity),
                  scopeSettings.restore(scopeId, previousSettings),
                  previousBinding ? handoffs.restore(scopeId, previousBinding) : Promise.resolve(),
                ]);
                if (restored.some((result) => result.status === 'rejected')) {
                  log.error('session-control', 'new-rollback-failed', {});
                }
                throw error;
              }
              return '已创建新会话；下一条消息不会恢复此前的 Pi session。';
            }
            return applySessionCommand(command, catalog, latestIdentity);
          });
          if (response) {
            await channel.reply(message, {
              text:
                command.type === 'new' && handoff
                  ? '已归档当前 handoff fork；下一条消息将在相同 source cwd、用户 Pi config、full + approve 策略下创建新 session。'
                  : response,
            });
          }
          return;
        }
        const images = message.resources.filter((resource) => resource.type === 'image');
        const attachmentRunId = randomUUID();
        try {
          const storedAttachments = await attachments.downloadRun(
            attachmentRunId,
            images.map((image) => ({ messageId: message.messageId, fileKey: image.fileKey, type: 'image' as const })),
            (messageId, fileKey, type) => channel.downloadResourceWithMeta(messageId, fileKey, type),
          );
          const routed = await executor.withScopeLease(scopeId, async (lease) => {
            const latestHandoff = await handoffs.getLatest(scopeId);
            const latestSettings = await scopeSettings.getLatest(scopeId);
            const latestWorkspaces = await loadProfileWorkspaces(paths);
            const latestWorkspace = latestHandoff
              ? { ok: true as const, cwdRealpath: latestHandoff.cwdRealpath }
              : await resolveEffectiveWorkspace(latestWorkspaces, latestSettings?.workspaceAlias);
            if (!latestWorkspace.ok) {
              throw new Error(latestWorkspace.message);
            }
            const latestAccess = latestHandoff
              ? ('full' as const)
              : clampAccess(
                  latestSettings?.accessMode ?? profile.permissions.defaultAccess,
                  profile.permissions.maxAccess,
                );
            const latestIdentity = {
              scopeId,
              cwdRealpath: latestWorkspace.cwdRealpath,
              policyFingerprint: policyFingerprint({
                cwdRealpath: latestWorkspace.cwdRealpath,
                accessMode: latestAccess,
                profile: paths.profile,
                scopeId,
              }),
            };
            const previous = catalog.activeFor(latestIdentity);
            const execution = await lease.submit({
              scopeId,
              policyFingerprint: latestIdentity.policyFingerprint,
              cwd: latestWorkspace.cwdRealpath,
              accessMode: latestAccess,
              handoff: latestHandoff ? { sourceSessionId: latestHandoff.sourceSessionId } : undefined,
              sessionId: previous?.sessionId,
              model: previous ? latestSettings?.model : (latestSettings?.model ?? runtimeProfileModel(profile)),
              thinkingLevel: latestSettings?.thinkingLevel,
              stopGraceMs: profile.preferences.agentStopGraceMs,
              attachments: storedAttachments.map((attachment) => attachment.path),
              interaction: {
                actorOpenId: message.senderId,
                surface:
                  message.chatType === 'p2p'
                    ? 'p2p'
                    : message.threadId || message.chatMode === 'topic'
                      ? 'topic'
                      : 'group',
                privateReplyTarget: replyTarget(message),
              },
              prompt: buildPrompt(message),
            });
            return {
              execution,
              identity: latestIdentity,
              timeoutMinutes: latestSettings?.idleTimeoutMinutes ?? profile.preferences.runIdleTimeoutMinutes,
            };
          });
          const timeout = routed.timeoutMinutes
            ? stopAfterIdle(routed.execution.run, routed.timeoutMinutes)
            : undefined;
          try {
            const events = persistSessionEvents(
              routed.execution.events,
              catalog,
              routed.identity,
              () => timeout?.touch(),
              latestSessionIdUpdater(handoffs, scopeId),
            );
            await streamAgentReply(channel, message, events, profile.preferences.showToolCalls === true);
          } finally {
            timeout?.clear();
          }
        } finally {
          await attachments.release(attachmentRunId).catch(() => {});
        }
      } catch (error) {
        log.error('channel', 'message-run-failed', { message: error instanceof Error ? error.message : String(error) });
        await channel.reply(message, { text: runStartErrorText(error) }).catch(() => {});
      } finally {
        ingress -= 1;
      }
    },
    cardAction: (event) => {
      lastInboundTime = Date.now();
      return interactionBroker.handleCardAction(event);
    },
    comment: async (comment) => {
      lastInboundTime = Date.now();
      if (!accepting) {
        return;
      }
      ingress += 1;
      try {
        await handleComment(channel, comment, profile, paths, agent, catalog, scopeSettings, executor);
      } catch (error) {
        log.error('channel', 'comment-run-failed', { message: error instanceof Error ? error.message : String(error) });
        const text =
          error instanceof ScopeBusyError || error instanceof ProcessPoolFullError
            ? runStartErrorText(error)
            : '当前无法启动 Pi 运行，请稍后重试。';
        await replyToCommentError(channel, comment, text).catch(() => {});
      } finally {
        ingress -= 1;
      }
    },
  });
  try {
    appLock = await acquireRuntimeLock(paths.appLockFile(profile.accounts.app.id));
    await attachments.initialize();
    await runSessionRetention();
    await channel.connect();
    retentionTimer = setInterval(() => void runSessionRetention(), SESSION_RETENTION_INTERVAL_MS);
    retentionTimer.unref();
    const status = channel.getConnectionStatus?.();
    log.info('channel', 'connected', {
      state: status?.state,
      reconnectAttempts: status?.reconnectAttempts,
    });
  } catch (error) {
    interactionBroker.dispose();
    await channel.disconnect().catch(() => {});
    await appLock?.release().catch(() => {});
    throw new Error(`cannot activate App ID ${profile.accounts.app.id} for profile ${paths.profile}`, { cause: error });
  }
  const identity = channel.getBotIdentity();
  agent.setBotIdentity?.({ openId: identity.openId, ...(identity.name ? { name: identity.name } : {}) });
  const activity = (): { active: number; starting: number; scopes: string[] } => {
    const state = executor.activity();
    return { ...state, starting: state.starting + ingress };
  };
  return {
    channel,
    activity,
    health: () => {
      const status = channel.getConnectionStatus?.();
      return {
        ...(status ? { channel: status } : {}),
        ...(lastInboundTime ? { lastInboundTime } : {}),
        failed,
      };
    },
    failure,
    quiesce() {
      accepting = false;
      return activity();
    },
    resume() {
      accepting = true;
    },
    async disconnect(): Promise<void> {
      shuttingDown = true;
      accepting = false;
      clearReconnectDeadline();
      if (retentionTimer) {
        clearInterval(retentionTimer);
        retentionTimer = undefined;
      }
      await retentionTask;
      for (const scope of executor.activeScopes()) {
        await executor.stop(scope).catch(() => {});
      }
      interactionBroker.dispose();
      await agent.dispose?.().catch(() => {});
      try {
        await channel.disconnect();
      } finally {
        await appLock?.release().catch(() => {});
      }
    },
  };
}

async function ensurePrivateSessionDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new HandoffLocatorError('uncertain');
  }
  const canonical = await realpath(path);
  const after = await lstat(path);
  if (
    canonical !== (await realpath(path)) ||
    after.isSymbolicLink() ||
    !after.isDirectory() ||
    before.dev !== after.dev ||
    before.ino !== after.ino
  ) {
    throw new HandoffLocatorError('uncertain');
  }
}

async function handleHandoffCommand(input: {
  channel: ChannelPort;
  message: NormalizedMessage;
  command: Extract<BridgeCommand, { type: 'handoff' }>;
  executor: RunExecutor;
  catalog: SessionCatalog;
  scopeSettings: ScopeSettingsStore;
  handoffs: HandoffBindingStore;
  paths: AppPaths;
  roots?: readonly string[];
}): Promise<void> {
  const { channel, message, command, executor, catalog, scopeSettings, handoffs, paths } = input;
  let topicMessage: NormalizedMessage;
  if (message.threadId) {
    topicMessage = message;
    try {
      await channel.reply(message, { text: '正在安全定位并 fork Pi session…' }, { replyInThread: true });
    } catch (error) {
      log.warn('handoff', 'processing-reply-failed', { message: safeErrorClass(error) });
      await safeHandoffErrorReply(channel, message, 'topic');
      return;
    }
  } else {
    let reply: { messageId?: unknown } | undefined;
    try {
      reply = (await channel.reply(message, { text: '正在安全定位并 fork Pi session…' }, { replyInThread: true })) as
        { messageId?: unknown } | undefined;
    } catch (error) {
      log.warn('handoff', 'processing-reply-failed', { message: safeErrorClass(error) });
      await safeHandoffErrorReply(channel, message, 'topic');
      return;
    }
    if (!reply || typeof reply.messageId !== 'string') {
      await safeHandoffErrorReply(channel, message, 'topic');
      return;
    }
    let authoritative: NormalizedMessage | undefined;
    try {
      authoritative = await channel.fetchMessage(reply.messageId);
    } catch (error) {
      log.warn('handoff', 'topic-resolution-failed', { message: safeErrorClass(error) });
      await safeHandoffErrorReply(channel, message, 'topic');
      return;
    }
    if (!authoritative?.threadId || authoritative.chatId !== message.chatId) {
      await safeHandoffErrorReply(channel, message, 'topic');
      return;
    }
    topicMessage = authoritative;
  }
  const threadId = topicMessage.threadId!;
  const scopeId = `${message.chatId}:${threadId}`;
  let committed = false;
  try {
    await executor.withScopeLease(scopeId, async (lease) => {
      await ensurePrivateSessionDirectory(paths.piSessionDir);
      const roots = input.roots
        ? [...input.roots, paths.piSessionDir]
        : await trustedPiSessionRoots(paths.piSessionDir);
      const source = await locateHandoffSession(command.sessionId, roots);
      const sourceBefore = await currentFileIdentity(source.path);
      const profileBefore = await snapshotProfileSessionDirectory(paths.piSessionDir);
      const forkRequest = {
        scopeId,
        policyFingerprint: policyFingerprint({
          cwdRealpath: source.cwdRealpath,
          accessMode: 'full',
          profile: paths.profile,
          scopeId,
        }),
        cwd: source.cwdRealpath,
        accessMode: 'full' as const,
        handoff: { sourcePath: source.path, sourceSessionId: source.id },
      };

      const previousBinding = await handoffs.getLatest(scopeId);
      const previousSettings = scopeSettings.get(scopeId);
      const previousIdentity = previousBinding ? handoffCatalogIdentity(previousBinding, paths.profile) : undefined;
      const previousCatalog = previousIdentity ? catalog.activeFor(previousIdentity) : undefined;
      let forkArtifact: Awaited<ReturnType<typeof validateProfileForkSession>> | undefined;
      let forkSessionId: string | undefined;
      let replacementIdentity: ReturnType<typeof handoffCatalogIdentity> | undefined;
      try {
        const state = await lease.forkSession(forkRequest);
        forkSessionId = state.sessionId;
        if (!state.sessionId || state.sessionId === source.id) {
          throw new Error('invalid authoritative fork identity');
        }
        forkArtifact = await validateProfileForkSession(
          state.sessionId,
          paths.piSessionDir,
          source.cwdRealpath,
          profileBefore,
        );
        let sourceAfter: Awaited<ReturnType<typeof currentFileIdentity>>;
        try {
          sourceAfter = await currentFileIdentity(source.path);
        } catch {
          throw new HandoffSourceRaceError();
        }
        if (!sameFileIdentity(sourceBefore, sourceAfter)) {
          throw new HandoffSourceRaceError();
        }
        const binding = {
          scopeId,
          chatId: message.chatId,
          threadId,
          sourceSessionId: source.id,
          cwdSafeName: safeCwdDirectoryName(source.cwdRealpath),
          forkSessionId: state.sessionId,
          cwdRealpath: source.cwdRealpath,
        };
        const identity = handoffCatalogIdentity(binding, paths.profile);
        replacementIdentity = identity;
        if (previousIdentity) {
          await catalog.archive(previousIdentity);
        }
        await catalog.upsertActive(identity, state.sessionId);
        await handoffs.set(binding);
        await scopeSettings.update(scopeId, { model: undefined, thinkingLevel: undefined });
        committed = true;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        if (!forkArtifact && forkSessionId && !profileBefore.sessionIds.has(forkSessionId)) {
          forkArtifact = await validateProfileForkSession(
            forkSessionId,
            paths.piSessionDir,
            source.cwdRealpath,
            profileBefore,
          ).catch(() => undefined);
        }
        if (forkArtifact) {
          await removeOwnedForkSession(forkArtifact, paths.piSessionDir).catch((failure) =>
            rollbackErrors.push(failure),
          );
        }
        await handoffs.restore(scopeId, previousBinding).catch((failure) => rollbackErrors.push(failure));
        if (
          replacementIdentity &&
          (!previousIdentity ||
            replacementIdentity.scopeId !== previousIdentity.scopeId ||
            replacementIdentity.cwdRealpath !== previousIdentity.cwdRealpath ||
            replacementIdentity.policyFingerprint !== previousIdentity.policyFingerprint)
        ) {
          await catalog.restore(undefined, replacementIdentity).catch((failure) => rollbackErrors.push(failure));
        }
        await scopeSettings.restore(scopeId, previousSettings).catch((failure) => rollbackErrors.push(failure));
        if (previousIdentity) {
          await catalog.restore(previousCatalog, previousIdentity).catch((failure) => rollbackErrors.push(failure));
        }
        if (rollbackErrors.length) {
          log.error('handoff', 'rollback-failed', { failures: rollbackErrors.map(safeErrorClass) });
        }
        throw error;
      }
    });
  } catch (error) {
    log.warn('handoff', 'failed', {
      message: safeErrorClass(error),
      ...(error instanceof HandoffLocatorError ? { failure: error.failure } : {}),
    });
    await safeHandoffErrorReply(
      channel,
      topicMessage,
      error instanceof ScopeBusyError ? 'busy' : error instanceof HandoffSourceRaceError ? 'source-race' : 'operation',
    );
    return;
  }
  if (committed) {
    await channel
      .reply(
        topicMessage,
        { text: `handoff 已建立。source：${command.sessionId}；策略：full tools + approve。` },
        { replyInThread: true },
      )
      .catch((error) => log.warn('handoff', 'success-reply-failed', { message: safeErrorClass(error) }));
  }
}

function handoffCatalogIdentity(binding: Omit<HandoffBinding, 'updatedAt'> | HandoffBinding, profile: string) {
  return {
    scopeId: binding.scopeId,
    cwdRealpath: binding.cwdRealpath,
    policyFingerprint: policyFingerprint({
      cwdRealpath: binding.cwdRealpath,
      accessMode: 'full',
      profile,
      scopeId: binding.scopeId,
    }),
  };
}

async function safeHandoffErrorReply(
  channel: ChannelPort,
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
  kind: 'topic' | 'busy' | 'source-race' | 'operation',
): Promise<void> {
  const text =
    kind === 'topic'
      ? '无法安全确认 handoff 话题，未建立 handoff。'
      : kind === 'busy'
        ? '当前话题已有 Pi 操作，请稍后重试 handoff。'
        : kind === 'source-race'
          ? 'handoff source 在 fork 期间发生变化；未提交新的 handoff。请等待电脑端 Pi 任务结束后重试。'
          : '无法安全完成 handoff；未提交新的 handoff，请重试。';
  await channel.reply(message, { text }, { replyInThread: true }).catch(() => {});
}

class HandoffSourceRaceError extends Error {
  constructor() {
    super('handoff source changed during fork');
    this.name = 'HandoffSourceRaceError';
  }
}

function safeErrorClass(error: unknown): string {
  if (error instanceof ScopeBusyError) {
    return 'scope-busy';
  }
  if (error instanceof ProcessPoolFullError) {
    return 'pool-full';
  }
  if (error && typeof error === 'object' && 'name' in error && typeof error.name === 'string') {
    return error.name.slice(0, 80);
  }
  return typeof error;
}

function isWorkspaceCommand(command: BridgeCommand | undefined): command is WorkspaceBridgeCommand {
  return Boolean(command?.type.startsWith('workspace-'));
}

type ModelThinkingCommand = Extract<
  BridgeCommand,
  | { type: 'status' }
  | { type: 'model-current' | 'model-list' | 'model-use' }
  | { type: 'thinking-current' | 'thinking-list' | 'thinking-set' }
>;

function isModelThinkingCommand(
  command: BridgeCommand | undefined,
): command is Exclude<ModelThinkingCommand, { type: 'status' }> {
  return Boolean(command?.type.startsWith('model-') || command?.type.startsWith('thinking-'));
}

async function handleModelThinkingCommand(input: {
  command: ModelThinkingCommand;
  reply(text: string): Promise<unknown>;
  executor: ScopeLease;
  catalog: SessionCatalog;
  identity: import('../session/catalog.js').SessionCatalogIdentity;
  scopeId: string;
  workspace: string;
  accessMode: import('../config/permissions.js').AccessMode;
  profile: ProfileConfig;
  scopeSettings: ScopeSettingsStore;
  handoff?: HandoffBinding;
}): Promise<void> {
  const previous = input.catalog.activeFor(input.identity);
  const settings = input.scopeSettings.get(input.scopeId);
  const base = {
    scopeId: input.scopeId,
    policyFingerprint: input.identity.policyFingerprint,
    cwd: input.workspace,
    accessMode: input.accessMode,
    sessionId: previous?.sessionId,
    model: previous ? settings?.model : (settings?.model ?? runtimeProfileModel(input.profile)),
    thinkingLevel: settings?.thinkingLevel,
    handoff: input.handoff ? { sourceSessionId: input.handoff.sourceSessionId } : undefined,
    stopGraceMs: input.profile.preferences.agentStopGraceMs,
  };
  if (
    !previous &&
    (input.command.type === 'status' ||
      input.command.type === 'model-current' ||
      input.command.type === 'thinking-current')
  ) {
    await input.reply('当前 scope 没有活跃 Pi session；发送普通消息后可查看当前模型或思考级别。');
    return;
  }
  const handoffDetail = input.handoff
    ? `\nhandoff：active\nsource：${input.handoff.sourceSessionId}\nfork：${input.handoff.forkSessionId}\n目录：${input.handoff.cwdSafeName}\n策略：full tools + approve`
    : '';
  if (input.command.type === 'status' && input.profile.preferences.transport !== 'rpc') {
    await input.reply(
      `当前 Pi session：${previous!.sessionId}${handoffDetail}\n模型与思考级别仅 RPC transport 可查询。`,
    );
    return;
  }
  try {
    if (input.command.type === 'model-list') {
      const result = await input.executor.listModels(base);
      const current = result.state.model ? `${result.state.model.provider}/${result.state.model.id}` : undefined;
      await input.reply(renderModels(result.models, current));
      return;
    }
    if (input.command.type === 'model-use') {
      if (!previous) {
        await input.reply('当前 scope 没有活跃 Pi session；请先发送一条普通消息，再切换模型。');
        return;
      }
      const previousCatalog = input.catalog.activeFor(input.identity);
      const previousSettings = input.scopeSettings.get(input.scopeId);
      const previousState = await input.executor.getSessionState(base);
      if (!previousState.model || !previousState.thinkingLevel) {
        throw new Error('当前 Pi session 未返回可恢复的模型或思考级别；未执行修改。');
      }
      const state = await input.executor.setModel(base, input.command.provider, input.command.modelId);
      const model = renderCurrentModel(state.model);
      try {
        await input.catalog.upsertActive(input.identity, state.sessionId);
        await input.scopeSettings.update(input.scopeId, {
          model: state.model ? `${state.model.provider}/${state.model.id}` : undefined,
          thinkingLevel: state.thinkingLevel,
        });
      } catch (error) {
        await compensateModelThinking({
          executor: input.executor,
          base,
          previousState,
          catalog: input.catalog,
          identity: input.identity,
          previousCatalog,
          scopeSettings: input.scopeSettings,
          scopeId: input.scopeId,
          previousSettings,
        });
        throw error;
      }
      await input.reply(`当前 Pi session 已切换为模型 ${model}；思考级别：${state.thinkingLevel ?? 'unknown'}。`);
      return;
    }
    if (input.command.type === 'thinking-list') {
      const result = await input.executor.listThinkingLevels(base);
      await input.reply(
        `当前模型 ${renderCurrentModel(result.state.model)} 支持的思考级别：${result.levels
          .map((level) => (level === result.state.thinkingLevel ? `${level}（当前）` : level))
          .join('、')}`,
      );
      return;
    }
    if (input.command.type === 'thinking-set') {
      if (!previous) {
        await input.reply('当前 scope 没有活跃 Pi session；请先发送一条普通消息，再切换思考级别。');
        return;
      }
      const support = await input.executor.listThinkingLevels(base);
      if (!support.levels.includes(input.command.level)) {
        await input.reply(`当前模型不支持 ${input.command.level}；可用级别：${support.levels.join('、')}。`);
        return;
      }
      const previousCatalog = input.catalog.activeFor(input.identity);
      const previousSettings = input.scopeSettings.get(input.scopeId);
      const previousState = support.state;
      if (!previousState.model || !previousState.thinkingLevel) {
        throw new Error('当前 Pi session 未返回可恢复的模型或思考级别；未执行修改。');
      }
      const state = await input.executor.setThinkingLevel(base, input.command.level);
      try {
        await input.catalog.upsertActive(input.identity, state.sessionId);
        await input.scopeSettings.update(input.scopeId, {
          model: state.model ? `${state.model.provider}/${state.model.id}` : settings?.model,
          thinkingLevel: state.thinkingLevel,
        });
      } catch (error) {
        await compensateModelThinking({
          executor: input.executor,
          base,
          previousState,
          catalog: input.catalog,
          identity: input.identity,
          previousCatalog,
          scopeSettings: input.scopeSettings,
          scopeId: input.scopeId,
          previousSettings,
        });
        throw error;
      }
      await input.reply(`当前 Pi session 的思考级别已切换为 ${state.thinkingLevel ?? input.command.level}。`);
      return;
    }
    const entry = input.catalog.activeFor(input.identity);
    const state = await input.executor.getSessionState(base);
    const detail = `模型：${renderCurrentModel(state.model)}\n思考级别：${state.thinkingLevel ?? 'unknown'}`;
    await input.reply(
      input.command.type === 'status' ? `当前 Pi session：${entry!.sessionId}\n${detail}${handoffDetail}` : detail,
    );
  } catch (error) {
    await input.reply(
      error instanceof ScopeBusyError || error instanceof ProcessPoolFullError
        ? runStartErrorText(error)
        : error instanceof Error
          ? error.message
          : '当前无法读取或修改模型设置。',
    );
  }
}

async function compensateModelThinking(input: {
  executor: ScopeLease;
  base: Parameters<ScopeLease['getSessionState']>[0];
  previousState: import('../agent/types.js').AgentSessionState;
  catalog: SessionCatalog;
  identity: import('../session/catalog.js').SessionCatalogIdentity;
  previousCatalog: import('../session/catalog.js').SessionCatalogEntry | undefined;
  scopeSettings: ScopeSettingsStore;
  scopeId: string;
  previousSettings: import('../session/scope-settings.js').ScopeSettings | undefined;
}): Promise<void> {
  const failures: string[] = [];
  try {
    if (input.previousState.model) {
      await input.executor.setModel(input.base, input.previousState.model.provider, input.previousState.model.id);
    }
    if (input.previousState.thinkingLevel) {
      await input.executor.setThinkingLevel(input.base, input.previousState.thinkingLevel);
    }
  } catch (error) {
    failures.push(`rpc:${safeErrorClass(error)}`);
  }
  const restored = await Promise.allSettled([
    input.catalog.restore(input.previousCatalog, input.identity),
    input.scopeSettings.restore(input.scopeId, input.previousSettings),
  ]);
  for (const [index, result] of restored.entries()) {
    if (result.status === 'rejected') {
      failures.push(`${index === 0 ? 'catalog' : 'settings'}:${safeErrorClass(result.reason)}`);
    }
  }
  if (failures.length) {
    await input.executor.invalidateSession(input.base).catch((error) => {
      failures.push(`evict:${safeErrorClass(error)}`);
    });
    log.error('session-control', 'rollback-failed', { failures });
  }
}

function renderCurrentModel(model: import('../agent/types.js').AgentModelInfo | undefined): string {
  return model ? `${model.provider}/${model.id}` : '未选择';
}

function renderModels(models: import('../agent/types.js').AgentModelInfo[], current?: string): string {
  if (!models.length) {
    return '当前 Pi 配置没有可用模型。';
  }
  const lines = models.slice(0, 200).map((model) => {
    const id = `${model.provider}/${model.id}`;
    const tags = [id === current ? 'current' : undefined, model.reasoning ? 'thinking' : undefined].filter(Boolean);
    const name = model.name && model.name !== model.id ? ` — ${model.name.replace(/[\r\n]+/g, ' ').slice(0, 200)}` : '';
    return `- ${id}${tags.length ? ` [${tags.join(', ')}]` : ''}${name}`;
  });
  return `可用模型：\n${lines.join('\n')}${models.length > lines.length ? '\n…[已截断]' : ''}`;
}

async function exitHandoffTransaction(input: {
  binding: HandoffBinding;
  profile: string;
  scopeId: string;
  catalog: SessionCatalog;
  handoffs: HandoffBindingStore;
  scopeSettings: ScopeSettingsStore;
}): Promise<void> {
  const identity = handoffCatalogIdentity(input.binding, input.profile);
  const previousCatalog = input.catalog.activeFor(identity);
  const previousSettings = input.scopeSettings.get(input.scopeId);
  try {
    await input.catalog.archive(identity);
    await input.handoffs.delete(input.scopeId);
    await input.scopeSettings.update(input.scopeId, { model: undefined, thinkingLevel: undefined });
  } catch (error) {
    await Promise.allSettled([
      input.catalog.restore(previousCatalog, identity),
      input.handoffs.restore(input.scopeId, input.binding),
      input.scopeSettings.restore(input.scopeId, previousSettings),
    ]);
    throw error;
  }
}

async function updateWorkspaceSelection(
  alias: string | undefined,
  workspaces: ProfileWorkspaces,
  scopeId: string,
  scopeSettings: ScopeSettingsStore,
): Promise<void> {
  if (alias) {
    const selected = await resolveEffectiveWorkspace(workspaces, alias);
    if (!selected.ok) {
      throw new Error(selected.message);
    }
  }
  await scopeSettings.update(scopeId, { workspaceAlias: alias, model: undefined, thinkingLevel: undefined });
}

async function handleWorkspaceCommand(input: {
  channel: ChannelPort;
  message: NormalizedMessage;
  command: WorkspaceBridgeCommand;
  workspaces: ProfileWorkspaces;
  scopeId: string;
  scopeSettings: ScopeSettingsStore;
  profile: ProfileConfig;
  paths: AppPaths;
  handoff?: HandoffBinding;
  handoffs: HandoffBindingStore;
  catalog: SessionCatalog;
  executor: RunExecutor;
}): Promise<void> {
  const { channel, message, command, workspaces, scopeId, scopeSettings, profile, paths } = input;
  if (input.handoff && command.type !== 'workspace-use' && command.type !== 'workspace-list') {
    await channel.reply(message, {
      text:
        command.type === 'workspace-current'
          ? '当前话题使用 handoff source workspace；本地路径不会在飞书中展示。'
          : 'handoff 中仅 /workspace list 保持只读兼容；显式 /workspace use <alias|default> 可退出并切换普通 workspace 路由。',
    });
    return;
  }
  const settings = scopeSettings.get(scopeId);
  if (command.type === 'workspace-use') {
    if (command.alias) {
      const selected = await resolveEffectiveWorkspace(workspaces, command.alias);
      if (!selected.ok) {
        await channel.reply(message, { text: selected.message });
        return;
      }
    }
    await input.executor.withScopeLease(scopeId, async () => {
      const previousBinding = await input.handoffs.getLatest(scopeId);
      const previousSettings = await scopeSettings.getLatest(scopeId);
      const handoffIdentity = previousBinding ? handoffCatalogIdentity(previousBinding, paths.profile) : undefined;
      const previousCatalog = handoffIdentity ? input.catalog.activeFor(handoffIdentity) : undefined;
      try {
        if (handoffIdentity) {
          await input.catalog.archive(handoffIdentity);
        }
        if (previousBinding) {
          await input.handoffs.delete(scopeId);
        }
        await updateWorkspaceSelection(command.alias, workspaces, scopeId, scopeSettings);
      } catch (error) {
        const restored = await Promise.allSettled([
          handoffIdentity ? input.catalog.restore(previousCatalog, handoffIdentity) : Promise.resolve(),
          input.handoffs.restore(scopeId, previousBinding),
          scopeSettings.restore(scopeId, previousSettings),
        ]);
        if (restored.some((result) => result.status === 'rejected')) {
          log.error('handoff', 'workspace-exit-rollback-failed', {});
        }
        throw error;
      }
    });
    if (command.alias) {
      const selected = await resolveEffectiveWorkspace(workspaces, command.alias);
      if (!selected.ok) {
        await channel.reply(message, { text: selected.message });
        return;
      }
      await channel.reply(message, {
        text: `当前 scope 已使用 workspace「${command.alias}」（显式选择）。后续消息会使用对应独立 session。`,
      });
    } else {
      const selected = await resolveEffectiveWorkspace(workspaces);
      await channel.reply(message, {
        text: selected.ok
          ? `已清除当前 scope 的显式选择；现在跟随 profile 默认 workspace${selected.alias ? `「${selected.alias}」` : ''}。`
          : `已清除当前 scope 的显式选择；${selected.message}`,
      });
    }
    return;
  }
  if (command.type === 'workspace-default-set') {
    if (!profile.access.admins.includes(message.senderId)) {
      await channel.reply(message, {
        text:
          profile.access.admins.length === 0
            ? '当前 profile 未配置管理员；只能从本机 CLI 修改默认 workspace。'
            : '只有 profile 管理员可以修改默认 workspace。',
      });
      return;
    }
    try {
      const selected = await setDefaultWorkspace(paths, command.alias);
      await channel.reply(message, { text: `profile 默认 workspace 已设置为「${selected.alias}」。` });
    } catch (error) {
      await channel.reply(message, { text: error instanceof Error ? error.message : '无法修改默认 workspace。' });
    }
    return;
  }
  if (command.type === 'workspace-default-get') {
    if (workspaces.defaultAlias) {
      const selected = await resolveEffectiveWorkspace(workspaces);
      await channel.reply(message, {
        text: `profile 默认 workspace：「${workspaces.defaultAlias}」${selected.ok ? '' : '（unavailable）'}。`,
      });
    } else if (workspaces.defaultPath) {
      const selected = await resolveEffectiveWorkspace(workspaces);
      await channel.reply(message, {
        text: `profile 使用 direct default path${selected.ok ? '' : '（unavailable）'}；建议在本机注册 alias 后设置默认值。`,
      });
    } else {
      await channel.reply(message, { text: 'profile 尚未配置默认 workspace。' });
    }
    return;
  }
  if (command.type === 'workspace-list') {
    const entries = await inspectWorkspaceRegistry(workspaces);
    const current = input.handoff ? undefined : await resolveEffectiveWorkspace(workspaces, settings?.workspaceAlias);
    const lines = entries.map((entry) => {
      const tags = [
        entry.alias === current?.alias ? 'current' : undefined,
        entry.isDefault ? 'default' : undefined,
        entry.available ? undefined : 'unavailable',
      ].filter(Boolean);
      return `- ${entry.alias}${tags.length ? ` [${tags.join(', ')}]` : ''}`;
    });
    await channel.reply(message, {
      text: lines.length ? `workspace：\n${lines.join('\n')}` : '尚未配置命名 workspace。',
    });
    return;
  }
  const current = await resolveEffectiveWorkspace(workspaces, settings?.workspaceAlias);
  await channel.reply(message, {
    text: current.ok
      ? current.alias
        ? `当前 workspace：「${current.alias}」（${current.source === 'scope' ? '显式选择' : 'profile 默认'}）。`
        : '当前 workspace 来自 profile direct default path；本地路径不会在飞书中展示。'
      : current.message,
  });
}

async function handleComment(
  channel: ChannelPort,
  comment: CommentEvent,
  profile: ProfileConfig,
  paths: AppPaths,
  agent: AgentAdapter,
  catalog: SessionCatalog,
  scopeSettings: ScopeSettingsStore,
  executor: RunExecutor,
): Promise<void> {
  if (!comment.mentionedBot || !allowedComment(profile, comment.operator.openId)) {
    return;
  }
  const target = await channel.comments.resolveTarget(comment.fileToken, comment.fileType);
  if (!target) {
    return;
  }
  const fetched = await channel.comments.fetch(target, comment.commentId);
  if (!fetched) {
    return;
  }
  const userInput = commentText(fetched);
  if (!userInput) {
    return;
  }
  const workspaces = await loadProfileWorkspaces(paths);
  const scopeId = `comment:${target.fileToken}:${comment.commentId}`;
  await scopeSettings.getLatest(scopeId);
  const commentCommand = parseBridgeCommand(userInput);
  if (commentCommand?.type === 'invalid') {
    await channel.comments.reply(target, comment.commentId, commentCommand.message);
    return;
  }
  if (isWorkspaceCommand(commentCommand)) {
    await channel.comments.reply(
      target,
      comment.commentId,
      '文档评论固定使用 profile 默认 workspace，不支持切换或修改 workspace。',
    );
    return;
  }
  const workspace = await resolveEffectiveWorkspace(workspaces);
  if (!workspace.ok) {
    await channel.comments.reply(target, comment.commentId, workspace.message);
    return;
  }
  if (commentCommand?.type === 'stop') {
    await executor.stop(scopeId);
    await channel.comments.reply(target, comment.commentId, '已请求停止当前 Pi 运行。');
    return;
  }
  if (commentCommand?.type === 'steer' || commentCommand?.type === 'follow-up') {
    try {
      const disposition = await executor.control(scopeId, commentCommand.type, commentCommand.prompt);
      await channel.comments.reply(
        target,
        comment.commentId,
        disposition === 'queued'
          ? `已将 ${commentCommand.type} 消息加入当前 RPC 运行。`
          : `当前 RPC ${commentCommand.type} 消息已处理。`,
      );
    } catch (error) {
      await channel.comments.reply(
        target,
        comment.commentId,
        error instanceof Error ? error.message : '当前无法处理 RPC 控制命令。',
      );
    }
    return;
  }
  if (commentCommand?.type === 'timeout') {
    await scopeSettings.update(scopeId, { idleTimeoutMinutes: commentCommand.minutes });
    await channel.comments.reply(
      target,
      comment.commentId,
      `当前 scope 的 idle timeout 已设置为 ${commentCommand.minutes} 分钟。`,
    );
    return;
  }
  if (commentCommand?.type === 'access') {
    const accessMode = clampAccess(commentCommand.accessMode, profile.permissions.maxAccess);
    if (accessMode !== commentCommand.accessMode) {
      await channel.comments.reply(
        target,
        comment.commentId,
        `请求的访问模式超过当前 profile 上限 ${profile.permissions.maxAccess}。`,
      );
      return;
    }
    await scopeSettings.update(scopeId, { accessMode, model: undefined, thinkingLevel: undefined });
    await channel.comments.reply(target, comment.commentId, `当前 scope 的访问模式已设置为 ${accessMode}。`);
    return;
  }
  const accessMode = clampAccess(
    scopeSettings.get(scopeId)?.accessMode ?? profile.permissions.defaultAccess,
    profile.permissions.maxAccess,
  );
  const identity = {
    scopeId,
    cwdRealpath: workspace.cwdRealpath,
    policyFingerprint: policyFingerprint({
      cwdRealpath: workspace.cwdRealpath,
      accessMode,
      profile: paths.profile,
      scopeId,
    }),
  };
  if (isModelThinkingCommand(commentCommand) || commentCommand?.type === 'status') {
    await handleModelThinkingCommand({
      command: commentCommand,
      reply: (text) => channel.comments.reply(target, comment.commentId, text),
      executor,
      catalog,
      identity,
      scopeId,
      workspace: workspace.cwdRealpath,
      accessMode,
      profile,
      scopeSettings,
    });
    return;
  }
  if (commentCommand?.type === 'pi-commands' || commentCommand?.type === 'pi-command') {
    await handlePiCommentCommand({
      command: commentCommand,
      channel,
      target,
      commentId: comment.commentId,
      executor,
      catalog,
      identity,
      scopeId,
      workspace: workspace.cwdRealpath,
      accessMode,
      profile,
      actorOpenId: comment.operator.openId,
    });
    return;
  }
  if (commentCommand) {
    const response = await applySessionCommand(commentCommand, catalog, identity);
    if (commentCommand.type === 'new') {
      await scopeSettings.update(scopeId, { model: undefined, thinkingLevel: undefined });
    }
    if (response) {
      await channel.comments.reply(target, comment.commentId, response);
    }
    return;
  }
  const previous = catalog.activeFor(identity);
  const currentSettings = scopeSettings.get(scopeId);
  const execution = await executor.submit({
    scopeId,
    policyFingerprint: identity.policyFingerprint,
    cwd: workspace.cwdRealpath,
    accessMode,
    sessionId: previous?.sessionId,
    model: previous ? currentSettings?.model : (currentSettings?.model ?? runtimeProfileModel(profile)),
    thinkingLevel: currentSettings?.thinkingLevel,
    stopGraceMs: profile.preferences.agentStopGraceMs,
    interaction: { actorOpenId: comment.operator.openId, surface: 'comment' },
    prompt: `<bridge_comment_context>\n${JSON.stringify({
      fileToken: target.fileToken,
      fileType: target.fileType,
      commentId: comment.commentId,
      replyId: comment.replyId ?? null,
      operatorOpenId: comment.operator.openId,
    })}\n</bridge_comment_context>\n\n<user_input>\n${userInput}\n</user_input>`,
  });
  const timeoutMinutes = scopeSettings.get(scopeId)?.idleTimeoutMinutes ?? profile.preferences.runIdleTimeoutMinutes;
  const timeout = timeoutMinutes ? stopAfterIdle(execution.run, timeoutMinutes) : undefined;
  const renderer = new TextReplyRenderer(MAX_COMMENT_REPLY_CHARS);
  try {
    for await (const event of persistSessionEvents(execution.events, catalog, identity, () => timeout?.touch())) {
      renderer.apply(event, profile.preferences.showToolCalls === true);
    }
    await channel.comments.reply(
      target,
      comment.commentId,
      renderer.render(profile.preferences.showToolCalls === true),
    );
  } finally {
    timeout?.clear();
  }
}

function runStartErrorText(error: unknown): string {
  if (error instanceof ScopeBusyError) {
    return '当前话题已有 Pi 运行。请等待完成，或使用 /steer、/follow-up、/stop。';
  }
  if (error instanceof ProcessPoolFullError) {
    return 'Pi 运行池当前已满，请等待其他运行完成后重试。';
  }
  return '当前无法启动 Pi 运行，请稍后重试。';
}

async function replyToCommentError(channel: ChannelPort, comment: CommentEvent, text: string): Promise<void> {
  const target = await channel.comments.resolveTarget(comment.fileToken, comment.fileType);
  if (target) {
    await channel.comments.reply(target, comment.commentId, text);
  }
}

async function handlePiCommand(input: {
  command: Extract<BridgeCommand, { type: 'pi-commands' | 'pi-command' }>;
  channel: ChannelPort;
  message: NormalizedMessage;
  executor: ScopeLease;
  catalog: SessionCatalog;
  handoffs: HandoffBindingStore;
  identity: import('../session/catalog.js').SessionCatalogIdentity;
  scopeId: string;
  workspace: string;
  accessMode: import('../config/permissions.js').AccessMode;
  profile: ProfileConfig;
  handoff?: HandoffBinding;
  actorOpenId: string;
  surface: 'p2p' | 'group' | 'topic';
}): Promise<void> {
  const base = piCommandRunRequest(input);
  let commands: Awaited<ReturnType<RunExecutor['listCommands']>>;
  try {
    commands = await input.executor.listCommands(base);
  } catch (error) {
    await input.channel.reply(input.message, {
      text:
        error instanceof ScopeBusyError || error instanceof ProcessPoolFullError
          ? runStartErrorText(error)
          : error instanceof Error
            ? error.message
            : '当前无法读取 Pi 命令。',
    });
    return;
  }
  if (input.command.type === 'pi-commands') {
    await input.channel.reply(input.message, { text: renderPiCommands(commands) });
    return;
  }
  const piCommand = input.command;
  if (!commands.some((command) => command.name === piCommand.name)) {
    await input.channel.reply(input.message, { text: `Pi 未公开命令 /${piCommand.name}；请使用 /pi commands 查看。` });
    return;
  }
  const execution = await input.executor.submit({
    ...base,
    prompt: piCommand.command,
    promptMode: 'pi-command',
  });
  const timeoutMinutes = input.profile.preferences.runIdleTimeoutMinutes;
  const timeout = timeoutMinutes ? stopAfterIdle(execution.run, timeoutMinutes) : undefined;
  try {
    const events = persistSessionEvents(
      execution.events,
      input.catalog,
      input.identity,
      () => timeout?.touch(),
      input.handoff ? latestSessionIdUpdater(input.handoffs, input.scopeId) : undefined,
    );
    await streamAgentReply(input.channel, input.message, events, input.profile.preferences.showToolCalls === true);
  } finally {
    timeout?.clear();
  }
}

async function handlePiCommentCommand(input: {
  command: Extract<BridgeCommand, { type: 'pi-commands' | 'pi-command' }>;
  channel: ChannelPort;
  target: NonNullable<Awaited<ReturnType<ChannelPort['comments']['resolveTarget']>>>;
  commentId: string;
  executor: RunExecutor;
  catalog: SessionCatalog;
  identity: import('../session/catalog.js').SessionCatalogIdentity;
  scopeId: string;
  workspace: string;
  accessMode: import('../config/permissions.js').AccessMode;
  profile: ProfileConfig;
  actorOpenId: string;
}): Promise<void> {
  const base = piCommandRunRequest({ ...input, surface: 'comment' });
  let commands: Awaited<ReturnType<RunExecutor['listCommands']>>;
  try {
    commands = await input.executor.listCommands(base);
  } catch (error) {
    await input.channel.comments.reply(
      input.target,
      input.commentId,
      error instanceof ScopeBusyError || error instanceof ProcessPoolFullError
        ? runStartErrorText(error)
        : error instanceof Error
          ? error.message
          : '当前无法读取 Pi 命令。',
    );
    return;
  }
  if (input.command.type === 'pi-commands') {
    await input.channel.comments.reply(input.target, input.commentId, renderPiCommands(commands));
    return;
  }
  const piCommand = input.command;
  if (!commands.some((command) => command.name === piCommand.name)) {
    await input.channel.comments.reply(
      input.target,
      input.commentId,
      `Pi 未公开命令 /${piCommand.name}；请使用 /pi commands 查看。`,
    );
    return;
  }
  const execution = await input.executor.submit({
    ...base,
    prompt: piCommand.command,
    promptMode: 'pi-command',
  });
  const timeoutMinutes = input.profile.preferences.runIdleTimeoutMinutes;
  const timeout = timeoutMinutes ? stopAfterIdle(execution.run, timeoutMinutes) : undefined;
  const renderer = new TextReplyRenderer(MAX_COMMENT_REPLY_CHARS);
  try {
    for await (const event of persistSessionEvents(execution.events, input.catalog, input.identity, () =>
      timeout?.touch(),
    )) {
      renderer.apply(event, input.profile.preferences.showToolCalls === true);
    }
    await input.channel.comments.reply(
      input.target,
      input.commentId,
      renderer.render(input.profile.preferences.showToolCalls === true),
    );
  } finally {
    timeout?.clear();
  }
}

function piCommandRunRequest(input: {
  scopeId: string;
  identity: import('../session/catalog.js').SessionCatalogIdentity;
  catalog: SessionCatalog;
  workspace: string;
  accessMode: import('../config/permissions.js').AccessMode;
  profile: ProfileConfig;
  actorOpenId: string;
  surface: 'p2p' | 'group' | 'topic' | 'comment';
  handoff?: HandoffBinding;
  message?: NormalizedMessage;
}) {
  return {
    scopeId: input.scopeId,
    policyFingerprint: input.identity.policyFingerprint,
    cwd: input.workspace,
    accessMode: input.accessMode,
    handoff: input.handoff ? { sourceSessionId: input.handoff.sourceSessionId } : undefined,
    sessionId: input.catalog.activeFor(input.identity)?.sessionId,
    model: runtimeProfileModel(input.profile),
    stopGraceMs: input.profile.preferences.agentStopGraceMs,
    interaction: {
      actorOpenId: input.actorOpenId,
      surface: input.surface,
      privateReplyTarget: input.message ? replyTarget(input.message) : undefined,
    },
  };
}

function renderPiCommands(commands: Awaited<ReturnType<RunExecutor['listCommands']>>): string {
  if (!commands.length) {
    return '当前 Pi 配置没有公开 extension、prompt template 或 skill command。';
  }
  const lines = commands.slice(0, 100).map((command) => {
    const description = command.description ? ` — ${command.description.replace(/[\r\n]+/g, ' ').slice(0, 200)}` : '';
    return `- /${command.name} [${command.source}]${description}`;
  });
  return `可用 Pi 命令：\n${lines.join('\n')}${commands.length > lines.length ? '\n…[已截断]' : ''}`;
}

function replyTarget(
  message: Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'>,
): Pick<NormalizedMessage, 'chatId' | 'messageId' | 'threadId'> {
  return {
    chatId: message.chatId,
    messageId: message.messageId,
    ...(message.threadId ? { threadId: message.threadId } : {}),
  };
}

function allowed(profile: ProfileConfig, senderId: string, chatId: string, chatType: string): boolean {
  if (profile.mode === 'team') {
    return true;
  }
  if (chatType === 'p2p') {
    return profile.access.allowedUsers.includes(senderId) || profile.access.admins.includes(senderId);
  }
  return profile.access.allowedChats.includes(chatId) || profile.access.admins.includes(senderId);
}

function mentionAllowed(
  profile: ProfileConfig,
  message: Pick<NormalizedMessage, 'chatId' | 'chatType' | 'mentionedBot'>,
): boolean {
  return (
    message.chatType === 'p2p' ||
    !profile.access.requireMentionInGroup ||
    message.mentionedBot ||
    profile.access.mentionOptionalChats.includes(message.chatId)
  );
}

function allowedComment(profile: ProfileConfig, senderId: string): boolean {
  return (
    profile.mode === 'team' ||
    profile.access.allowedUsers.includes(senderId) ||
    profile.access.admins.includes(senderId)
  );
}

function commentText(comment: {
  quote?: string;
  replies: Array<{ content?: { elements?: Array<{ type: string; text_run?: { text: string } }> } }>;
}): string {
  const replies = comment.replies
    .flatMap((reply) => reply.content?.elements ?? [])
    .filter((element) => element.type === 'text_run')
    .map((element) => element.text_run?.text ?? '')
    .join('')
    .trim();
  return [comment.quote?.trim(), replies].filter(Boolean).join('\n\n');
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function latestSessionIdUpdater(handoffs: HandoffBindingStore, scopeId: string) {
  return async (sessionId: string): Promise<void> => {
    const binding = await handoffs.getLatest(scopeId);
    if (binding && binding.forkSessionId !== sessionId) {
      await handoffs.set({ ...binding, forkSessionId: sessionId });
    }
  };
}

async function* persistSessionEvents(
  events: AsyncIterable<import('../agent/types.js').AgentEvent>,
  catalog: SessionCatalog,
  identity: import('../session/catalog.js').SessionCatalogIdentity,
  onEvent?: () => void,
  onSessionId?: (sessionId: string) => Promise<void>,
): AsyncGenerator<import('../agent/types.js').AgentEvent> {
  for await (const event of events) {
    onEvent?.();
    if (event.type === 'system' && event.sessionId) {
      const previousCatalog = catalog.activeFor(identity);
      await catalog.upsertActive(identity, event.sessionId);
      try {
        await onSessionId?.(event.sessionId);
      } catch (error) {
        try {
          await catalog.restore(previousCatalog, identity);
        } catch (restoreError) {
          log.error('session-control', 'system-session-rollback-failed', {
            failures: [safeErrorClass(error), safeErrorClass(restoreError)],
          });
        }
        throw error;
      }
    }
    yield event;
  }
}

function buildPrompt(
  message: Pick<NormalizedMessage, 'chatId' | 'chatType' | 'senderId' | 'threadId' | 'content'>,
): string {
  return `<bridge_context>\n${JSON.stringify({ chatId: message.chatId, chatType: message.chatType, senderId: message.senderId, threadId: message.threadId ?? null })}\n</bridge_context>\n\n<user_input>\n${message.content}\n</user_input>`;
}
