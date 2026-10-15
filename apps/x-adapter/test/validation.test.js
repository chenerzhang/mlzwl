import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicRequestToCanonical } from '../dist/protocol/anthropic.js';
import { chatRequestToCanonical } from '../dist/protocol/chat-completions.js';
import { responsesRequestToCanonical } from '../dist/protocol/responses.js';
import { validateCanonicalRequest, validateContextSize, maxContextBytes } from '../dist/protocol/validation.js';

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
