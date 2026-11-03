import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchDoubaoModels,
  modifyConversation,
  pullConversationState,
  reasoningEffort,
  startCompletion,
  staticDoubaoModels,
} from '../dist/providers/doubao/upstream/protocol.js';
import { DoubaoEventProjector } from '../dist/providers/doubao/upstream/events.js';
import { doubaoHttpError, doubaoQuery } from '../dist/providers/doubao/upstream/client.js';
import {
  doubaoToolStream,
  matchesJsonSchema,
  routeDoubaoToolCall,
  uploadDoubaoRemoteToolResult,
} from '../dist/providers/doubao/upstream/tools.js';
import { __testHooks as chatTestHooks } from '../dist/providers/doubao/upstream/chat.js';
import {
  DoubaoSessionStore,
  KeyedSerialQueue,
  resolveDoubaoSessionKey,
} from '../dist/providers/doubao/state/session-store.js';

const credential = {
  cookie: 'sessionid=fake',
  source: 'env',
  userAgent: 'test',
  commonQuery: { aid: '497858', device_id: 'device', web_id: 'web', tea_uuid: 'web' },
  summary: { cookieCount: 1, cookieBytes: 14, queryKeys: ['aid'] },
};

function json(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sse(value = 'event: SSE_REPLY_END\ndata: {"end_type":1,"msg_finish_attr":{"brief":"OK"}}\n\n') {
  return new Response(value, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

test('Doubao HTTP auth failures give explicit login guidance without implicit replay', () => {
  const error = doubaoHttpError(new Response(null, { status: 401 }), 'Doubao completion');
  assert.equal(error.code, 'invalid_doubao_credentials');
  assert.match(error.message, /x-adapter doubao login/);
  assert.equal(error.status, 401);
});

test('Doubao query fills stable Web semantics without risk-token synthesis', () => {
  const query = new URLSearchParams(
    doubaoQuery({ ...credential, commonQuery: { device_id: 'device', aid: '497858' } }),
  );
  assert.equal(query.get('device_id'), 'device');
  assert.equal(query.get('tea_uuid'), 'device');
  assert.equal(query.get('web_id'), 'device');
  assert.equal(query.get('doubao_device_platform'), 'web');
  assert.equal(query.get('version_code'), '20800');
  assert.equal(query.get('msToken'), null);
  assert.equal(query.get('a_bogus'), null);
  assert.ok(query.get('web_tab_id'));

  const minimal = new URLSearchParams(doubaoQuery({ ...credential, commonQuery: {} }));
  assert.equal(minimal.get('device_id'), null, 'missing observed device metadata must not be synthesized from secrets');
});

test('Doubao bridge routes connector calls and validates arguments', () => {
  const runtime = {
    deviceId: 'device',
    deviceName: 'test',
    sandboxId: 'sandbox-1',
    sandboxEnvId: 'sandbox-env',
    clientEnvId: 'client-env',
    connectorId: 'connector-1',
    builtin: true,
    instructions: '',
    localConnectors: [],
    toolChoice: 'auto',
    tools: [
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'lookup',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
    ],
  };
  const call = routeDoubaoToolCall(
    {
      sandbox_id: 'sandbox-1',
      tool_call: {
        id: 'upstream-call',
        name: 'connector.call',
        sandboxId: 'sandbox-1',
        input: {
          connector_id: 'connector-1',
          remote_tool_name: 'lookup',
          raw_arguments: '{"query":"hello"}',
        },
      },
    },
    runtime,
  );
  assert.equal(call.function.name, 'lookup');
  assert.equal(call.function.arguments, '{"query":"hello"}');
  assert.equal(matchesJsonSchema(runtime.tools[0].function.parameters, { query: 'hello' }), true);
  assert.equal(matchesJsonSchema(runtime.tools[0].function.parameters, { query: 1 }), false);
  assert.throws(
    () =>
      routeDoubaoToolCall(
        {
          sandbox_id: 'sandbox-1',
          tool_call: {
            id: 'upstream-call',
            name: 'connector.call',
            sandboxId: 'sandbox-1',
            input: {
              connector_id: 'connector-1',
              remote_tool_name: 'lookup',
              raw_arguments: '{"query":1}',
            },
          },
        },
        runtime,
      ),
    { code: 'invalid_input' },
  );
  assert.deepEqual(
    routeDoubaoToolCall(
      {
        sandbox_id: 'sandbox-1',
        tool_call: {
          id: 'wait-call',
          name: 'connector.call',
          sandboxId: 'sandbox-1',
          input: { connector_id: 'connector-1', remote_tool_name: 'x_adapter_wait' },
        },
      },
      runtime,
    ),
    { wait: true },
  );
});

test('Doubao bridge validates complete JSON Schema constraints and rejects unknown keywords', () => {
  assert.equal(matchesJsonSchema({ type: 'string', const: 'ok' }, 'no'), false);
  assert.equal(matchesJsonSchema({ type: 'string', pattern: '^x+$', minLength: 2, maxLength: 3 }, 'x'), false);
  assert.equal(matchesJsonSchema({ type: 'number', minimum: 2, maximum: 4 }, 5), false);
  assert.equal(matchesJsonSchema({ type: 'string', format: 'email' }, 'not-an-email'), false);
  assert.equal(matchesJsonSchema({ type: 'array', minItems: 2, maxItems: 2 }, [1]), false);
  assert.equal(
    matchesJsonSchema({ $ref: '#/$defs/value', $defs: { value: { type: 'integer', minimum: 2 } } }, 1),
    false,
  );
  assert.throws(() => matchesJsonSchema({ type: 'string', x_unknown_constraint: true }, 'value'), {
    code: 'invalid_input',
  });
});

test('Doubao bridge rejects asynchronous JSON Schema without invoking validation', async () => {
  let unhandled;
  const onUnhandled = (error) => {
    unhandled = error;
  };
  process.once('unhandledRejection', onUnhandled);
  try {
    const asyncSchema = { $async: true, type: 'object', required: ['value'] };
    const { prepareDoubaoRequest } = await import('../dist/providers/doubao/request.js');
    assert.throws(
      () =>
        prepareDoubaoRequest({
          model: 'doubao-work-auto',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
          tools: [{ type: 'function', function: { name: 'async_lookup', parameters: asyncSchema } }],
        }),
      { code: 'invalid_input' },
    );
    assert.throws(() => matchesJsonSchema(asyncSchema, {}), {
      code: 'invalid_input',
      message: /Asynchronous JSON Schema validation is not supported/,
    });
    assert.throws(
      () =>
        routeDoubaoToolCall(
          {
            sandbox_id: 'sandbox-1',
            tool_call: {
              id: 'async-call',
              name: 'connector.call',
              sandboxId: 'sandbox-1',
              input: {
                connector_id: 'connector-1',
                remote_tool_name: 'async_lookup',
                raw_arguments: '{}',
              },
            },
          },
          {
            sandboxId: 'sandbox-1',
            connectorId: 'connector-1',
            builtin: true,
            toolChoice: 'auto',
            tools: [
              {
                type: 'function',
                function: { name: 'async_lookup', parameters: asyncSchema },
              },
            ],
          },
        ),
      { code: 'invalid_input' },
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(unhandled, undefined);
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('Doubao tool_choice none strips disabled tools without compiling their schemas', async () => {
  const { prepareDoubaoRequest } = await import('../dist/providers/doubao/request.js');
  const request = {
    model: 'doubao-work-auto',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'disabled',
          parameters: { type: 'object', x_client_annotation: true },
        },
      },
    ],
    tool_choice: 'none',
  };
  assert.deepEqual(prepareDoubaoRequest(request), {
    model: request.model,
    messages: request.messages,
  });
});

test('Doubao tool continuation ignores completed historical results but rejects foreign IDs', () => {
  assert.equal(chatTestHooks.toolChoiceRequiresCall('auto'), false);
  assert.equal(chatTestHooks.toolChoiceRequiresCall('required'), true);
  assert.equal(chatTestHooks.toolChoiceRequiresCall({ type: 'function', function: { name: 'lookup' } }), true);
  assert.deepEqual(
    chatTestHooks.currentTurnToolResults({
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'call-1' }] },
        { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: 'historical' }] },
        { role: 'assistant', tool_calls: [{ id: 'call-2' }] },
        { role: 'tool', tool_call_id: 'call-2', content: [{ type: 'text', text: 'current' }] },
      ],
    }),
    [{ id: 'call-2', text: 'current', error: false }],
  );
  assert.deepEqual(
    chatTestHooks.currentTurnToolResults({
      messages: [
        { role: 'tool', tool_call_id: 'call-1', content: [{ type: 'text', text: 'historical' }] },
        { role: 'user', content: [{ type: 'text', text: 'next turn' }] },
      ],
    }),
    [],
  );
  const active = {
    pending: new Map([['call-2', {}]]),
    clientToolCallIds: new Set(['call-1', 'call-2']),
    exposedPendingIds: new Set(['call-2']),
  };
  assert.deepEqual(
    chatTestHooks.currentToolResults(active, [
      { id: 'call-1', text: 'historical', error: false },
      { id: 'call-2', text: 'current', error: false },
    ]),
    [{ id: 'call-2', text: 'current', error: false }],
  );
  assert.throws(() => chatTestHooks.currentToolResults(active, [{ id: 'foreign', text: 'unknown', error: false }]), {
    code: 'tool_output_mismatch',
  });
  assert.throws(
    () =>
      chatTestHooks.currentToolResults(active, [
        { id: 'call-2', text: 'first', error: false },
        { id: 'call-2', text: 'duplicate', error: false },
      ]),
    { code: 'tool_output_mismatch' },
  );
});

test('Doubao bridge returns a second concurrent call upstream without exposing it to the client', async () => {
  const uploads = [];
  let queued;
  const active = {
    runtime: {
      sandboxId: 'sandbox-1',
      connectorId: 'connector-1',
      builtin: true,
      toolChoice: 'auto',
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
        },
      ],
    },
    pending: new Map([['call-1', {}]]),
    credential,
    fetchImpl: async (_input, init) => {
      uploads.push(JSON.parse(String(init.body)).tool_result);
      return json({ code: 0 });
    },
    seenRemoteCallIds: new Set(),
    clientToolCallIds: new Set(['call-1']),
    exposedPendingIds: new Set(['call-1']),
    queue: {
      push(value) {
        queued = value;
      },
    },
  };
  await chatTestHooks.handleRemoteToolCall(active, {
    sandbox_id: 'sandbox-1',
    tool_call: {
      id: 'call-2',
      name: 'connector.call',
      sandboxId: 'sandbox-1',
      input: {
        connector_id: 'connector-1',
        remote_tool_name: 'lookup',
        raw_arguments: '{}',
      },
    },
  });
  assert.equal(active.pending.size, 1);
  assert.deepEqual([...active.clientToolCallIds], ['call-1']);
  assert.equal(queued, undefined);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].id, 'call-2');
  assert.match(uploads[0].raw_result, /one client tool call at a time/);
});

test('Doubao tool result upload retries one transient failure and not auth failures', async () => {
  const runtime = { deviceId: 'device', sandboxId: 'sandbox-1' };
  const call = { id: 'call-1', name: 'connector.call', input: {} };
  let attempts = 0;
  await uploadDoubaoRemoteToolResult(credential, runtime, call, 'result', false, async () => {
    attempts += 1;
    return attempts === 1 ? new Response(null, { status: 500 }) : json({ code: 0 });
  });
  assert.equal(attempts, 2);

  let authAttempts = 0;
  await assert.rejects(
    uploadDoubaoRemoteToolResult(credential, runtime, call, 'result', false, async () => {
      authAttempts += 1;
      return new Response(null, { status: 401 });
    }),
    { code: 'invalid_doubao_credentials' },
  );
  assert.equal(authAttempts, 1);
});

test('Doubao tool stream retries an early HTTP/2 stream ending', async (t) => {
  const http2 = await import('node:http2');
  let requests = 0;
  const server = http2.createServer();
  server.on('stream', (stream) => {
    requests += 1;
    stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
    if (requests === 1) {
      stream.end('data: {"heartbeat":true}\n\n');
      return;
    }
    stream.write('data: {"sandbox_id":"sandbox-1","tool_call":{"id":"call-1","name":"connector.call","input":{}}}\n\n');
    stream.on('data', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const previous = process.env.DOUBAO_BASE_URL;
  process.env.DOUBAO_BASE_URL = `http://127.0.0.1:${address.port}`;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.DOUBAO_BASE_URL;
    } else {
      process.env.DOUBAO_BASE_URL = previous;
    }
  });
  const controller = new AbortController();
  for await (const envelope of doubaoToolStream(credential, 'device', controller.signal)) {
    if (envelope.tool_call) {
      assert.equal(envelope.tool_call.id, 'call-1');
      controller.abort();
      break;
    }
  }
  assert.equal(requests, 2);
});

test('Doubao model discovery falls back to the built-in catalog before the first conversation', async () => {
  const models = await fetchDoubaoModels(credential, async () =>
    json({ status_code: 0, downlink_body: { pull_recent_conv_chain_downlink_body: { cells: [] } } }),
  );
  assert.ok(models.some((model) => model.id === 'work-auto'));
  assert.equal(models.find((model) => model.id === 'work-gemini-flash')?.providerId, 'cis');
});

test('Doubao model discovery maps work models and CIS provider metadata', async () => {
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url.includes('/im/chain/recent_conv')) {
      return json({
        status_code: 0,
        downlink_body: {
          pull_recent_conv_chain_downlink_body: {
            cells: [{ conversation: { conversation_id: 'conv-1', bot_id: '7338286299411103781' } }],
          },
        },
      });
    }
    assert.match(url, /brief_list/);
    return json({
      code: 0,
      data: {
        item_list: [
          {
            model_item_key: '4',
            name: '豆包 2.1 Turbo',
            reasoning_effort_config: { default_level: 5, option_list: [{ level: 3 }, { level: 4 }, { level: 5 }] },
          },
          {
            model_item_key: '1946880770',
            name: 'Gemini 3.7 Flash',
            model_extra_params: { model_type: 'custom', provider_id: 'cis' },
            reasoning_effort_config: { default_level: 4, option_list: [{ level: 3 }, { level: 4 }] },
          },
        ],
      },
    });
  };
  const models = await fetchDoubaoModels(credential, fetchImpl);
  assert.deepEqual(
    models.map((model) => model.id),
    staticDoubaoModels().map((model) => model.id),
  );
  const gemini = models.find((model) => model.id === 'work-gemini-flash');
  assert.equal(gemini.providerId, 'cis');
  assert.deepEqual(gemini.supportedReasoningLevels, ['low', 'medium']);
  assert.equal(gemini.defaultReasoningLevel, 'medium');
  assert.equal(reasoningEffort(undefined, gemini.defaultReasoningLevel), 4);
});

test('existing conversation state uses max index and modify carries model/reasoning', async () => {
  const observed = [];
  const fetchImpl = async (input, init) => {
    observed.push({ url: String(input), init, body: JSON.parse(String(init.body)) });
    if (String(input).includes('/im/chain/single')) {
      assert.equal(init.headers['Content-Type'], 'application/json; encoding=utf-8');
      return json({
        status_code: 0,
        downlink_body: {
          pull_singe_chain_downlink_body: {
            messages: [
              { index_in_conv: '9', section_id: 'section-1' },
              { index_in_conv: '4', section_id: 'section-old' },
            ],
          },
        },
      });
    }
    return json({
      status_code: 0,
      downlink_body: { modify_conversation_downlink_body: { success: true, msg: 'modify success' } },
    });
  };
  const state = await pullConversationState(credential, 'conv-1', fetchImpl);
  assert.deepEqual(state, { sectionId: 'section-1', lastMessageIndex: 9 });
  await modifyConversation(
    credential,
    { conversationId: 'conv-1', ...state, modelItemKey: '9', reasoningEffort: 5 },
    staticDoubaoModels().find((model) => model.id === 'work-pro'),
    reasoningEffort('low'),
    fetchImpl,
  );
  const modify = observed.at(-1).body.uplink_body.modify_conversation_uplink_body;
  assert.equal(modify.model_item_key, '5');
  assert.equal(modify.reasoning_effort, '3');
});

test('new completion creates a conversation and CIS body carries provider_id', async () => {
  let body;
  const fetchImpl = async (_input, init) => {
    body = JSON.parse(String(init.body));
    return sse();
  };
  const selected = staticDoubaoModels().find((model) => model.id === 'work-gemini-flash');
  await startCompletion({ credential, prompt: 'hello', model: selected, effort: 4, fetchImpl });
  assert.equal(body.client_meta.conversation_id, '');
  assert.match(body.client_meta.local_conversation_id, /^local_/);
  assert.equal(body.option.need_create_conversation, true);
  assert.equal(body.option.conversation_init_ext.model_item_key, '1946880770');
  assert.equal(body.option.aggregate_params.provider_id, 'cis');
  assert.equal(body.option.model_config.model_extra_params.provider_id, 'cis');
});

test('existing completion carries synced cursor without creation fields', async () => {
  let body;
  await startCompletion({
    credential,
    prompt: 'next',
    model: staticDoubaoModels()[0],
    effort: 5,
    session: {
      conversationId: 'conv-1',
      sectionId: 'section-1',
      lastMessageIndex: 12,
      modelItemKey: '9',
      reasoningEffort: 5,
    },
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init.body));
      return sse();
    },
  });
  assert.equal(body.client_meta.last_message_index, 12);
  assert.equal(body.client_meta.last_section_id, 'section-1');
  assert.equal(body.option.need_create_conversation, false);
  assert.equal(body.option.conversation_init_option, undefined);
});

test('Doubao completion with a tool runtime sends private runtime_type 2 fields', async () => {
  let body;
  const runtime = {
    deviceId: 'device',
    deviceName: 'x-adapter-test',
    sandboxId: 'sandbox-1',
    sandboxEnvId: 'sandbox-env',
    clientEnvId: 'client-env',
    connectorId: 'connector-1',
    tools: [],
    toolChoice: 'auto',
    builtin: true,
    instructions: '',
    localConnectors: [
      {
        connectorId: 'connector-1',
        mcpToolsList: [{ name: 'lookup', description: 'lookup', inputSchema: '{"type":"object"}' }],
      },
    ],
  };
  await startCompletion({
    credential,
    prompt: 'hello',
    model: staticDoubaoModels()[0],
    effort: 4,
    fetchImpl: async (_input, init) => {
      body = JSON.parse(String(init.body));
      return sse();
    },
    toolRuntime: runtime,
    systemPrompt: '# x-adapter tool policy',
    workspace: '/tmp/project',
  });
  assert.equal(body.option.general_task_param.runtime_type, 2);
  assert.equal(body.option.general_task_param.agent_task_param.runtime_type, 2);
  assert.equal(body.option.general_task_param.agent_task_param.sandbox_auth_type, 1);
  assert.equal(body.option.general_task_param.agent_task_param.local_device_id, 'device');
  assert.equal(body.option.general_task_param.agent_task_param.folder_name, 'project');
  assert.equal(body.option.general_task_param.client_option.sandbox_id, 'sandbox-1');
  assert.equal(body.option.general_task_param.client_option.client_env_id, 'client-env');
  assert.equal(body.option.general_task_param.client_option.enable_sandbox, true);
  const taskInput = JSON.parse(body.option.general_task_param.task_input_json);
  assert.deepEqual(taskInput.localConnectors, runtime.localConnectors);
  assert.equal(taskInput.agents_md.files[0].file_path, '/tmp/project/AGENTS.md');
  assert.equal(taskInput.agents_md.files[0].content, '# x-adapter tool policy');
  assert.equal(JSON.parse(body.ext.general_task_param).runtime_type, 2);

  let textBody;
  await startCompletion({
    credential,
    prompt: 'hello',
    model: staticDoubaoModels()[0],
    effort: 4,
    fetchImpl: async (_input, init) => {
      textBody = JSON.parse(String(init.body));
      return sse();
    },
  });
  assert.equal(textBody.option.general_task_param.runtime_type, 1);
  assert.equal(textBody.option.general_task_param.client_option, undefined);
  assert.equal(textBody.option.general_task_param.task_input_json, undefined);
  assert.equal(textBody.option.general_task_param.agent_task_param.local_device_id, '');
});

function terminalText(projector) {
  return projector
    .finish()
    .filter((item) => item.type === 'canonical' && item.event.type === 'text')
    .map((item) => item.event.delta)
    .join('');
}

test('Doubao SSE buffers CHUNK_DELTA and emits the authoritative final brief at terminal EOF', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  const first = projector.push({ event: 'CHUNK_DELTA', data: '{"text":"Hel"}' });
  const snapshot = projector.push({
    event: 'STREAM_CHUNK',
    data: '{"patch_op":[{"patch_object":1,"patch_value":{"content_block":[{"content":{"text_block":{"text":"duplicate"}}}]}}]}',
  });
  const second = projector.push({ event: 'CHUNK_DELTA', data: '{"text":"lo"}' });
  const end = projector.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"Hello world"}}',
  });
  assert.deepEqual(first, []);
  assert.deepEqual(snapshot, []);
  assert.deepEqual(second, []);
  assert.deepEqual(end, []);
  assert.equal(terminalText(projector), 'Hello world');
});

test('Doubao SSE final brief replaces suffix-only or divergent deltas', () => {
  const cases = [
    { delta: '。', brief: '今天是 2026年9月15日，星期二。' },
    {
      delta: '底层模型架构和版本信息不便透露。',
      brief: '我是豆包，字节跳动开发的 AI 助手。具体的底层模型架构和版本信息不便透露。',
    },
    { delta: 'answer', brief: 'different' },
  ];
  for (const { delta, brief } of cases) {
    const projector = new DoubaoEventProjector('doubao-work-auto');
    assert.deepEqual(projector.push({ event: 'CHUNK_DELTA', data: JSON.stringify({ text: delta }) }), []);
    assert.deepEqual(
      projector.push({ event: 'SSE_REPLY_END', data: JSON.stringify({ end_type: 1, msg_finish_attr: { brief } }) }),
      [],
    );
    assert.equal(terminalText(projector), brief);
  }
});

test('Doubao SSE uses a later complete answer snapshot that contains a truncated reply-end brief', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  projector.push({
    event: 'SSE_REPLY_END',
    data: JSON.stringify({ end_type: 1, msg_finish_attr: { brief: '回答还是被截断了' } }),
  });
  projector.push({
    event: 'FULL_MSG_NOTIFY',
    data: JSON.stringify({
      message: {
        user_type: 2,
        content_block: [
          {
            block_id: 'answer',
            block_type: 10_000,
            parent_id: '',
            content: { text_block: { text: '完整回答，回答还是被截断了。' } },
          },
        ],
      },
    }),
  });
  assert.equal(terminalText(projector), '完整回答，回答还是被截断了。');
});

test('Doubao SSE falls back to buffered deltas or answer snapshots when brief is absent', () => {
  const delta = new DoubaoEventProjector('doubao-work-auto');
  delta.push({ event: 'CHUNK_DELTA', data: '{"text":"buffered "}' });
  delta.push({ event: 'CHUNK_DELTA', data: '{"text":"answer"}' });
  delta.push({ event: 'SSE_REPLY_END', data: '{"end_type":1,"msg_finish_attr":{}}' });
  assert.equal(terminalText(delta), 'buffered answer');

  const snapshot = new DoubaoEventProjector('doubao-work-auto');
  snapshot.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [{ block_id: 'answer', parent_id: '', content: { text_block: { text: 'snapshot' } } }],
          },
        },
      ],
    }),
  });
  snapshot.push({ event: 'SSE_REPLY_END', data: '{"end_type":1,"msg_finish_attr":{}}' });
  assert.equal(terminalText(snapshot), 'snapshot');
});

test('Doubao SSE drops held STREAM_CHUNK when a later CHUNK_DELTA arrives', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  projector.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        { patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: 'snapshot' } } }] } },
      ],
    }),
  });
  projector.push({ event: 'CHUNK_DELTA', data: '{"text":"answer"}' });
  projector.push({ event: 'SSE_REPLY_END', data: '{"end_type":1,"msg_finish_attr":{"brief":"answer"}}' });
  assert.equal(terminalText(projector), 'answer');
});

test('Doubao SSE falls back to notify snapshots without exposing thinking blocks', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  projector.push({
    event: 'STREAM_MSG_NOTIFY',
    data: JSON.stringify({
      content: {
        content_block: [
          {
            block_id: 'thinking',
            block_type: 10_000,
            parent_id: 'thinking-root',
            content: { text_block: { text: 'hidden reasoning' } },
          },
          {
            block_id: 'answer',
            block_type: 10_000,
            parent_id: '',
            content: { text_block: { text: 'notify answer' } },
          },
        ],
      },
    }),
  });
  projector.push({ event: 'SSE_REPLY_END', data: '{"end_type":1,"msg_finish_attr":{"brief":"notify answer"}}' });
  assert.equal(terminalText(projector), 'notify answer');

  const full = new DoubaoEventProjector('doubao-work-auto');
  full.push({
    event: 'FULL_MSG_NOTIFY',
    data: JSON.stringify({
      message: {
        user_type: 2,
        content_block: [
          {
            block_id: 'answer',
            block_type: 10_000,
            parent_id: '',
            content: { text_block: { text: 'full answer' } },
          },
        ],
      },
    }),
  });
  full.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"full answer"}}',
  });
  assert.equal(terminalText(full), 'full answer');
});

test('Doubao SSE captures ACK conversation cursor', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  const output = projector.push({
    event: 'SSE_ACK',
    data: JSON.stringify({
      ack_client_meta: { conversation_id: 'conv-created', section_id: 'section-created' },
      query_list: [{ message_index: '7' }],
    }),
  });
  assert.deepEqual(output[0], {
    type: 'session',
    session: { conversationId: 'conv-created', sectionId: 'section-created', lastMessageIndex: 7 },
  });
});

test('Doubao SSE falls back to top-level STREAM_CHUNK and rejects STREAM_ERROR', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  const chunkOutput = projector.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: { content_block: [{ parent_id: 'thinking', content: { text_block: { text: 'reason' } } }] },
        },
        {
          patch_object: 1,
          patch_value: { content_block: [{ parent_id: '', content: { text_block: { text: 'answer' } } }] },
        },
      ],
    }),
  });
  assert.deepEqual(chunkOutput, []);
  projector.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"answer"}}',
  });
  assert.equal(terminalText(projector), 'answer');

  const snapshot = new DoubaoEventProjector('doubao-work-auto');
  snapshot.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [{ patch_object: 1, patch_value: { content_block: [{ content: { text_block: { text: 'old' } } }] } }],
    }),
  });
  snapshot.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [{ block_id: 'answer', content: { text_block: { text: 'old answer' } } }],
          },
        },
      ],
    }),
  });
  snapshot.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"old answer"}}',
  });
  assert.equal(terminalText(snapshot), 'old answer');

  const replaced = new DoubaoEventProjector('doubao-work-auto');
  replaced.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [{ block_id: 'answer', content: { text_block: { text: 'draft' } } }],
          },
        },
      ],
    }),
  });
  replaced.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [{ block_id: 'answer', content: { text_block: { text: 'rewritten' } } }],
          },
        },
      ],
    }),
  });
  replaced.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"rewritten"}}',
  });
  assert.equal(terminalText(replaced), 'rewritten');
  assert.throws(() => projector.push({ event: 'STREAM_ERROR', data: '{"error_code":123,"error_msg":"bad"}' }), {
    code: 'upstream_sse_error',
  });
  const incomplete = new DoubaoEventProjector('doubao-work-auto');
  incomplete.push({ event: 'CHUNK_DELTA', data: '{"text":"partial"}' });
  assert.throws(() => incomplete.finish(), { code: 'upstream_stream_truncated' });

  const blockAware = new DoubaoEventProjector('doubao-work-auto');
  blockAware.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [
              {
                block_id: 'commentary',
                block_type: 10_000,
                parent_id: 'thinking-root',
                content: JSON.stringify({ text_block: { text: 'hidden' } }),
              },
            ],
          },
        },
      ],
    }),
  });
  assert.deepEqual(blockAware.push({ event: 'CHUNK_DELTA', data: '{"text":" reasoning"}' }), []);
  blockAware.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [
              {
                block_id: 'commentary',
                content: { text_block: {} },
              },
            ],
          },
        },
      ],
    }),
  });
  assert.deepEqual(blockAware.push({ event: 'CHUNK_DELTA', data: '{"text":" still hidden"}' }), []);
  blockAware.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [
              {
                block_id: 'answer',
                block_type: 10_000,
                parent_id: '',
                content: { text_block: { text: 'final' } },
              },
            ],
          },
        },
      ],
    }),
  });
  const answerDelta = blockAware.push({ event: 'CHUNK_DELTA', data: '{"text":" answer"}' });
  assert.deepEqual(answerDelta, []);
  blockAware.push({
    event: 'SSE_REPLY_END',
    data: '{"end_type":1,"msg_finish_attr":{"brief":"final answer"}}',
  });
  assert.equal(terminalText(blockAware), 'final answer');
  const authError = new DoubaoEventProjector('doubao-work-auto');
  assert.throws(
    () =>
      authError.push({
        event: 'STREAM_ERROR',
        data: '{"error_detail":{"code":710012001,"message":"expired"}}',
      }),
    { code: 'invalid_doubao_credentials' },
  );
  const invalidAck = new DoubaoEventProjector('doubao-work-auto');
  assert.deepEqual(
    invalidAck.push({
      event: 'SSE_ACK',
      data: '{"ack_client_meta":{"conversation_id":"0","section_id":"0"}}',
    }),
    [],
  );
});

test('Doubao session key requires an explicit session or upstream conversation id', () => {
  const first = resolveDoubaoSessionKey({ metadata: { conversation_id: 'conv-explicit' }, messages: [] });
  const second = resolveDoubaoSessionKey({ metadata: { conversation_id: 'conv-explicit' }, messages: [] });
  assert.equal(first, second);
  assert.match(first, /^conversation:/);
  assert.doesNotMatch(first, /conv-explicit/);
  assert.match(resolveDoubaoSessionKey({ session_id: 'client-session', messages: [] }), /^explicit:/);
  assert.equal(
    resolveDoubaoSessionKey({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'identical first prompt' }] }],
    }),
    '',
    'two unrelated stateless requests must not collide solely because their first prompt matches',
  );
});

test('Doubao session store is bounded and keyed queue serializes same conversation', async () => {
  let now = 0;
  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const store = new DoubaoSessionStore({ ttlMs: 10, maxEntries: 1 });
    store.set('a', { conversationId: 'a', sectionId: 's', lastMessageIndex: 1, modelItemKey: '9', reasoningEffort: 5 });
    now = 1;
    store.set('b', { conversationId: 'b', sectionId: 's', lastMessageIndex: 1, modelItemKey: '9', reasoningEffort: 5 });
    assert.equal(store.get('a'), undefined);
    assert.equal(store.get('b').conversationId, 'b');
    now = 20;
    assert.equal(store.get('b'), undefined);
  } finally {
    Date.now = originalNow;
  }

  const queue = new KeyedSerialQueue();
  const trace = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const first = queue.run('conv', async () => {
    trace.push('first:start');
    await gate;
    trace.push('first:end');
  });
  const second = queue.run('conv', async () => trace.push('second'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(trace, ['first:start']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(trace, ['first:start', 'first:end', 'second']);
});

test('Doubao SSE reports server-side tool activity without inventing canonical tool calls', () => {
  const projector = new DoubaoEventProjector('doubao-work-auto');
  const output = projector.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [
              {
                block_id: 'tool-1',
                block_type: 10_040,
                is_finish: true,
                content: { bash_block: { header: { summary: '列出项目目录' }, content: 'a\nb' } },
              },
            ],
          },
        },
      ],
    }),
  });
  // Doubao already executed the tool. Emitting a canonical tool call here would
  // make the client run it a second time.
  assert.equal(
    output.some((item) => item.type === 'canonical'),
    false,
  );
  assert.deepEqual(output, [
    {
      type: 'activity',
      activity: { block: 'bash', blockId: 'tool-1', status: 'completed' },
    },
  ]);
  projector.push({ event: 'SSE_REPLY_END', data: '{"end_type":1,"msg_finish_attr":{"brief":"done"}}' });
  assert.equal(terminalText(projector), 'done');
});

test('Doubao SSE re-arms the progress callback on real events but not on bare keep-alives', () => {
  let progress = 0;
  const projector = new DoubaoEventProjector('doubao-work-auto', () => (progress += 1));
  projector.push({ event: 'SSE_HEARTBEAT', data: '{}' });
  assert.equal(progress, 0);
  projector.push({ event: 'CHUNK_DELTA', data: '{"text":"answer"}' });
  assert.equal(progress, 1);
  projector.push({
    event: 'STREAM_CHUNK',
    data: JSON.stringify({
      patch_op: [
        {
          patch_object: 1,
          patch_value: {
            content_block: [
              { block_id: 'tool-2', block_type: 10_040, content: { grep_block: { header: { summary: '搜索' } } } },
            ],
          },
        },
      ],
    }),
  });
  // A server-side tool activity block is real agent progress and must re-arm the
  // watchdog; a bare keep-alive must not.
  assert.equal(progress, 2);
});

test('Doubao completion stream omits an unset last-event-id header', async () => {
  let headers;
  await startCompletion({
    credential,
    prompt: 'hello',
    model: staticDoubaoModels()[0],
    effort: 4,
    fetchImpl: async (_input, init) => {
      headers = init.headers;
      return sse();
    },
  });
  assert.equal(
    Object.keys(headers).some((key) => key.toLowerCase() === 'last-event-id'),
    false,
  );
});

test('Doubao stream watchdog trips only after real inactivity and re-arms on progress', async () => {
  const original = process.env.X_ADAPTER_DOUBAO_IDLE_TIMEOUT_MS;
  process.env.X_ADAPTER_DOUBAO_IDLE_TIMEOUT_MS = '40';
  try {
    const { createDoubaoStreamWatchdog } = await import('../dist/providers/doubao/config/env.js');
    const kept = createDoubaoStreamWatchdog();
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      kept.arm();
    }
    // Continuous progress keeps the turn alive well past one idle budget.
    assert.equal(kept.signal.aborted, false);
    assert.equal(kept.tripped(), false);
    kept.dispose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(kept.signal.aborted, false);

    const stalled = createDoubaoStreamWatchdog();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(stalled.signal.aborted, true);
    assert.equal(stalled.tripped(), true);
    stalled.dispose();

    const explicitlyAborted = createDoubaoStreamWatchdog();
    explicitlyAborted.abort();
    assert.equal(explicitlyAborted.signal.aborted, true);
    assert.equal(explicitlyAborted.tripped(), false);

    const controller = new AbortController();
    const clientBound = createDoubaoStreamWatchdog(controller.signal);
    controller.abort();
    assert.equal(clientBound.signal.aborted, true);
    assert.equal(clientBound.tripped(), false);
    clientBound.dispose();
  } finally {
    if (original === undefined) {
      delete process.env.X_ADAPTER_DOUBAO_IDLE_TIMEOUT_MS;
    } else {
      process.env.X_ADAPTER_DOUBAO_IDLE_TIMEOUT_MS = original;
    }
  }
});
