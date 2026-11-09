import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicRequestToCanonical } from '../dist/protocol/anthropic.js';
import { chatRequestToCanonical } from '../dist/protocol/chat-completions.js';
import { responsesRequestToCanonical } from '../dist/protocol/responses.js';
import {
  validateCanonicalRequest,
  validateContextSize,
  validateModelInputModalities,
  maxContextBytes,
} from '../dist/protocol/validation.js';
import { createApp } from '../dist/daemon/server.js';
import { claudeModelsResponse, codexModelsResponse, openAiModelsResponse } from '../dist/models/discovery.js';
import { resolveTraeInputModalities } from '../dist/models/modality.js';
import { ModelRegistry } from '../dist/models/registry.js';
import xAdapterPiExtension from '../dist/pi/index.js';

function withEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('Responses input item policy counts original input items rather than canonical messages', () => {
  withEnv({ X_ADAPTER_MAX_INPUT_ITEMS: '1' }, () => {
    const request = responsesRequestToCanonical({
      model: 'trae-test',
      input: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
    });
    const error = validateCanonicalRequest(request);
    assert.equal(error?.code, 'too_many_input_items');
    assert.equal(error?.param, 'input');
  });
});

test('metadata byte policy applies consistently to Chat, Responses, and Anthropic canonical requests', () => {
  withEnv({ X_ADAPTER_MAX_METADATA_BYTES: '10' }, () => {
    const metadata = { label: 'too-large' };
    const requests = [
      chatRequestToCanonical({ model: 'trae-test', metadata, messages: [{ role: 'user', content: 'hello' }] }),
      responsesRequestToCanonical({ model: 'trae-test', metadata, input: 'hello' }),
      anthropicRequestToCanonical({
        model: 'trae-test',
        metadata,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ];
    for (const request of requests) {
      const error = validateCanonicalRequest(request);
      assert.equal(error?.code, 'metadata_too_large');
      assert.equal(error?.param, 'metadata');
    }
  });
});

test('zero input and metadata limits preserve existing requests', () => {
  withEnv({ X_ADAPTER_MAX_INPUT_ITEMS: '0', X_ADAPTER_MAX_METADATA_BYTES: '0' }, () => {
    const request = responsesRequestToCanonical({
      model: 'trae-test',
      metadata: { label: 'x'.repeat(1000) },
      input: Array.from({ length: 20 }, (_, index) => ({ role: 'user', content: String(index) })),
    });
    assert.equal(validateCanonicalRequest(request), undefined);
  });
});

test('input-item and metadata limits allow requests exactly at their configured boundary', () => {
  withEnv({ X_ADAPTER_MAX_INPUT_ITEMS: '2', X_ADAPTER_MAX_METADATA_BYTES: '15' }, () => {
    const request = responsesRequestToCanonical({
      model: 'trae-test',
      metadata: { key: 'value' },
      input: [
        { role: 'user', content: 'one' },
        { role: 'user', content: 'two' },
      ],
    });
    assert.equal(validateCanonicalRequest(request), undefined);
  });
});

test('context byte budget includes images, tool arguments and UTF-8 bytes at exact boundaries', () => {
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '截图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(1024) } },
      ],
    },
    {
      role: 'assistant',
      content: [],
      tool_calls: [{ id: 'c', type: 'function', function: { name: 'test', arguments: 'x'.repeat(100) } }],
    },
  ];
  const bytes = Buffer.byteLength(JSON.stringify(messages));
  withEnv({ X_ADAPTER_MAX_CONTEXT_BYTES: String(bytes) }, () => {
    assert.equal(validateContextSize(messages), undefined);
    assert.equal(
      validateContextSize([{ ...messages[0], tool_output_attachment: { call_id: 'c' } }, messages[1]]),
      undefined,
    );
  });
  withEnv({ X_ADAPTER_MAX_CONTEXT_BYTES: String(bytes - 1) }, () => {
    assert.equal(validateContextSize(messages)?.code, 'context_too_large');
    assert.equal(validateContextSize(messages.slice(0, 1)), undefined);
  });
  withEnv({ X_ADAPTER_MAX_CONTEXT_BYTES: '0' }, () => assert.equal(validateContextSize(messages), undefined));
  for (const value of ['-1', 'invalid', undefined]) {
    withEnv({ X_ADAPTER_MAX_CONTEXT_BYTES: value }, () => assert.equal(maxContextBytes(), 32 * 1024 * 1024));
  }
  withEnv({ X_ADAPTER_MAX_IMAGE_BYTES: '2' }, () => {
    assert.equal(validateCanonicalRequest({ model: 'trae-test', messages })?.code, 'image_too_large');
  });
});

test('model discovery exposes the enforced image capability in all dialects', () => {
  const base = {
    id: 'trae-global-vision',
    provider: 'trae',
    upstreamId: 'global-vision',
    configName: 'vision',
    modelName: 'vision',
    displayName: 'Global Vision',
  };
  const vision = { ...base, inputModalities: ['text', 'image'], metadata: { input_modalities: ['text'] } };
  const textOnly = { ...base, id: 'trae-global-text', inputModalities: ['text'] };

  assert.deepEqual(openAiModelsResponse([vision]).data[0].metadata.input_modalities, ['text', 'image']);
  assert.deepEqual(codexModelsResponse([vision]).models[0].input_modalities, ['text', 'image']);
  assert.equal(codexModelsResponse([vision]).models[0].supports_image_detail_original, true);
  assert.equal(codexModelsResponse([textOnly]).models[0].supports_image_detail_original, false);
  assert.equal(claudeModelsResponse([vision]).data[0].capabilities.image_input.supported, true);
  assert.equal(claudeModelsResponse([textOnly]).data[0].capabilities.image_input.supported, false);
});

test('Codex discovery uses total context separately from provider input and output limits', () => {
  const max = {
    id: 'trae-global-deepseek-v4.1-flash-max',
    provider: 'trae',
    upstreamId: 'global-deepseek-v4.1-flash-max',
    configName: 'deepseek-v4.1-flash',
    modelName: 'deepseek-v4.1-flash__max',
    displayName: 'Global DeepSeek-V4.1-Flash / Max',
    maxInputTokens: 936000,
    maxOutputTokens: 64000,
    contextWindowTokens: 1000000,
  };
  const codex = codexModelsResponse([max]).models[0];
  const openai = openAiModelsResponse([max]).data[0];
  assert.equal(codex.context_window, 1000000);
  assert.equal(codex.max_context_window, 1000000);
  assert.equal(codex.max_output_tokens, 64000);
  assert.equal(openai.metadata.model_name, 'deepseek-v4.1-flash__max');
  assert.equal(openai.metadata.prompt_max_tokens, 936000);
  assert.equal(openai.metadata.max_tokens, 64000);
  assert.equal(openai.metadata.context_window_tokens, 1000000);
});

test('provider metadata cannot override dialect display_name or reasoning levels', () => {
  // This test pins the writing order: every dialect object spreads provider
  // metadata first, so an upstream `display_name` copy can never win. Trae and
  // Doubao Work publish their own upstream display names, and only the prefix
  // x-adapter adds keeps the two routes apart in a picker.
  const trae = {
    id: 'trae-global-deepseek-v4.1-flash',
    provider: 'trae',
    upstreamId: 'global-deepseek-v4.1-flash',
    configName: 'deepseek-v4.1-flash',
    modelName: 'deepseek-v4.1-flash__dev',
    displayName: 'Global DeepSeek-V4.1-Flash',
    modelLoad: 42.6,
    supportedReasoningLevels: ['low', 'high'],
    metadata: {
      display_name: 'DeepSeek-V4.1-Flash',
      supported_reasoning_levels: ['low', 'medium', 'high', 'max'],
    },
  };
  const codex = codexModelsResponse([trae]).models[0];
  const claude = claudeModelsResponse([trae]).data[0];
  const openai = openAiModelsResponse([trae]).data[0];
  assert.equal(codex.display_name, 'Trae Global DeepSeek-V4.1-Flash');
  assert.equal(claude.display_name, 'Trae Global DeepSeek-V4.1-Flash');
  assert.deepEqual(
    codex.supported_reasoning_levels.map((level) => level.effort),
    ['low', 'high'],
  );
  // Provider-private extras still reach the response.
  assert.equal(codex.model_load, 42.6);
  // The OpenAI dialect keeps the provider's raw name: the prefix lives only in
  // the Codex and Claude top-level `display_name`.
  assert.equal(openai.metadata.display_name, 'Global DeepSeek-V4.1-Flash');
});

test('provider metadata cannot shadow any dialect field, and extras stay additive', () => {
  // The merge order is a writing rule, not one field's bug: a dialect field
  // added above the spread would silently lose to an upstream key. Pin the
  // whole reserved set instead of checking one key at a time.
  const hostile = {
    id: 'doubao-work-pro',
    provider: 'doubao',
    upstreamId: 'work-pro',
    configName: 'work-pro',
    modelName: 'work-pro',
    displayName: 'Pro',
    isDefault: true,
    maxInputTokens: 128000,
    maxOutputTokens: 32000,
    contextWindowTokens: 128000,
    modelLoad: 42.6,
    quota: { remaining: 12 },
    supportedReasoningLevels: ['low', 'high'],
    defaultReasoningLevel: 'high',
    inputModalities: ['text'],
    metadata: {
      id: 'hijacked',
      type: 'hijacked',
      slug: 'hijacked',
      display_name: 'Hijacked',
      supported_reasoning_levels: ['low'],
      default_reasoning_level: 'low',
      max_output_tokens: 1,
      max_tokens: 1,
      max_input_tokens: 1,
      context_window: 1,
      context_window_tokens: 1,
      max_context_window: 1,
      input_modalities: ['image'],
      supports_image_detail_original: true,
      provider: 'trae',
      upstream_id: 'hijacked',
      hot: 999,
      model_load: 999,
      model_load_percent: 999,
      quota: { hijacked: true },
      is_default: false,
      priority: 999,
      owned_by: 'trae',
      root: 'hijacked',
      created: 1,
      capabilities: { image_input: { supported: true } },
      prompt_max_tokens: 1,
      // A provider-private extra that must survive the merge.
      backend_variant: 'standard',
    },
  };

  const codex = codexModelsResponse([hostile]).models[0];
  assert.equal(codex.slug, 'doubao-work-pro');
  assert.equal(codex.display_name, 'Doubao Work Pro');
  assert.deepEqual(
    codex.supported_reasoning_levels.map((level) => level.effort),
    ['low', 'high'],
  );
  assert.equal(codex.default_reasoning_level, 'high');
  assert.equal(codex.max_output_tokens, 32000);
  assert.equal(codex.context_window, 128000);
  assert.equal(codex.max_context_window, 128000);
  assert.equal(codex.priority, -1000);
  assert.equal(codex.provider, 'doubao');
  assert.equal(codex.upstream_id, 'work-pro');
  assert.equal(codex.model_load, 42.6);
  assert.equal(codex.model_load_percent, 42.6);
  assert.equal(codex.hot, 42.6);
  assert.deepEqual(codex.input_modalities, ['text']);
  assert.equal(codex.supports_image_detail_original, false);
  assert.deepEqual(codex.quota, { remaining: 12 });
  assert.equal(codex.backend_variant, 'standard');

  const claude = claudeModelsResponse([hostile]).data[0];
  assert.equal(claude.id, 'claude-doubao-work-pro[1m]');
  assert.equal(claude.type, 'model');
  assert.equal(claude.display_name, 'Doubao Work Pro');
  assert.equal(claude.max_tokens, 32000);
  assert.equal(claude.max_input_tokens, 128000);
  assert.equal(claude.provider, 'doubao');
  assert.equal(claude.upstream_id, 'work-pro');
  assert.equal(claude.model_load, 42.6);
  assert.deepEqual(claude.input_modalities, ['text']);
  assert.equal(claude.capabilities.image_input.supported, false);
  assert.equal(claude.capabilities.effort.low.supported, true);
  assert.equal(claude.capabilities.effort.max.supported, false);
  assert.equal(claude.backend_variant, 'standard');

  const openai = openAiModelsResponse([hostile]).data[0];
  assert.equal(openai.id, 'doubao-work-pro');
  assert.equal(openai.owned_by, 'doubao');
  assert.equal(openai.root, 'doubao-work-pro');
  assert.equal(openai.created, 0);
  assert.equal(openai.metadata.provider, 'doubao');
  assert.equal(openai.metadata.upstream_id, 'work-pro');
  assert.equal(openai.metadata.config_name, 'work-pro');
  assert.equal(openai.metadata.model_name, 'work-pro');
  assert.equal(openai.metadata.display_name, 'Pro');
  assert.equal(openai.metadata.is_default, true);
  assert.equal(openai.metadata.max_tokens, 32000);
  assert.equal(openai.metadata.prompt_max_tokens, 128000);
  assert.equal(openai.metadata.context_window_tokens, 128000);
  assert.equal(openai.metadata.model_load, 42.6);
  assert.equal(openai.metadata.model_load_percent, 42.6);
  assert.equal(openai.metadata.hot, 42.6);
  assert.deepEqual(openai.metadata.input_modalities, ['text']);
  assert.deepEqual(openai.metadata.quota, { remaining: 12 });
  assert.equal(openai.metadata.backend_variant, 'standard');
});

test('GET /v1/models/:id keeps dialect fields ahead of provider metadata', async () => {
  // This endpoint builds its own OpenAI-shaped model instead of going through
  // openAiModelsResponse, so the merge order has to be pinned here too.
  const adapters = [
    {
      id: 'trae',
      displayName: 'Trae',
      async discoverModels() {
        return {
          provider: 'trae',
          displayName: 'Trae',
          models: [
            {
              upstreamId: 'global-deepseek-v4.1-flash',
              configName: 'deepseek-v4.1-flash',
              modelName: 'deepseek-v4.1-flash__dev',
              displayName: 'Global DeepSeek-V4.1-Flash',
              modelLoad: 28.67,
              metadata: {
                display_name: 'DeepSeek-V4.1-Flash',
                config_name: 'upstream-config',
                model_load: 999,
                hot: 999,
                backend_variant: 'standard',
              },
            },
          ],
        };
      },
    },
  ];
  const app = createApp({ adapters, registry: new ModelRegistry(adapters) });
  const response = await app.request('http://127.0.0.1:10100/v1/models/trae-global-deepseek-v4.1-flash', {
    headers: { host: '127.0.0.1:10100' },
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.id, 'trae-global-deepseek-v4.1-flash');
  assert.equal(payload.owned_by, 'trae');
  assert.equal(payload.metadata.config_name, 'deepseek-v4.1-flash');
  assert.equal(payload.metadata.display_name, 'Global DeepSeek-V4.1-Flash');
  assert.equal(payload.metadata.model_load, 28.67);
  assert.equal(payload.metadata.model_load_percent, 28.67);
  assert.equal(payload.metadata.hot, 28.67);
  // Provider-private extras still reach the payload.
  assert.equal(payload.metadata.backend_variant, 'standard');
});

test('Trae image capability follows upstream metadata with measured exceptions', () => {
  assert.deepEqual(resolveTraeInputModalities('gpt-5.6-sol', true), ['text', 'image']);
  assert.deepEqual(resolveTraeInputModalities('unknown', undefined), ['text']);
  assert.deepEqual(resolveTraeInputModalities('deepseek-v4.1-flash', false), ['text', 'image']);
  assert.deepEqual(resolveTraeInputModalities('DeepSeek-V4-Pro', true), ['text']);
});

test('text-only models reject canonical images while image-capable models accept them', () => {
  const request = responsesRequestToCanonical({
    model: 'trae-global-test',
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe' },
          { type: 'input_image', image_url: 'data:image/png;base64,AAAAAAAAAAA=' },
        ],
      },
    ],
  });
  const error = validateModelInputModalities(request, {
    id: 'trae-global-text-only',
    inputModalities: ['text'],
  });
  assert.equal(error?.code, 'unsupported_multimodal_content');
  assert.equal(error?.param, 'messages[0].content[1]');
  assert.match(error?.message, /trae-global-text-only/);
  assert.equal(
    validateModelInputModalities(request, {
      id: 'trae-global-vision',
      inputModalities: ['text', 'image'],
    }),
    undefined,
  );
});

test('Pi extension preserves explicit image capabilities and fails closed when absent', async () => {
  const previousFetch = globalThis.fetch;
  const previousBaseUrl = process.env.X_ADAPTER_BASE_URL;
  const previousAutoStart = process.env.X_ADAPTER_AUTO_START;
  const previousOffline = process.env.PI_OFFLINE;
  const registered = [];
  process.env.X_ADAPTER_BASE_URL = 'http://127.0.0.1:10100';
  process.env.X_ADAPTER_AUTO_START = '0';
  delete process.env.PI_OFFLINE;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/health')) {
      return new Response(
        JSON.stringify({ ok: true, name: 'x-adapter', version: '0.1.0', host: '127.0.0.1', port: 10100 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.endsWith('/v1/models')) {
      return new Response(
        JSON.stringify({
          models: [
            {
              slug: 'trae-global-vision',
              display_name: 'Trae Global Vision',
              context_window: 128000,
              max_output_tokens: 32000,
              input_modalities: ['text', 'image'],
              supported_reasoning_levels: [{ effort: 'high' }],
            },
            {
              slug: 'doubao-work-auto',
              display_name: 'Doubao Work Auto',
              context_window: 128000,
              supported_reasoning_levels: [{ effort: 'high' }],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  try {
    await xAdapterPiExtension({
      registerProvider(name, config) {
        registered.push({ name, config });
      },
      registerCommand() {},
      on() {
        return () => {};
      },
      async exec() {
        throw new Error('exec must not run for a healthy gateway');
      },
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'x-adapter');
    assert.deepEqual(registered[0].config.models[0].input, ['text', 'image']);
    assert.deepEqual(registered[0].config.models[1].input, ['text']);
    // The declared output limit must reach Pi instead of the package default.
    assert.equal(registered[0].config.models[0].maxTokens, 32000);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBaseUrl === undefined) {
      delete process.env.X_ADAPTER_BASE_URL;
    } else {
      process.env.X_ADAPTER_BASE_URL = previousBaseUrl;
    }
    if (previousAutoStart === undefined) {
      delete process.env.X_ADAPTER_AUTO_START;
    } else {
      process.env.X_ADAPTER_AUTO_START = previousAutoStart;
    }
    if (previousOffline === undefined) {
      delete process.env.PI_OFFLINE;
    } else {
      process.env.PI_OFFLINE = previousOffline;
    }
  }
});

test('Doubao and Trae hosted tools fail closed before provider execution', () => {
  const doubao = responsesRequestToCanonical({
    model: 'doubao-work-orange',
    input: 'search',
    tools: [{ type: 'web_search_preview' }],
  });
  assert.equal(validateCanonicalRequest(doubao)?.code, 'unsupported_hosted_tool');

  const trae = responsesRequestToCanonical({
    model: 'trae-global-offline-model',
    input: 'search',
    tools: [{ type: 'web_search_preview' }],
  });
  const error = validateCanonicalRequest(trae);
  assert.equal(error?.code, 'unsupported_hosted_search');
  assert.equal(error?.status, 400);
});

test('tool validation rejects duplicate canonical names including namespace flattening collisions', () => {
  const direct = responsesRequestToCanonical({
    model: 'trae-test',
    input: 'hello',
    tools: [
      { type: 'function', name: 'same', parameters: { type: 'object' } },
      { type: 'custom', name: 'same' },
    ],
  });
  assert.equal(validateCanonicalRequest(direct)?.code, 'duplicate_tool_name');

  const flattened = responsesRequestToCanonical({
    model: 'trae-test',
    input: 'hello',
    tools: [
      { type: 'function', name: 'namespace_child', parameters: { type: 'object' } },
      {
        type: 'namespace',
        namespace: 'namespace',
        tools: [{ type: 'function', name: 'child', parameters: { type: 'object' } }],
      },
    ],
  });
  assert.equal(validateCanonicalRequest(flattened)?.code, 'duplicate_tool_name');

  const namespaceCollision = responsesRequestToCanonical({
    model: 'trae-test',
    input: 'hello',
    tools: [
      { type: 'namespace', namespace: 'a_b', tools: [{ type: 'function', name: 'c', parameters: {} }] },
      { type: 'namespace', namespace: 'a', tools: [{ type: 'function', name: 'b_c', parameters: {} }] },
    ],
  });
  assert.equal(validateCanonicalRequest(namespaceCollision)?.code, 'duplicate_tool_name');
});

function piStub(options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const sentMessages = [];
  const selectedModels = [];
  return {
    handlers,
    commands,
    sentMessages,
    selectedModels,
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerProvider() {},
    sendMessage(message, sendOptions) {
      sentMessages.push({ message, options: sendOptions });
    },
    async setModel(model) {
      selectedModels.push(model);
      return options.setModel ? options.setModel(model) : true;
    },
    async exec() {
      throw new Error('exec must not run in offline mode');
    },
  };
}

async function offlinePi(options) {
  return withEnv(
    {
      PI_OFFLINE: '1',
      X_ADAPTER_BASE_URL: undefined,
      X_ADAPTER_CLIENT_TOKEN: undefined,
      X_ADAPTER_PROVIDER_ID: undefined,
      X_ADAPTER_AUTO_START: undefined,
      X_ADAPTER_AUTO_INSTALL: undefined,
    },
    async () => {
      const pi = piStub(options);
      await xAdapterPiExtension(pi);
      return pi;
    },
  );
}

function switchContext(options = {}) {
  const notifications = [];
  const target = options.target ?? { provider: 'x-adapter', id: 'doubao-work-auto', name: 'Doubao Work Auto' };
  const branch = options.branch ?? [];
  const messages = options.messages ?? [];
  return {
    notifications,
    context: {
      cwd: '/tmp',
      model: options.model ?? { provider: 'x-adapter', id: 'trae-global-pro', name: 'Trae Global Pro' },
      modelRegistry: {
        find(provider, modelId) {
          return provider === target.provider && modelId === target.id ? target : undefined;
        },
        hasConfiguredAuth() {
          return options.hasAuth ?? true;
        },
      },
      sessionManager: {
        getBranch() {
          return branch;
        },
        buildSessionProjection() {
          return { messages };
        },
      },
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
      },
      async waitForIdle() {},
    },
    target,
    branch,
    messages,
  };
}

const piToolMessages = [
  { role: 'user', content: [{ type: 'text', text: 'read README' }] },
  {
    role: 'assistant',
    stopReason: 'toolUse',
    content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'README.md' } }],
  },
  { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: '# readme' }] },
];

test('Pi Doubao switch command changes model directly when active context has no tool history', async () => {
  const pi = await offlinePi();
  const session = switchContext({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'hi' }] },
    ],
  });
  await pi.commands.get('x-adapter-doubao').handler('', session.context);

  assert.deepEqual(pi.selectedModels, [session.target]);
  assert.equal(pi.sentMessages.length, 0);
  assert.match(session.notifications.at(-1).message, /已切换到 doubao-work-auto/);
});

test('Pi Doubao switch command compacts tool history before switching and keeps raw transcript auditable', async () => {
  const pi = await offlinePi();
  const session = switchContext({ messages: piToolMessages });
  await pi.commands.get('x-adapter-doubao').handler('doubao-work-auto', session.context);

  // The model must not change until the handoff summary is persisted and verified.
  assert.equal(pi.selectedModels.length, 0);
  assert.equal(pi.sentMessages.length, 1);
  assert.equal(pi.sentMessages[0].message.customType, 'x-adapter-doubao-handoff');
  assert.equal(pi.sentMessages[0].options.triggerTurn, true);
  const handoffId = pi.sentMessages[0].message.details.handoffId;
  assert.equal(typeof handoffId, 'string');

  const startEvent = {
    messageType: 'custom',
    message: pi.sentMessages[0].message,
    systemPromptOptions: { selectedTools: ['read', 'bash'] },
  };
  pi.handlers.get('before_agent_start')(startEvent, session.context);
  // The summary turn must run without tools, or it could mutate the workspace.
  assert.deepEqual(startEvent.systemPromptOptions.selectedTools, []);

  pi.handlers.get('agent_end')(
    {
      messages: [
        ...piToolMessages,
        {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: '## Goal\nContinue the README work.' }],
        },
      ],
    },
    session.context,
  );
  const boundary = pi.handlers.get('agent_before_settle')({ outcome: 'completed', entries: [] }, session.context);
  assert.deepEqual(boundary.entries, [
    {
      type: 'compaction',
      summary: '## Goal\nContinue the README work.',
      firstKeptEntryId: null,
      details: {
        kind: 'x-adapter-doubao-handoff',
        handoffId,
        sourceModel: 'x-adapter/trae-global-pro',
        targetModel: 'x-adapter/doubao-work-auto',
      },
    },
  ]);
  // Pi persists null as the compaction entry's own firstKeptEntryId. Raw entries
  // stay in the branch; only the active model projection is replaced.
  session.branch.push({ type: 'compaction', details: boundary.entries[0].details });
  session.context.sessionManager.buildSessionProjection = () => ({
    messages: [{ role: 'compactionSummary', content: boundary.entries[0].summary }],
  });
  await pi.handlers.get('agent_settled')({ aborted: false }, session.context);

  assert.deepEqual(pi.selectedModels, [session.target]);
  assert.deepEqual(session.messages, piToolMessages);
  assert.match(session.notifications.at(-1).message, /已切换到 doubao-work-auto/);
});

test('Pi Doubao switch command refuses to switch when the persisted projection still has tool history', async () => {
  const pi = await offlinePi();
  const session = switchContext({ messages: piToolMessages });
  await pi.commands.get('x-adapter-doubao').handler('', session.context);
  pi.handlers.get('before_agent_start')(
    { messageType: 'custom', message: pi.sentMessages[0].message, systemPromptOptions: { selectedTools: ['read'] } },
    session.context,
  );
  pi.handlers.get('agent_end')(
    { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'safe summary' }] }] },
    session.context,
  );
  const boundary = pi.handlers.get('agent_before_settle')({ outcome: 'completed', entries: [] }, session.context);
  session.branch.push({ type: 'compaction', details: boundary.entries[0].details });
  await pi.handlers.get('agent_settled')({ aborted: false }, session.context);

  assert.equal(pi.selectedModels.length, 0);
  assert.match(session.notifications.at(-1).message, /活动上下文仍含工具历史/);
});

test('Pi Doubao switch command fails before summarizing when target Pi auth is unavailable', async () => {
  const pi = await offlinePi();
  const session = switchContext({ hasAuth: false, messages: piToolMessages });
  await pi.commands.get('x-adapter-doubao').handler('', session.context);

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(pi.selectedModels.length, 0);
  assert.match(session.notifications.at(-1).message, /没有可用的 Pi provider 认证/);
});

test('Pi Doubao switch command fails closed when the handoff turn tries to call a tool', async () => {
  const pi = await offlinePi();
  const session = switchContext({ messages: piToolMessages });
  await pi.commands.get('x-adapter-doubao').handler('', session.context);
  pi.handlers.get('before_agent_start')(
    { messageType: 'custom', message: pi.sentMessages[0].message, systemPromptOptions: { selectedTools: ['read'] } },
    session.context,
  );

  assert.deepEqual(pi.handlers.get('tool_call')({ toolName: 'read' }, session.context), {
    block: true,
    terminate: true,
    reason: '豆包切换摘要不得执行工具；本次切换已安全取消。',
  });
  pi.handlers.get('agent_end')(
    { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'partial' }] }] },
    session.context,
  );
  assert.equal(
    pi.handlers.get('agent_before_settle')({ outcome: 'completed', entries: [] }, session.context),
    undefined,
  );
  await pi.handlers.get('agent_settled')({ aborted: false }, session.context);

  assert.equal(pi.selectedModels.length, 0);
  assert.match(session.notifications.at(-1).message, /已取消切换/);
});

test('Pi Doubao switch command refuses to summarize when the current model is text-only Doubao', async () => {
  const pi = await offlinePi();
  const session = switchContext({
    model: { provider: 'x-adapter', id: 'doubao-work-auto', name: 'Doubao Work Auto' },
    target: { provider: 'x-adapter', id: 'doubao-work-pro', name: 'Doubao Work Pro' },
    messages: piToolMessages,
  });
  await pi.commands.get('x-adapter-doubao').handler('doubao-work-pro', session.context);

  assert.equal(pi.sentMessages.length, 0);
  assert.equal(pi.selectedModels.length, 0);
  assert.match(session.notifications.at(-1).message, /请先切回支持工具 transcript 的模型/);
});

test('Pi extension registers the Doubao switch command in offline mode', async () => {
  const pi = await offlinePi();
  assert.ok(pi.commands.has('x-adapter'));
  assert.ok(pi.commands.has('x-adapter-doubao'));
});
