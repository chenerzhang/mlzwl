import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../dist/daemon/server.js';
import { ModelRegistry } from '../dist/models/registry.js';
import { createProviderAdapters } from '../dist/providers/adapters.js';
import { prepareDoubaoRequest } from '../dist/providers/doubao/request.js';

process.env.X_ADAPTER_REQUEST_LOGGING = '0';

const tool = {
  type: 'function',
  function: {
    name: 'lookup',
    description: 'Look something up.',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
};

const DOUBAO_TEST_MODEL = 'doubao-work-pro';
const DOUBAO_TEST_CLAUDE_MODEL = 'claude-doubao-work-pro[1m]';
const INLINE_IMAGE = 'data:image/png;base64,AAAAAAAAAAA=';

const canonicalTextRequest = {
  model: DOUBAO_TEST_MODEL,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};

function doubaoMockApp() {
  const doubao = createProviderAdapters().find((adapter) => adapter.id === 'doubao');
  assert.ok(doubao);
  return createApp({ adapters: [doubao], registry: new ModelRegistry([doubao]) });
}

async function withDoubaoMock(run) {
  const previous = process.env.DOUBAO_MOCK;
  process.env.DOUBAO_MOCK = '1';
  try {
    await run();
  } finally {
    if (previous === undefined) {
      delete process.env.DOUBAO_MOCK;
    } else {
      process.env.DOUBAO_MOCK = previous;
    }
  }
}

function headers(extra = {}) {
  return { host: '127.0.0.1:10100', 'content-type': 'application/json', ...extra };
}

test('Doubao strips optional tool catalogs without mutating the canonical request', () => {
  const request = { ...canonicalTextRequest, tools: [tool], tool_choice: 'auto' };
  const prepared = prepareDoubaoRequest(request);
  assert.equal(prepared.tools, undefined);
  assert.equal(prepared.tool_choice, undefined);
  assert.equal(request.tools.length, 1);
  assert.equal(request.tool_choice, 'auto');

  const disabled = prepareDoubaoRequest({ ...canonicalTextRequest, tools: [tool], tool_choice: 'none' });
  assert.equal(disabled.tools, undefined);
  assert.equal(disabled.tool_choice, undefined);
});

test('Doubao rejects forced tool choices and actual tool transcripts', () => {
  assert.throws(() => prepareDoubaoRequest({ ...canonicalTextRequest, tools: [tool], tool_choice: 'required' }), {
    code: 'unsupported_tools',
  });
  assert.throws(
    () =>
      prepareDoubaoRequest({
        ...canonicalTextRequest,
        tools: [tool],
        tool_choice: { type: 'function', function: { name: 'lookup' } },
      }),
    { code: 'unsupported_tools' },
  );
  assert.throws(
    () =>
      prepareDoubaoRequest({
        ...canonicalTextRequest,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"query":"hello"}' } },
            ],
          },
          { role: 'tool', tool_call_id: 'call_1', content: [{ type: 'text', text: 'result' }] },
        ],
      }),
    { code: 'unsupported_tools' },
  );
});

test('Doubao optional tool catalogs work through Chat, Responses, and Anthropic JSON paths', async () => {
  await withDoubaoMock(async () => {
    const app = doubaoMockApp();
    const chat = await app.request('http://127.0.0.1:10100/v1/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: DOUBAO_TEST_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool],
        tool_choice: 'auto',
      }),
    });
    assert.equal(chat.status, 200);
    assert.equal((await chat.json()).choices[0].message.content, 'PONG');

    const responses = await app.request('http://127.0.0.1:10100/v1/responses', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: DOUBAO_TEST_MODEL, input: 'hello', tools: [tool], tool_choice: 'auto' }),
    });
    assert.equal(responses.status, 200);
    assert.equal((await responses.json()).output_text, 'PONG');

    const anthropic = await app.request('http://127.0.0.1:10100/v1/messages', {
      method: 'POST',
      headers: headers({ 'anthropic-version': '2023-06-01' }),
      body: JSON.stringify({
        model: DOUBAO_TEST_CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', description: 'Look something up.', input_schema: tool.function.parameters }],
        tool_choice: { type: 'auto' },
      }),
    });
    assert.equal(anthropic.status, 200);
    assert.equal((await anthropic.json()).content[0].text, 'PONG');
  });
});

test('Doubao optional tool catalogs work through Chat, Responses, and Anthropic streaming paths', async () => {
  await withDoubaoMock(async () => {
    const app = doubaoMockApp();
    const chat = await app.request('http://127.0.0.1:10100/v1/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: DOUBAO_TEST_MODEL,
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool],
        tool_choice: 'auto',
      }),
    });
    assert.equal(chat.status, 200);
    assert.match(await chat.text(), /PONG/);

    const responses = await app.request('http://127.0.0.1:10100/v1/responses', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: DOUBAO_TEST_MODEL,
        stream: true,
        input: 'hello',
        tools: [tool],
        tool_choice: 'auto',
      }),
    });
    assert.equal(responses.status, 200);
    assert.match(await responses.text(), /PONG/);

    const anthropic = await app.request('http://127.0.0.1:10100/v1/messages', {
      method: 'POST',
      headers: headers({ 'anthropic-version': '2023-06-01' }),
      body: JSON.stringify({
        model: DOUBAO_TEST_CLAUDE_MODEL,
        stream: true,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', input_schema: tool.function.parameters }],
        tool_choice: { type: 'auto' },
      }),
    });
    assert.equal(anthropic.status, 200);
    assert.match(await anthropic.text(), /PONG/);
  });
});

test('Doubao rejects images in all protocols before provider execution', async () => {
  await withDoubaoMock(async () => {
    const app = doubaoMockApp();
    const requests = [
      {
        path: '/v1/chat/completions',
        body: {
          model: DOUBAO_TEST_MODEL,
          messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: INLINE_IMAGE } }] }],
        },
      },
      {
        path: '/v1/responses',
        body: {
          model: DOUBAO_TEST_MODEL,
          input: [
            {
              role: 'user',
              content: [{ type: 'input_image', image_url: INLINE_IMAGE }],
            },
          ],
        },
      },
      {
        path: '/v1/messages',
        body: {
          model: DOUBAO_TEST_CLAUDE_MODEL,
          max_tokens: 16,
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/png', data: 'AAAAAAAAAAA=' },
                },
              ],
            },
          ],
        },
        extraHeaders: { 'anthropic-version': '2023-06-01' },
      },
    ];

    for (const request of requests) {
      const response = await app.request(`http://127.0.0.1:10100${request.path}`, {
        method: 'POST',
        headers: headers(request.extraHeaders),
        body: JSON.stringify(request.body),
      });
      assert.equal(response.status, 400);
      const payload = await response.json();
      assert.equal(payload.error.code, 'unsupported_multimodal_content');
      assert.match(payload.error.message, /doubao-work-pro/);
    }
  });
});

test('Doubao forced tools and tool transcripts remain explicit client errors', async () => {
  await withDoubaoMock(async () => {
    const app = doubaoMockApp();
    const chat = await app.request('http://127.0.0.1:10100/v1/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: DOUBAO_TEST_MODEL,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [tool],
        tool_choice: 'required',
      }),
    });
    assert.equal(chat.status, 400);
    assert.equal((await chat.json()).error.code, 'unsupported_tools');

    const responses = await app.request('http://127.0.0.1:10100/v1/responses', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        model: DOUBAO_TEST_MODEL,
        input: [
          { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"query":"hello"}' },
          { type: 'function_call_output', call_id: 'call_1', output: 'result' },
        ],
      }),
    });
    assert.equal(responses.status, 400);
    assert.equal((await responses.json()).error.code, 'unsupported_tools');

    const anthropic = await app.request('http://127.0.0.1:10100/v1/messages', {
      method: 'POST',
      headers: headers({ 'anthropic-version': '2023-06-01' }),
      body: JSON.stringify({
        model: DOUBAO_TEST_CLAUDE_MODEL,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ name: 'lookup', input_schema: tool.function.parameters }],
        tool_choice: { type: 'any' },
      }),
    });
    assert.equal(anthropic.status, 400);
    const anthropicError = await anthropic.json();
    assert.equal(anthropicError.error.type, 'invalid_request_error');
    assert.equal(anthropicError.error.code, 'unsupported_tools');
  });
});

test('registry exposes realm-prefixed Trae IDs and preserves successful realm and provider discovery', async () => {
  const trae = {
    id: 'trae',
    displayName: 'Trae',
    async discoverModels() {
      return {
        provider: 'trae',
        displayName: 'Trae',
        available: true,
        models: [
          {
            upstreamId: 'global-same-model',
            configName: 'same-model',
            modelName: 'same-model',
            displayName: 'Global Same Model',
            metadata: { realm: 'global' },
          },
        ],
        realms: [
          { realm: 'global', configured: true, available: true, modelCount: 1, fromCache: false },
          {
            realm: 'cn',
            configured: true,
            available: false,
            modelCount: 0,
            fromCache: false,
            lastError: { code: 'offline_failure', message: 'CN offline mock failure' },
          },
        ],
      };
    },
  };
  const doubao = {
    id: 'doubao',
    displayName: 'Doubao Work',
    async discoverModels() {
      return {
        provider: 'doubao',
        displayName: 'Doubao Work',
        models: [
          {
            upstreamId: 'work-auto',
            configName: 'work-auto',
            modelName: 'work-auto',
            displayName: 'Work Auto',
            metadata: {},
          },
        ],
      };
    },
  };

  const result = await new ModelRegistry([trae, doubao]).discover();
  assert.deepEqual(
    result.models.map((model) => model.id),
    ['doubao-work-auto', 'trae-global-same-model'],
  );
  const traeStatus = result.providerStatuses.find((status) => status.provider === 'trae');
  assert.equal(traeStatus.available, true);
  assert.equal(traeStatus.realms[0].realm, 'global');
  assert.equal(traeStatus.realms[0].modelCount, 1);
  assert.equal(traeStatus.realms[1].realm, 'cn');
  assert.equal(traeStatus.realms[1].available, false);
  assert.equal(traeStatus.realms[1].lastError.code, 'offline_failure');
  assert.equal(result.providerStatuses.find((status) => status.provider === 'doubao').available, true);
});

test('registry keeps a configured empty Trae realm unavailable with a bounded reason', async () => {
  const trae = {
    id: 'trae',
    displayName: 'Trae',
    async discoverModels() {
      return {
        provider: 'trae',
        displayName: 'Trae',
        available: false,
        models: [],
        realms: [
          {
            realm: 'global',
            configured: true,
            available: false,
            modelCount: 0,
            fromCache: false,
            lastError: {
              code: 'trae_model_catalog_empty',
              message: 'Trae global returned no discoverable models and has no valid cached catalog.',
            },
          },
          { realm: 'cn', configured: false, available: false, modelCount: 0, fromCache: false },
        ],
      };
    },
  };
  const result = await new ModelRegistry([trae]).discover();
  assert.equal(result.models.length, 0);
  assert.equal(result.providerStatuses[0].available, false);
  assert.equal(result.providerStatuses[0].realms[0].lastError.code, 'trae_model_catalog_empty');
});
