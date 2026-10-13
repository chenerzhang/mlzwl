import { randomBytes } from 'node:crypto';
import type { CardActionEvent } from '@larksuite/channel';
import type {
  AgentExtensionUIRequest,
  AgentExtensionUIResponse,
  AgentInteractionContext,
  AgentInteractionPort,
} from '../agent/types.js';
import type { ChannelPort } from './channel.js';

const MAX_WAIT_MS = 5 * 60_000;
const MAX_PENDING_PER_RUN = 4;
const MAX_PENDING_GLOBAL = 64;
const MAX_FIRE_AND_FORGET_PER_RUN = 32;
const FORM_INPUT_NAME = 'bridge_input';

interface PendingInteraction {
  token: string;
  context: AgentInteractionContext;
  request: Extract<AgentExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }>;
  optionByToken?: Map<string, string>;
  timer: NodeJS.Timeout;
  resolve(response: AgentExtensionUIResponse): void;
}

export class LarkInteractionBroker implements AgentInteractionPort {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly tokensByRun = new Map<string, Set<string>>();
  private readonly fireAndForgetCountByRun = new Map<string, number>();
  private disposed = false;

  constructor(private readonly channel: Pick<ChannelPort, 'send' | 'reply'>) {}

  async handle(
    context: AgentInteractionContext,
    request: AgentExtensionUIRequest,
  ): Promise<AgentExtensionUIResponse | void> {
    if (this.disposed) {
      return isDialog(request) ? { cancelled: true } : undefined;
    }
    if (!isDialog(request)) {
      const count = this.fireAndForgetCountByRun.get(context.runId) ?? 0;
      if (count >= MAX_FIRE_AND_FORGET_PER_RUN) {
        return undefined;
      }
      this.fireAndForgetCountByRun.set(context.runId, count + 1);
      await this.handleFireAndForget(context, request);
      return undefined;
    }
    if (
      this.pending.size >= MAX_PENDING_GLOBAL ||
      (this.tokensByRun.get(context.runId)?.size ?? 0) >= MAX_PENDING_PER_RUN
    ) {
      return { cancelled: true };
    }
    const token = randomBytes(24).toString('base64url');
    const optionByToken =
      request.method === 'select'
        ? new Map(request.options.map((option) => [randomBytes(18).toString('base64url'), option]))
        : undefined;
    return new Promise<AgentExtensionUIResponse>((resolve) => {
      const timeoutMs = Math.min(
        'timeoutMs' in request ? (request.timeoutMs ?? MAX_WAIT_MS) : MAX_WAIT_MS,
        MAX_WAIT_MS,
      );
      const timer = setTimeout(() => this.settle(token, { cancelled: true }), timeoutMs);
      timer.unref();
      const pending: PendingInteraction = { token, context, request, optionByToken, timer, resolve };
      this.pending.set(token, pending);
      let runTokens = this.tokensByRun.get(context.runId);
      if (!runTokens) {
        runTokens = new Set();
        this.tokensByRun.set(context.runId, runTokens);
      }
      runTokens.add(token);
      void this.sendPrivate(context, { card: interactionCard(pending) })
        .then(() => this.sendWaitingNotice(context))
        .catch(() => this.settle(token, { cancelled: true }));
    });
  }

  handleCardAction(event: CardActionEvent): Record<string, unknown> {
    const action = actionRecord(event.action.value);
    const formBinding =
      event.action.formValue && event.action.tag === 'button' && typeof event.action.name === 'string'
        ? bindingFromFormName(event.action.name)
        : undefined;
    const token = typeof action?.token === 'string' ? action.token : formBinding?.token;
    if (!token) {
      return toast('error', '无效的交互请求。');
    }
    const pending = this.pending.get(token);
    if (!pending) {
      return toast('warning', '该交互已过期或已经处理。');
    }
    if (event.operator.openId !== pending.context.actorOpenId) {
      return toast('error', '只有发起该 Pi 请求的用户可以操作。');
    }
    const actionName =
      typeof action?.action === 'string'
        ? action.action
        : event.action.formValue && event.action.tag === 'button'
          ? 'submit'
          : undefined;
    const claimedMethod = typeof action?.method === 'string' ? action.method : formBinding?.method;
    if (claimedMethod !== pending.request.method) {
      return toast('error', '交互类型不匹配。');
    }
    if (actionName === 'cancel') {
      this.settle(token, { cancelled: true });
      return toast('info', '已取消。');
    }
    if (pending.request.method === 'confirm') {
      if (actionName !== 'confirm') {
        return toast('error', '确认操作无效。');
      }
      this.settle(token, { confirmed: true });
      return toast('success', '已确认。');
    }
    if (pending.request.method === 'select') {
      const optionToken =
        typeof event.action.option === 'string'
          ? event.action.option
          : typeof action?.option === 'string'
            ? action.option
            : undefined;
      const value = optionToken ? pending.optionByToken?.get(optionToken) : undefined;
      if (actionName !== 'select' || value === undefined) {
        return toast('error', '选择项无效。');
      }
      this.settle(token, { value });
      return toast('success', '已提交选择。');
    }
    if (actionName !== 'submit') {
      return toast('error', '提交操作无效。');
    }
    const value = event.action.formValue?.[FORM_INPUT_NAME];
    if (typeof value !== 'string' || value.length > 1_000) {
      return toast('error', '输入内容无效或过长。');
    }
    this.settle(token, { value });
    return toast('success', '已提交。');
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  cancelRun(runId: string): void {
    for (const token of [...(this.tokensByRun.get(runId) ?? [])]) {
      this.settle(token, { cancelled: true });
    }
    this.fireAndForgetCountByRun.delete(runId);
  }

  dispose(): void {
    this.disposed = true;
    for (const token of [...this.pending.keys()]) {
      this.settle(token, { cancelled: true });
    }
    this.fireAndForgetCountByRun.clear();
  }

  private async handleFireAndForget(
    context: AgentInteractionContext,
    request: Exclude<AgentExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }>,
  ): Promise<void> {
    if (request.method === 'setTitle') {
      return;
    }
    const text = fireAndForgetText(request);
    if (!text) {
      return;
    }
    await this.sendPrivate(context, { text }).catch(() => {});
  }

  private sendPrivate(context: AgentInteractionContext, input: Parameters<ChannelPort['send']>[1]): Promise<unknown> {
    return context.surface === 'p2p' && context.privateReplyTarget
      ? this.channel.reply(context.privateReplyTarget, input)
      : this.channel.send(context.actorOpenId, input);
  }

  private async sendWaitingNotice(context: AgentInteractionContext): Promise<void> {
    if (context.surface === 'p2p' || !context.privateReplyTarget) {
      return;
    }
    await this.channel.reply(context.privateReplyTarget, { text: 'Pi 正在等待你在私聊中完成交互。' }).catch(() => {});
  }

  private settle(token: string, response: AgentExtensionUIResponse): void {
    const pending = this.pending.get(token);
    if (!pending) {
      return;
    }
    this.pending.delete(token);
    clearTimeout(pending.timer);
    const runTokens = this.tokensByRun.get(pending.context.runId);
    runTokens?.delete(token);
    if (!runTokens?.size) {
      this.tokensByRun.delete(pending.context.runId);
    }
    pending.resolve(response);
  }
}

function interactionCard(pending: PendingInteraction): object {
  const request = pending.request;
  const elements: object[] = [markdown(requestMarkdown(request))];
  if (request.method === 'confirm') {
    elements.push(
      buttonRow([
        button('确认', 'primary_filled', { token: pending.token, action: 'confirm', method: request.method }),
        button('取消', 'default', { token: pending.token, action: 'cancel', method: request.method }),
      ]),
    );
  } else if (request.method === 'select') {
    elements.push(
      {
        tag: 'select_static',
        placeholder: { tag: 'plain_text', content: '请选择' },
        options: [...(pending.optionByToken ?? [])].map(([optionToken, option], index) => ({
          text: { tag: 'plain_text', content: `${index + 1}. ${safeCardText(option, 90)}` },
          value: optionToken,
        })),
        width: 'fill',
        behaviors: [{ type: 'callback', value: { token: pending.token, action: 'select', method: request.method } }],
      },
      buttonRow([button('取消', 'default', { token: pending.token, action: 'cancel', method: request.method })]),
    );
  } else {
    elements.push({
      tag: 'form',
      name: 'bridge_form',
      elements: [
        {
          tag: 'input',
          name: FORM_INPUT_NAME,
          required: false,
          input_type: request.method === 'editor' ? 'multiline_text' : 'text',
          ...(request.method === 'editor' && request.prefill ? { default_value: request.prefill } : {}),
          ...(request.method === 'input' && request.placeholder
            ? { placeholder: { tag: 'plain_text', content: request.placeholder } }
            : {}),
          max_length: 1000,
        },
        {
          tag: 'button',
          name: formTokenName(request.method, pending.token),
          text: { tag: 'plain_text', content: '提交' },
          type: 'primary_filled',
          form_action_type: 'submit',
        },
      ],
    });
    elements.push(
      buttonRow([button('取消', 'default', { token: pending.token, action: 'cancel', method: request.method })]),
    );
  }
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: 'plain_text', content: safeCardText(request.title, 100) },
      template: request.method === 'confirm' ? 'orange' : 'blue',
    },
    body: { direction: 'vertical', elements },
  };
}

function requestMarkdown(request: PendingInteraction['request']): string {
  if (request.method === 'confirm') {
    return safeCardText(request.message, 2_000);
  }
  if (request.method === 'select') {
    return 'Pi 扩展正在等待你的选择。';
  }
  if (request.method === 'editor' && request.prefill) {
    return 'Pi 扩展提供了预填内容；请检查后提交，或取消。';
  }
  return 'Pi 扩展正在等待你的输入。';
}

function fireAndForgetText(
  request: Exclude<AgentExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }>,
): string | undefined {
  if (request.method === 'notify') {
    return `Pi 扩展通知（${request.notifyType}）：${safeCardText(request.message, 2_000)}`;
  }
  if (request.method === 'setStatus') {
    return request.statusText ? `Pi 扩展状态：${safeCardText(request.statusText, 500)}` : undefined;
  }
  if (request.method === 'setWidget') {
    return request.widgetLines?.length
      ? `Pi 扩展信息：\n${request.widgetLines.map((line) => safeCardText(line, 500)).join('\n')}`
      : undefined;
  }
  if (request.method === 'set_editor_text') {
    return 'Pi 扩展提供了编辑器建议文本；Bridge 不会自动提交或执行该文本。';
  }
  return undefined;
}

function markdown(content: string): object {
  return { tag: 'markdown', content };
}

function buttonRow(buttons: object[]): object {
  return {
    tag: 'column_set',
    horizontal_spacing: 'small',
    columns: buttons.map((element) => ({ tag: 'column', width: 'weighted', weight: 1, elements: [element] })),
  };
}

function button(text: string, type: string, value: Record<string, string>): object {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: safeCardText(text, 100) },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function formTokenName(method: 'input' | 'editor', token: string): string {
  return `t_${method}_${token}`;
}

function bindingFromFormName(name: string): { method: 'input' | 'editor'; token: string } | undefined {
  const match = /^t_(input|editor)_([A-Za-z0-9_-]{32})$/.exec(name);
  return match ? { method: match[1] as 'input' | 'editor', token: match[2]! } : undefined;
}

function actionRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function toast(type: 'success' | 'info' | 'error' | 'warning', content: string): Record<string, unknown> {
  return { toast: { type, content } };
}

function safeCardText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function isDialog(
  request: AgentExtensionUIRequest,
): request is Extract<AgentExtensionUIRequest, { method: 'select' | 'confirm' | 'input' | 'editor' }> {
  return (
    request.method === 'select' ||
    request.method === 'confirm' ||
    request.method === 'input' ||
    request.method === 'editor'
  );
}
