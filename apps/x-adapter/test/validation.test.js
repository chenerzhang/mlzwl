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
import { claudeModelsResponse, codexModelsResponse, openAiModelsResponse } from '../dist/models/discovery.js';
import { resolveTraeInputModalities } from '../dist/models/modality.js';
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
      async exec() {
        throw new Error('exec must not run for a healthy gateway');
      },
    });
    assert.equal(registered.length, 1);
    assert.equal(registered[0].name, 'x-adapter');
    assert.deepEqual(registered[0].config.models[0].input, ['text', 'image']);
    assert.deepEqual(registered[0].config.models[1].input, ['text']);
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
