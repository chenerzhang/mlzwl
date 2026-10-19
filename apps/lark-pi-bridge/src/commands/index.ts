import { isAgentThinkingLevel, type AgentThinkingLevel } from '../agent/types.js';
import { isAccessMode, type AccessMode } from '../config/permissions.js';
import { parseSelectedModel } from '../config/pi-models.js';
import type { SessionCatalog, SessionCatalogIdentity } from '../session/catalog.js';
import { isExactPiSessionId } from '../session/handoff.js';

export type WorkspaceBridgeCommand =
  | { type: 'workspace-current' }
  | { type: 'workspace-list' }
  | { type: 'workspace-use'; alias?: string }
  | { type: 'workspace-default-get' }
  | { type: 'workspace-default-set'; alias: string };

export type BridgeCommand =
  | { type: 'handoff'; sessionId: string }
  | { type: 'handoff-off' }
  | { type: 'new' }
  | { type: 'resume' }
  | { type: 'status' }
  | { type: 'stop' }
  | { type: 'steer'; prompt: string }
  | { type: 'follow-up'; prompt: string }
  | { type: 'timeout'; minutes: number }
  | { type: 'access'; accessMode: AccessMode }
  | { type: 'model-current' }
  | { type: 'model-list' }
  | { type: 'model-use'; provider: string; modelId: string }
  | { type: 'thinking-current' }
  | { type: 'thinking-list' }
  | { type: 'thinking-set'; level: AgentThinkingLevel }
  | { type: 'pi-commands' }
  | { type: 'pi-command'; command: string; name: string }
  | { type: 'invalid'; command: string; message: string }
  | WorkspaceBridgeCommand;

export function parseBridgeCommand(text: string): BridgeCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return undefined;
  }
  const [name = '', ...args] = trimmed.split(/\s+/);
  switch (name.toLowerCase()) {
    case '/handoff':
      if (args.length !== 1) {
        return invalid(name, '用法：/handoff <exact-session-id>|off');
      }
      if (args[0]?.toLowerCase() === 'off') {
        return { type: 'handoff-off' };
      }
      return isExactPiSessionId(args[0]!)
        ? { type: 'handoff', sessionId: args[0]! }
        : invalid(name, 'handoff 只接受完整合法的 Pi session ID，不接受 partial 或路径。');
    case '/new':
      return noArgs(name, args, { type: 'new' });
    case '/resume':
      return noArgs(name, args, { type: 'resume' });
    case '/status':
      return noArgs(name, args, { type: 'status' });
    case '/stop':
      return noArgs(name, args, { type: 'stop' });
    case '/steer': {
      const prompt = args.join(' ').trim();
      return prompt ? { type: 'steer', prompt } : invalid(name, '用法：/steer <message>');
    }
    case '/follow-up':
    case '/followup': {
      const prompt = args.join(' ').trim();
      return prompt ? { type: 'follow-up', prompt } : invalid(name, '用法：/follow-up <message>');
    }
    case '/timeout': {
      if (args.length !== 1) {
        return invalid(name, '用法：/timeout <minutes>');
      }
      const minutes = Number(args[0]);
      return Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60
        ? { type: 'timeout', minutes }
        : invalid(name, 'timeout 必须是 0 到 1440 之间的分钟数。');
    }
    case '/pi': {
      const remainder = trimmed.slice(name.length).replace(/^\s+/, '');
      if (remainder.toLowerCase() === 'commands') {
        return { type: 'pi-commands' };
      }
      if (!remainder.startsWith('/')) {
        return invalid(name, '用法：/pi commands 或 /pi /<command> [args]');
      }
      const commandName = remainder.slice(1).split(/\s+/, 1)[0]?.trim();
      return commandName
        ? { type: 'pi-command', command: remainder, name: commandName }
        : invalid(name, '用法：/pi commands 或 /pi /<command> [args]');
    }
    case '/workspace':
      return parseWorkspaceCommand(args);
    case '/model':
      return parseModelCommand(args);
    case '/thinking':
      return parseThinkingCommand(args);
    case '/access':
      return args.length === 1 && isAccessMode(args[0])
        ? { type: 'access', accessMode: args[0] }
        : invalid(name, '用法：/access read-only|full');
    default:
      return invalid(name, `未知 bridge 命令：${name}`);
  }
}

export async function applySessionCommand(
  command: BridgeCommand,
  catalog: SessionCatalog,
  identity: SessionCatalogIdentity,
): Promise<string | undefined> {
  if (command.type === 'new') {
    await catalog.archive(identity);
    return '已创建新会话；下一条消息不会恢复此前的 Pi session。';
  }
  if (command.type === 'resume') {
    return catalog.activeFor(identity) ? '当前 scope 有可恢复的 Pi session。' : '当前 scope 没有可恢复的 Pi session。';
  }
  if (command.type === 'status') {
    const entry = catalog.activeFor(identity);
    return entry ? `当前 Pi session：${entry.sessionId}` : '当前 scope 没有活跃 Pi session。';
  }
  return undefined;
}

function parseWorkspaceCommand(args: string[]): BridgeCommand {
  if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === 'current')) {
    return { type: 'workspace-current' };
  }
  if (args.length === 1 && args[0]?.toLowerCase() === 'list') {
    return { type: 'workspace-list' };
  }
  if (args.length === 2 && args[0]?.toLowerCase() === 'use') {
    return args[1]?.toLowerCase() === 'default' ? { type: 'workspace-use' } : { type: 'workspace-use', alias: args[1] };
  }
  if (args.length === 2 && args[0]?.toLowerCase() === 'default' && args[1]?.toLowerCase() === 'get') {
    return { type: 'workspace-default-get' };
  }
  if (args.length === 3 && args[0]?.toLowerCase() === 'default' && args[1]?.toLowerCase() === 'set') {
    return { type: 'workspace-default-set', alias: args[2]! };
  }
  return invalid('/workspace', '用法：/workspace [current|list|use <alias|default>|default get|default set <alias>]');
}

function parseModelCommand(args: string[]): BridgeCommand {
  if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === 'current')) {
    return { type: 'model-current' };
  }
  if (args.length === 1 && args[0]?.toLowerCase() === 'list') {
    return { type: 'model-list' };
  }
  if (args.length === 2 && args[0]?.toLowerCase() === 'use') {
    const parsed = parseSelectedModel(args[1]!);
    return parsed
      ? { type: 'model-use', provider: parsed.providerId, modelId: parsed.modelId }
      : invalid('/model', '用法：/model use <provider>/<model>');
  }
  return invalid('/model', '用法：/model [current|list|use <provider>/<model>]');
}

function parseThinkingCommand(args: string[]): BridgeCommand {
  if (args.length === 0 || (args.length === 1 && args[0]?.toLowerCase() === 'current')) {
    return { type: 'thinking-current' };
  }
  if (args.length === 1 && args[0]?.toLowerCase() === 'list') {
    return { type: 'thinking-list' };
  }
  if (args.length === 1 && isAgentThinkingLevel(args[0]?.toLowerCase())) {
    return { type: 'thinking-set', level: args[0].toLowerCase() as AgentThinkingLevel };
  }
  return invalid('/thinking', '用法：/thinking [current|list|off|minimal|low|medium|high|xhigh|max]');
}

function noArgs<T extends BridgeCommand>(name: string, args: string[], command: T): T | BridgeCommand {
  return args.length === 0 ? command : invalid(name, `命令 ${name} 不接受参数。`);
}

function invalid(command: string, message: string): BridgeCommand {
  return { type: 'invalid', command, message };
}
