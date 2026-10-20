import type { AccessMode } from '../config/permissions.js';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      reasoningOutputTokens?: number;
      costUsd?: number;
    }
  | { type: 'done'; sessionId?: string; terminationReason: 'normal' | 'interrupted' | 'timeout' }
  | { type: 'error'; message: string; terminationReason: 'failed' | 'interrupted' | 'timeout' };

export type AgentInteractionSurface = 'p2p' | 'group' | 'topic' | 'comment';

export interface AgentInteractionReplyTarget {
  chatId: string;
  messageId: string;
  threadId?: string;
}

export interface AgentInteractionContext {
  runId: string;
  scopeId: string;
  actorOpenId: string;
  surface: AgentInteractionSurface;
  privateReplyTarget?: AgentInteractionReplyTarget;
}

export type AgentExtensionUIRequest =
  | { method: 'select'; title: string; options: string[]; timeoutMs?: number }
  | { method: 'confirm'; title: string; message: string; timeoutMs?: number }
  | { method: 'input'; title: string; placeholder?: string; timeoutMs?: number }
  | { method: 'editor'; title: string; prefill?: string }
  | { method: 'notify'; message: string; notifyType: 'info' | 'warning' | 'error' }
  | { method: 'setStatus'; statusKey: string; statusText?: string }
  | {
      method: 'setWidget';
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement: 'aboveEditor' | 'belowEditor';
    }
  | { method: 'setTitle'; title: string }
  | { method: 'set_editor_text'; text: string };

export type AgentExtensionUIResponse = { value: string } | { confirmed: boolean } | { cancelled: true };

export interface AgentInteractionPort {
  handle(context: AgentInteractionContext, request: AgentExtensionUIRequest): Promise<AgentExtensionUIResponse | void>;
  cancelRun(runId: string): void;
  dispose(): void;
}

export interface AgentSlashCommand {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
}

export const AGENT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AgentThinkingLevel = (typeof AGENT_THINKING_LEVELS)[number];

export function isAgentThinkingLevel(value: unknown): value is AgentThinkingLevel {
  return typeof value === 'string' && (AGENT_THINKING_LEVELS as readonly string[]).includes(value);
}

export interface AgentModelInfo {
  provider: string;
  id: string;
  name?: string;
  reasoning: boolean;
}

export interface AgentSessionState {
  sessionId: string;
  isStreaming: boolean;
  model?: AgentModelInfo;
  thinkingLevel?: AgentThinkingLevel;
}

export interface AgentModelCatalog {
  state: AgentSessionState;
  models: AgentModelInfo[];
}

export interface AgentThinkingSupport {
  state: AgentSessionState;
  levels: AgentThinkingLevel[];
}

export interface AgentRunOptions {
  runId: string;
  /** Required by long-lived transports to isolate scope-bound children. */
  scopeId?: string;
  /** Required by long-lived transports to bind policy/resource identity. */
  policyFingerprint?: string;
  prompt: string;
  /** Bridge prompts are wrapped; explicit /pi commands must remain byte-for-byte raw. */
  promptMode?: 'bridge' | 'pi-command';
  interaction?: Omit<AgentInteractionContext, 'runId' | 'scopeId'>;
  cwd: string;
  sessionId?: string;
  model?: string;
  thinkingLevel?: AgentThinkingLevel;
  accessMode: AccessMode;
  /** Handoff uses Pi's native fork, user config, full tools and explicit project trust. */
  handoff?: { sourcePath?: string; sourceSessionId: string };
  stopGraceMs?: number;
  attachments?: string[];
}

export type AgentStopReason = 'interrupted' | 'timeout';
export type AgentControlDisposition = 'queued' | 'handled';

export interface AgentRun {
  readonly runId: string;
  readonly events: AsyncIterable<AgentEvent>;
  stop(reason?: AgentStopReason): Promise<void>;
  waitForExit(timeoutMs: number): Promise<boolean>;
}

export interface AgentBotIdentity {
  openId: string;
  name?: string;
}

export interface AgentAdapter {
  readonly id: 'pi';
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  checkAvailability?(): Promise<AgentAvailability>;
  prepareRun?(opts?: AgentRunOptions): Promise<void>;
  run(opts: AgentRunOptions): AgentRun;
  probeModel?(opts: Omit<AgentRunOptions, 'runId' | 'prompt' | 'sessionId' | 'attachments'>): Promise<void>;
  listCommands?(opts: AgentRunOptions): Promise<AgentSlashCommand[]>;
  /** Create a native Pi fork and return its authoritative initial state without prompting the model. */
  forkSession?(opts: AgentRunOptions): Promise<AgentSessionState>;
  getSessionState?(opts: AgentRunOptions): Promise<AgentSessionState>;
  listModels?(opts: AgentRunOptions): Promise<AgentModelCatalog>;
  setModel?(opts: AgentRunOptions, provider: string, modelId: string): Promise<AgentSessionState>;
  listThinkingLevels?(opts: AgentRunOptions): Promise<AgentThinkingSupport>;
  setThinkingLevel?(opts: AgentRunOptions, level: AgentThinkingLevel): Promise<AgentSessionState>;
  /** Evict the reusable transport resource for this exact route after uncertain compensation. */
  invalidateSession?(opts: AgentRunOptions): Promise<void>;
  control?(runId: string, kind: 'steer' | 'follow-up', prompt: string): Promise<AgentControlDisposition>;
  /** Close reusable idle resources before profile-local session maintenance. */
  closeIdleSessions?(): Promise<void>;
  setBotIdentity?(identity: AgentBotIdentity): void;
  setInteractionPort?(port: AgentInteractionPort): void;
  dispose?(): Promise<void>;
}

export type AgentAvailability = { ok: true; version?: string } | { ok: false; error: Error };
