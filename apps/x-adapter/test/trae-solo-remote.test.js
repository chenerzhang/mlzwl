import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearModelCache, getModelCatalog, resolveModel } from '../dist/providers/trae/models/catalog.js';
import { mergeSoloRemoteCatalog } from '../dist/providers/trae/models/solo-catalog.js';
import { parseSoloRemoteModels } from '../dist/providers/trae/upstream/solo-client.js';
import { parseModelListMap } from '../dist/providers/trae/upstream/vscdb.js';
import {
  runTraeSoloWorkChat,
  buildSoloWorkBody,
  prepareSoloWorkRequest,
} from '../dist/providers/trae/upstream/solo-work-chat.js';
import { ToolCallStreamParser } from '../dist/providers/trae/upstream/solo-prompt-tools.js';
import { runTraeChat } from '../dist/providers/trae/upstream/chat.js';

const SOLO_MODELS_URL = 'https://core-normal.trae.ai/api/remote/v1/models';

function soloTokenFixturePath() {
  const dataDir = process.env.X_ADAPTER_TRAE_DATA_DIR;
  return dataDir ? `${dataDir}/global/solo-token.json` : '';
}

function writeSoloTokenFixture() {
  const file = soloTokenFixturePath();
  if (!file) {
    throw new Error('test data dir is not configured');
  }
  fs.mkdirSync(`${process.env.X_ADAPTER_TRAE_DATA_DIR}/global`, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      Result: {
        Token: 'solo-work-token',
        RefreshToken: 'solo-refresh',
        TokenExpireAt: Date.now() + 3_600_000,
        RefreshExpireAt: Date.now() + 86_400_000,
        BoundDeviceID: '888000111222333',
      },
      _clientID: 'en1oxy7wnw8j9n',
    }),
    { mode: 0o600 },
  );
}

function cleanupSoloTokenFixture() {
  const file = soloTokenFixturePath();
  if (file) {
    fs.rmSync(file, { force: true });
  }
}

async function withTraeData(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-trae-solo-'));
  const previous = process.env.X_ADAPTER_TRAE_DATA_DIR;
  const previousVscdb = process.env.X_ADAPTER_TRAE_VSCDB_PATH;
  process.env.X_ADAPTER_TRAE_DATA_DIR = directory;
  process.env.X_ADAPTER_TRAE_VSCDB_PATH = path.join(directory, 'missing-state.vscdb');
  clearModelCache();
  try {
    return await callback(directory);
  } finally {
    clearModelCache();
    if (previous === undefined) {
      delete process.env.X_ADAPTER_TRAE_DATA_DIR;
    } else {
      process.env.X_ADAPTER_TRAE_DATA_DIR = previous;
    }
    if (previousVscdb === undefined) {
      delete process.env.X_ADAPTER_TRAE_VSCDB_PATH;
    } else {
      process.env.X_ADAPTER_TRAE_VSCDB_PATH = previousVscdb;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function session(realm = 'global') {
  return {
    realm,
    region: realm === 'global' ? 'sg' : 'cn',
    token: `${realm}-token`,
    uid: `${realm}-user`,
    machineId: `${realm}-machine`,
    deviceId: `${realm}-device`,
    authBaseUrl: realm === 'global' ? 'https://growsg-normal.trae.ai' : 'https://api.trae.cn',
    dataBaseUrl: realm === 'global' ? 'https://coresg-normal.trae.ai' : 'https://trae-api-cn.mchost.guru',
    appVersion: '3.test',
    pluginVersion: '2.test',
    versionCode: '20269999',
    quality: 'stable',
  };
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function ideBatchResponse() {
  return jsonResponse({
    function_configs: [
      {
        function: 'chat_v3',
        config_info_list: [
          {
            config_name: 'fast-apply-model',
            config_switch: true,
            is_default: true,
            display_config: { display_name: 'Fast Apply' },
            model_detail_list: [{ model_name: 'fast-apply-model', max_tokens: 4096, prompt_max_tokens: 100000 }],
          },
        ],
      },
    ],
  });
}

function soloModelsResponse() {
  return jsonResponse({
    code: 0,
    data: {
      list: [
        {
          function: 'solo_coder',
          models: [{ name: 'gpt-5.2', display_name: 'GPT-5.2' }, { name: 'gemini-3.1-pro' }],
        },
      ],
    },
  });
}

function sseResponse(frames) {
  return new Response(
    frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`).join(''),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    },
  );
}

test('parseSoloRemoteModels reads the authoritative /models groups', () => {
  const models = parseSoloRemoteModels({
    data: {
      list: [
        { function: 'solo_coder', models: [{ name: 'gpt-5.2', display_name: 'GPT-5.2' }, { name: 'gemini-3.1-pro' }] },
      ],
    },
  });
  assert.deepEqual(
    models.map((model) => model.name),
    ['gpt-5.2', 'gemini-3.1-pro'],
  );
  assert.equal(models[0].displayName, 'GPT-5.2');
  assert.equal(models[0].functionName, 'solo_coder');
  // duplicate names across groups collapse to the first occurrence
  const duplicated = parseSoloRemoteModels({
    data: {
      list: [
        { function: 'a', models: [{ name: 'gpt-5.2' }] },
        { function: 'b', models: [{ name: 'gpt-5.2' }] },
      ],
    },
  });
  assert.equal(duplicated.length, 1);
});

test('mergeSoloRemoteCatalog prefers remote names, supplements presets, and rewires collisions', () => {
  const ideModels = [
    {
      id: 'global-fast-apply-model',
      object: 'model',
      created: 1,
      owned_by: 'trae',
      permission: [],
      root: 'global-fast-apply-model',
      parent: null,
      metadata: {
        realm: 'global',
        config_name: 'fast-apply-model',
        model_name: 'fast-apply-model',
        display_name: 'Fast Apply',
        functions: ['chat_v3'],
        is_default: true,
        max_tokens: 4096,
        prompt_max_tokens: 100000,
        hot: null,
        model_load: null,
        model_load_percent: null,
        quota: null,
        supported_reasoning_levels: [],
        default_reasoning_level: null,
      },
    },
    {
      id: 'global-gpt-5.2',
      object: 'model',
      created: 1,
      owned_by: 'trae',
      permission: [],
      root: 'global-gpt-5.2',
      parent: null,
      metadata: {
        realm: 'global',
        config_name: 'gpt-5.2',
        model_name: 'gpt-5.2',
        display_name: 'GPT-5.2 IDE',
        functions: ['chat_v3'],
        is_default: false,
        max_tokens: undefined,
        prompt_max_tokens: undefined,
        hot: null,
        model_load: null,
        model_load_percent: null,
        quota: null,
        supported_reasoning_levels: [],
        default_reasoning_level: null,
      },
    },
  ];
  const merged = mergeSoloRemoteCatalog(
    'global',
    ideModels,
    [{ name: 'gpt-5.2', displayName: 'GPT-5.2', functionName: 'solo_coder' }],
    [
      { configName: 'gpt-6-sol', displayName: 'GPT-6-Sol', maxInputTokens: 272000, maxOutputTokens: 200000 },
      { configName: 'gpt-5.2', displayName: 'GPT-5.2', maxInputTokens: 240000, maxOutputTokens: 128000 },
    ],
  );
  const byId = new Map(merged.map((model) => [model.metadata.config_name, model]));
  assert.equal(merged.length, 3);
  // collision: existing IDE entry gains solo_agent_remote as preferred function
  assert.deepEqual(byId.get('gpt-5.2').metadata.functions, ['solo_agent_remote', 'chat_v3']);
  assert.equal(byId.get('gpt-5.2').metadata.solo_source, 'solo_remote');
  assert.equal(byId.get('gpt-5.2').metadata.prompt_max_tokens, 240000);
  // remote-only entry from the authoritative source
  assert.deepEqual(byId.get('fast-apply-model').metadata.functions, ['chat_v3']);
  // preset-only supplement carries context metadata
  const preset = byId.get('gpt-6-sol');
  assert.equal(preset.metadata.solo_source, 'solo_preset');
  assert.equal(preset.metadata.prompt_max_tokens, 272000);
  assert.equal(preset.metadata.max_tokens, 200000);
  // the IDE models were not mutated in place
  assert.deepEqual(ideModels[1].metadata.functions, ['chat_v3']);
});

test('parseModelListMap extracts solo_agent presets with context windows', () => {
  const raw = JSON.stringify({
    solo_agent: [
      {
        is_preset: true,
        config_name: 'gpt-6-sol',
        display_name: 'GPT-6-Sol',
        context_window_tokens: { dev: 200000, max: 272000 },
      },
      { is_preset: false, config_name: 'custom-entry' },
      { is_preset: true },
    ],
    chat: [{ is_preset: true, config_name: 'other-function' }],
  });
  const presets = parseModelListMap(raw);
  assert.equal(presets.length, 1);
  assert.equal(presets[0].configName, 'gpt-6-sol');
  assert.equal(presets[0].maxInputTokens, 272000);
  assert.equal(presets[0].maxOutputTokens, 200000);
  assert.deepEqual(parseModelListMap('not-json'), []);
});

test('streamTraeChat routes solo_agent_remote models through the SOLO work chain', async () => {
  await withTraeData(async () => {
    let chatUrl = '';
    let chatBody = null;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === SOLO_MODELS_URL) {
        return soloModelsResponse();
      }
      if (url.includes('/api/ide/v1/')) {
        return ideBatchResponse();
      }
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        chatUrl = url;
        chatBody = JSON.parse(init.body);
        return sseResponse([
          { event: 'output', data: { response: 'SOLO_', reasoning_content: null } },
          { event: 'output', data: { response: 'OK', reasoning_content: null } },
          { event: 'token_usage', data: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
          { event: 'done', data: {} },
        ]);
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    writeSoloTokenFixture();
    try {
      const result = await runTraeChat(
        session(),
        { model: 'global-gpt-5.2', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] },
        fetchImpl,
      );
      assert.equal(result.text, 'SOLO_OK');
      assert.equal(result.model, 'global-gpt-5.2');
      assert.equal(result.finish_reason, 'stop');
      assert.ok(chatUrl.includes('/api/agent/v3/llm_utils_chat'));
      assert.equal(chatBody.function, 'solo_work_lite');
      assert.equal(chatBody.config_name, 'gpt-5.2');
      assert.equal(chatBody.model, 'gpt-5.2');
    } finally {
      cleanupSoloTokenFixture();
    }
  });
});

test('catalog merge degrades to IDE models when both SOLO sources are unavailable', async () => {
  await withTraeData(async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url === SOLO_MODELS_URL) {
        return new Response('nope', { status: 500 });
      }
      if (url.includes('/api/ide/v1/')) {
        return ideBatchResponse();
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    const models = await getModelCatalog(session(), fetchImpl);
    assert.equal(models.length, 1);
    assert.equal(models[0].metadata.config_name, 'fast-apply-model');
    assert.throws(() => resolveModel(models, 'global-gpt-5.2'), { code: 'model_not_found' });
  });
});

test('solo remote headers carry the web client identity', async () => {
  await withTraeData(async () => {
    let observedHeaders = null;
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === SOLO_MODELS_URL) {
        observedHeaders = init.headers;
        return soloModelsResponse();
      }
      if (url.includes('/api/ide/v1/')) {
        return ideBatchResponse();
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    await getModelCatalog(session(), fetchImpl);
    assert.equal(observedHeaders['x-trae-client-type'], 'web');
    assert.equal(observedHeaders.origin, 'https://work.trae.ai');
    assert.equal(observedHeaders.referer, 'https://work.trae.ai/');
    assert.equal(observedHeaders.authorization, 'Cloud-IDE-JWT global-token');
    assert.equal(observedHeaders['x-user-region'], 'SG');
  });
});

test('ToolCallStreamParser extracts blocks across arbitrary delta splits', () => {
  const parser = new ToolCallStreamParser();
  const events = [];
  const deltas = ['Answer: <tool', 'call>{"name":"read","para', `ms":{"path":"a"}}</tool`, 'call> done.'];
  for (const delta of deltas) {
    events.push(...parser.push(delta));
  }
  events.push(...parser.flush());
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  const calls = events.flatMap((e) => (e.type === 'tool_call' ? e.tool_calls : []));
  assert.equal(text, 'Answer:  done.');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read');
  assert.equal(JSON.parse(calls[0].function.arguments).path, 'a');
});

test('ToolCallStreamParser degrades malformed and unterminated blocks to text', () => {
  const parser = new ToolCallStreamParser();
  const events = [
    ...parser.push('broken <toolcall>{not json}</toolcall> and '),
    ...parser.push('<toolcall>{"name":"x"'),
    ...parser.flush(),
  ];
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  const calls = events.flatMap((e) => (e.type === 'tool_call' ? e.tool_calls : []));
  assert.equal(calls.length, 0);
  assert.ok(text.includes('<toolcall>{not json}</toolcall>'));
  assert.ok(text.includes('<toolcall>{"name":"x"'));
});

test('ToolCallStreamParser accepts fenced JSON bodies and multiple blocks', () => {
  const parser = new ToolCallStreamParser();
  const body =
    '<toolcall>```json\n{"name":"bash","params":{"command":"ls"}}\n```</toolcall><toolcall>{"name":"edit","params":{}}</toolcall>';
  const events = [...parser.push(body), ...parser.flush()];
  const calls = events.flatMap((e) => (e.type === 'tool_call' ? e.tool_calls : []));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'bash');
  assert.equal(calls[1].function.name, 'edit');
});

test('ToolCallStreamParser survives a close marker split across deltas', () => {
  const parser = new ToolCallStreamParser();
  const events = [
    ...parser.push('ok <toolcall>{"name":"edit","params":{}}</tool'),
    ...parser.push('call> tail'),
    ...parser.flush(),
  ];
  const text = events
    .filter((e) => e.type === 'text')
    .map((e) => e.delta)
    .join('');
  const calls = events.flatMap((e) => (e.type === 'tool_call' ? e.tool_calls : []));
  assert.equal(text, 'ok  tail');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'edit');
});

test('buildSoloWorkBody injects the toolcall protocol and flattens tool history', () => {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    },
  ];
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'read the config' }] },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', name: 'read_file', content: 'file-body' },
  ];
  const body = buildSoloWorkBody('gpt-5.2', messages, tools);
  assert.equal(body.function, 'solo_work_lite');
  assert.equal(body.config_name, 'gpt-5.2');
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'system');
  const text = body.messages[0].content[0].text;
  assert.ok(text.includes('<toolcall_protocol>'));
  assert.ok(text.includes('read_file(path)'));
  assert.ok(text.includes('<toolcall>{"name":"read_file","params":{"path":"a.txt"}}</toolcall>'));
  assert.ok(text.includes('<tool_result tool="read_file">file-body</tool_result>'));
  assert.ok(text.includes('be brief'));
  assert.ok(text.includes('read the config'));
});

test('prepareSoloWorkRequest keeps tools, rejects forced selection, and tolerates transcripts', () => {
  const base = { model: 'global-gpt-5.2', messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(prepareSoloWorkRequest(base), base);
  const withTools = prepareSoloWorkRequest({
    ...base,
    tools: [{ type: 'function', function: { name: 'x', parameters: { type: 'object' } } }],
    tool_choice: 'auto',
  });
  assert.equal(Array.isArray(withTools.tools), true);
  assert.throws(() => prepareSoloWorkRequest({ ...base, tool_choice: 'required' }), {
    code: 'unsupported_tools',
  });
  const transcript = prepareSoloWorkRequest({
    ...base,
    messages: [...base.messages, { role: 'tool', tool_call_id: '1', content: 'x' }],
  });
  assert.equal(transcript.messages.length, 2);
});

test('runTraeSoloWorkChat parses toolcall blocks, drops adjacent duplicates, and returns tool_calls', async () => {
  await withTraeData(async () => {
    const fetchImpl = async (input, init = {}) => {
      const url = String(input);
      if (url === SOLO_MODELS_URL) {
        return soloModelsResponse();
      }
      if (url.includes('/api/ide/v1/')) {
        return ideBatchResponse();
      }
      if (url.includes('/api/agent/v3/llm_utils_chat')) {
        const headers = init.headers;
        assert.equal(headers['x-app-version'], 'default');
        assert.equal(headers['x-device-brand'], '83DG');
        assert.equal(headers['x-ide-version'], '3.5.51');
        assert.ok(String(headers.authorization).startsWith('Cloud-IDE-JWT solo-work-token'));
        const block = '<toolcall>{"name":"read_file","params":{"path":"/tmp/tool-e2e.txt"}}</toolcall>';
        return sseResponse([
          { event: 'output', data: { response: 'Let me check. ' + block + block + block } },
          { event: 'token_usage', data: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
          { event: 'done', data: {} },
        ]);
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    writeSoloTokenFixture();
    try {
      const result = await runTraeSoloWorkChat(
        session(),
        {
          model: 'global-gpt-5.2',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'read it' }] }],
          tools: [
            {
              type: 'function',
              function: {
                name: 'read_file',
                description: 'Read a file',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
              },
            },
          ],
          tool_choice: 'auto',
        },
        fetchImpl,
      );
      assert.equal(result.text, 'Let me check. ');
      assert.equal(result.tool_calls.length, 1);
      assert.equal(result.tool_calls[0].function.name, 'read_file');
      assert.equal(JSON.parse(result.tool_calls[0].function.arguments).path, '/tmp/tool-e2e.txt');
      assert.equal(result.finish_reason, 'tool_calls');
    } finally {
      cleanupSoloTokenFixture();
    }
  });
});

test('runTraeSoloWorkChat fails with a clear error when the SOLO token is missing', async () => {
  await withTraeData(async () => {
    const fetchImpl = async (input) => {
      const url = String(input);
      if (url === SOLO_MODELS_URL) {
        return soloModelsResponse();
      }
      if (url.includes('/api/ide/v1/')) {
        return ideBatchResponse();
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    cleanupSoloTokenFixture();
    await assert.rejects(
      runTraeSoloWorkChat(
        session(),
        { model: 'global-gpt-5.2', messages: [{ role: 'user', content: 'hi' }] },
        fetchImpl,
      ),
      { code: 'missing_solo_token' },
    );
  });
});
