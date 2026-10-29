import { DoubaoCredential } from '../auth/doubao-cookie.js';
import { doubaoTimeoutSignal } from '../config/env.js';
import { DoubaoSession } from '../state/session-store.js';
import {
  DOUBAO_BOT_ID,
  DOUBAO_CONVERSATION_TYPE,
  FetchLike,
  doubaoHeaders,
  doubaoHttpError,
  doubaoUrl,
  jsonResponse,
  uuid,
} from './client.js';

export type DoubaoModel = {
  id: string;
  modelItemKey: string;
  displayName: string;
  providerId: string;
  supportedReasoningLevels: string[];
  defaultReasoningLevel: string;
  maxInputTokens: number;
  maxOutputTokens: number;
};

const FALLBACK_MODELS: DoubaoModel[] = [
  model('work-auto', '9', 'Auto'),
  model('work-turbo', '4', '豆包 2.1 Turbo'),
  model('work-pro', '5', '豆包 2.1 Pro'),
  model('work-orange', '6', 'Orange 5.0'),
  model('work-gemini-flash', '1946880770', 'Gemini 3.7 Flash', 'cis'),
  model('work-gpt-sol', '2123520258', 'GPT-5.6 Sol', 'cis'),
];

function model(id: string, modelItemKey: string, displayName: string, providerId = ''): DoubaoModel {
  return {
    id,
    modelItemKey,
    displayName,
    providerId,
    supportedReasoningLevels: ['low', 'medium', 'high'],
    defaultReasoningLevel: 'high',
    maxInputTokens: 256_000,
    maxOutputTokens: 32_000,
  };
}

export function staticDoubaoModels(): DoubaoModel[] {
  return FALLBACK_MODELS.map((item) => ({ ...item, supportedReasoningLevels: [...item.supportedReasoningLevels] }));
}

export function reasoningEffort(value: string | undefined, fallback = 'high'): number {
  const normalized = value || fallback;
  if (normalized === 'low') {
    return 3;
  }
  if (normalized === 'medium') {
    return 4;
  }
  return 5;
}

export async function fetchDoubaoModels(
  credential: DoubaoCredential,
  fetchImpl: FetchLike = fetch,
): Promise<DoubaoModel[]> {
  const conversationId = await recentConversationId(credential, fetchImpl);
  // A newly created account can have no recent conversation yet. Keep the
  // provider usable with the verified built-in catalog so its first request
  // can create the conversation inline; later refreshes replace display and
  // reasoning metadata from the live action-bar catalog.
  if (!conversationId) {
    return staticDoubaoModels();
  }
  return fetchDoubaoModelsForConversation(credential, conversationId, fetchImpl);
}

export async function fetchDoubaoModelsForConversation(
  credential: DoubaoCredential,
  conversationId: string,
  fetchImpl: FetchLike = fetch,
): Promise<DoubaoModel[]> {
  if (!conversationId) {
    const error = new Error(
      'Doubao Work model discovery needs at least one existing conversation. Open Doubao Work once, or send a new chat, then refresh models.',
    );
    (error as NodeJS.ErrnoException).code = 'doubao_conversation_required';
    throw error;
  }
  const response = await fetchImpl(doubaoUrl('/alice/slot/action_bar_v3/brief_list', credential), {
    method: 'POST',
    headers: doubaoHeaders(credential, { contentType: 'application/json', refererConversationId: conversationId }),
    body: JSON.stringify({ language_code: 'zh', bot_id: DOUBAO_BOT_ID, conversation_id: conversationId }),
    signal: doubaoTimeoutSignal(),
  });
  const payload = await jsonResponse(response, 'Doubao model discovery');
  const discovered = new Map<string, { name: string; providerId: string; levels: string[]; defaultLevel: string }>();
  walk(payload, (value) => {
    const key = stringValue(value.model_item_key);
    const name = stringValue(value.name);
    if (!key || !name) {
      return;
    }
    const effortConfig = objectValue(value.reasoning_effort_config);
    const options = Array.isArray(effortConfig.option_list) ? effortConfig.option_list : [];
    const levels = options.flatMap((option) => {
      const level = Number(objectValue(option).level);
      return level === 3 ? ['low'] : level === 4 ? ['medium'] : level === 5 ? ['high'] : [];
    });
    const defaultLevelNumber = Number(effortConfig.default_level);
    const extra = objectValue(value.model_extra_params);
    discovered.set(key, {
      name,
      providerId: stringValue(extra.provider_id),
      levels: levels.length ? [...new Set(levels)] : ['low', 'medium', 'high'],
      defaultLevel: defaultLevelNumber === 3 ? 'low' : defaultLevelNumber === 4 ? 'medium' : 'high',
    });
  });
  if (discovered.size === 0) {
    const error = new Error('Doubao Work model catalog did not contain any recognized model entries.');
    (error as NodeJS.ErrnoException).code = 'upstream_invalid_response';
    throw error;
  }
  return staticDoubaoModels().map((fallback) => {
    const configured = discovered.get(fallback.modelItemKey);
    return configured
      ? {
          ...fallback,
          displayName: configured.name,
          providerId: configured.providerId || fallback.providerId,
          supportedReasoningLevels: configured.levels,
          defaultReasoningLevel: configured.defaultLevel,
        }
      : fallback;
  });
}

async function recentConversationId(credential: DoubaoCredential, fetchImpl: FetchLike): Promise<string> {
  const response = await fetchImpl(doubaoUrl('/im/chain/recent_conv', credential), {
    method: 'POST',
    headers: doubaoHeaders(credential),
    body: JSON.stringify({
      cmd: 3200,
      uplink_body: {
        pull_recent_conv_chain_uplink_body: {
          limit: 10,
          filter: { conversation_type: [], project_filter: 0, device_filter: 1 },
          message_count_per_conv: 0,
          api_version: 1,
          conv_version: 0,
          direction: 3,
          option: {
            not_need_message: true,
            need_complete_conversation: true,
            need_coco_bot: true,
            need_pc_pin_chain: true,
            pc_pin_query_type: 1,
            exclude_archive: true,
            only_archive: false,
          },
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1',
    }),
    signal: doubaoTimeoutSignal(),
  });
  const payload = await jsonResponse(response, 'Doubao recent conversations');
  const cells = payload.downlink_body?.pull_recent_conv_chain_downlink_body?.cells;
  if (!Array.isArray(cells)) {
    return '';
  }
  const candidate = cells.find((cell) => stringValue(cell?.conversation?.bot_id) === DOUBAO_BOT_ID);
  return stringValue(candidate?.conversation?.conversation_id);
}

export async function pullConversationState(
  credential: DoubaoCredential,
  conversationId: string,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<Pick<DoubaoSession, 'sectionId' | 'lastMessageIndex'>> {
  const response = await fetchImpl(doubaoUrl('/im/chain/single', credential, false), {
    method: 'POST',
    headers: doubaoHeaders(credential, { refererConversationId: conversationId }),
    body: JSON.stringify({
      cmd: 3100,
      uplink_body: {
        pull_singe_chain_uplink_body: {
          conversation_id: conversationId,
          anchor_index: Number.MAX_SAFE_INTEGER,
          conversation_type: DOUBAO_CONVERSATION_TYPE,
          direction: 1,
          limit: 20,
          ext: {},
          filter: { index_list: [] },
          evaluate_ab_params: '',
          evaluate_common_params: '',
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1',
    }),
    signal: doubaoTimeoutSignal(signal),
  });
  const payload = await jsonResponse(response, 'Doubao conversation state');
  const messages = payload.downlink_body?.pull_singe_chain_downlink_body?.messages;
  if (!Array.isArray(messages)) {
    return { sectionId: '', lastMessageIndex: 0 };
  }
  const latest = messages
    .map((message) => ({ message, index: Number(message?.index_in_conv) }))
    .filter(({ index }) => Number.isFinite(index))
    .sort((left, right) => right.index - left.index)[0];
  return { sectionId: normalizeProviderId(latest?.message?.section_id), lastMessageIndex: latest?.index ?? 0 };
}

export async function modifyConversation(
  credential: DoubaoCredential,
  session: DoubaoSession,
  modelConfig: DoubaoModel,
  effort: number,
  fetchImpl: FetchLike = fetch,
  signal?: AbortSignal,
): Promise<void> {
  if (session.modelItemKey === modelConfig.modelItemKey && session.reasoningEffort === effort) {
    return;
  }
  const response = await fetchImpl(doubaoUrl('/im/conversation/modify', credential, false), {
    method: 'POST',
    headers: doubaoHeaders(credential, { refererConversationId: session.conversationId }),
    body: JSON.stringify({
      cmd: 1114,
      uplink_body: {
        modify_conversation_uplink_body: {
          conversation_id: session.conversationId,
          conversation_type: DOUBAO_CONVERSATION_TYPE,
          bot_conversation_type: DOUBAO_CONVERSATION_TYPE,
          mode_id: '3',
          model_item_key: modelConfig.modelItemKey,
          reasoning_effort: String(effort),
        },
      },
      sequence_id: uuid(),
      channel: 2,
      version: '1',
    }),
    signal: doubaoTimeoutSignal(signal),
  });
  const payload = await jsonResponse(response, 'Doubao conversation modify');
  if (payload.downlink_body?.modify_conversation_downlink_body?.success !== true) {
    const error = new Error('Doubao conversation modify was not acknowledged.');
    (error as NodeJS.ErrnoException).code = 'upstream_response_error';
    throw error;
  }
}

export type CompletionInput = {
  credential: DoubaoCredential;
  prompt: string;
  model: DoubaoModel;
  effort: number;
  session?: DoubaoSession;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  /**
   * Re-armable inactivity signal for the long-lived completion stream. The
   * caller owns the timer and re-arms it on observable progress; this request
   * only forwards its abort so a stalled turn fails fast without imposing a
   * fixed total elapsed cap on healthy multi-step turns.
   */
  streamSignal?: AbortSignal;
};

export async function startCompletion(input: CompletionInput): Promise<Response> {
  const { credential, prompt, model: selectedModel, effort, session, fetchImpl = fetch, signal, streamSignal } = input;
  const localMessageId = uuid();
  const isNew = !session?.conversationId;
  const generalTaskParam = {
    action: 0,
    thread_local_message_id: [localMessageId],
    agent_task_param_change: { runtime_changed: false, device_changed: false, sandbox_auth_type_changed: false },
    need_modify_conversation: false,
    runtime_type: 1,
    agent_task_param: {
      runtime_type: 1,
      folder_name: '',
      device_name: '',
      workspace: '',
      local_app_id: '',
      local_device_id: '',
    },
  };
  const conversationInitOption = { project_id: '', need_ack_conversation: true };
  const modelExtraParams = selectedModel.providerId
    ? { total_window_size: '256000', model_type: 'custom', provider_id: selectedModel.providerId }
    : { total_window_size: '256000' };
  const body = {
    client_meta: {
      ...(isNew ? { local_conversation_id: `local_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}` } : {}),
      conversation_id: session?.conversationId ?? '',
      bot_id: DOUBAO_BOT_ID,
      last_section_id: session?.sectionId ?? '',
      last_message_index: isNew ? null : (session?.lastMessageIndex ?? 0),
    },
    messages: [
      {
        local_message_id: localMessageId,
        content_block: [{ block_type: 10000, content: { text_block: { text: prompt } }, block_id: uuid() }],
        message_status: 0,
      },
    ],
    option: {
      agent_mode: 1,
      need_deep_think: effort,
      need_create_conversation: isNew,
      unique_key: uuid(),
      ...(isNew
        ? {
            conversation_init_option: conversationInitOption,
            conversation_init_ext: {
              agent_task_param: JSON.stringify(generalTaskParam.agent_task_param),
              model_item_key: selectedModel.modelItemKey,
              reasoning_effort: String(effort),
              mode_id: '3',
            },
          }
        : {}),
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      general_task_param: generalTaskParam,
      recovery_option: {
        is_recovery: false,
        req_create_time_sec: Math.floor(Date.now() / 1000),
        append_sse_event_scene: 0,
      },
      model_config: {
        model_item_key: selectedModel.modelItemKey,
        model_extra_params: modelExtraParams,
        reasoning_effort: effort,
      },
      aggregate_params: {
        conversation_mode: '',
        mode_id: '3',
        model_item_key: selectedModel.modelItemKey,
        agent_mode: '1',
        reasoning_effort: String(effort),
        provider_id: selectedModel.providerId,
      },
    },
    ext: {
      general_task_param: JSON.stringify(generalTaskParam),
      use_deep_think: String(effort),
      agent_mode: '1',
      ...(isNew ? { conversation_init_option: JSON.stringify(conversationInitOption) } : {}),
      is_finish: '1',
    },
  };
  const response = await fetchImpl(doubaoUrl('/chat/completion', credential), {
    method: 'POST',
    headers: doubaoHeaders(credential, {
      accept: 'text/event-stream',
      contentType: 'application/json',
      refererConversationId: session?.conversationId,
      agw: 'str, str',
    }),
    body: JSON.stringify(body),
    // The completion stream can legitimately run for minutes, so it uses the
    // caller's re-armable inactivity signal instead of a fixed total timeout.
    signal: streamSignal ?? doubaoTimeoutSignal(signal),
  });
  if (!response.ok) {
    throw doubaoHttpError(response, 'Doubao completion');
  }
  if (!response.body) {
    const error = new Error('Doubao completion returned an empty response body.');
    (error as NodeJS.ErrnoException).code = 'upstream_invalid_response';
    throw error;
  }
  return response;
}

function walk(value: unknown, visit: (value: Record<string, any>) => void, depth = 0): void {
  if (!value || typeof value !== 'object' || depth > 20) {
    return;
  }
  if (!Array.isArray(value)) {
    visit(value as Record<string, any>);
  }
  for (const child of Object.values(value)) {
    walk(child, visit, depth + 1);
  }
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {};
}

function stringValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

function normalizeProviderId(value: unknown): string {
  const result = stringValue(value);
  return result === '0' ? '' : result;
}
