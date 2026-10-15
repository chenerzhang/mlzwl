import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { writeTraeCredential } from '../dist/providers/trae/auth/credential.js';
import { clearModelCache, getModelCatalog } from '../dist/providers/trae/models/catalog.js';
import {
  buildTraeBody,
  runTraeChat,
  streamTraeChat,
  traeChatOutputLimits,
  traeChatTimeouts,
} from '../dist/providers/trae/upstream/chat.js';
import {
  TRAE_BATCH_MODELS_PATH,
  TRAE_CHAT_PATH,
  TRAE_MODELS_PATH,
  fetchModelConfigs,
  mergeModelGroups,
} from '../dist/providers/trae/upstream/trae-client.js';
import { requestErrorDiagnostics } from '../dist/logging/request-diagnostics.js';

const encoder = new TextEncoder();

function withEnv(values, callback) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of previous) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    });
}

async function withTraeData(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'x-adapter-trae-chat-'));
  const previous = process.env.X_ADAPTER_TRAE_DATA_DIR;
  process.env.X_ADAPTER_TRAE_DATA_DIR = directory;
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

function credential(realm = 'global') {
  const active = session(realm);
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    version: 1,
    realm,
    region: active.region,
    account: { uid: active.uid },
    auth: {
      accessToken: active.token,
      refreshToken: `${realm}-refresh`,
      expiresAt: Date.now() + 60_000,
      clientId: 'test-client',
    },
    product: {
      appVersion: active.appVersion,
      pluginVersion: active.pluginVersion,
      versionCode: active.versionCode,
      quality: active.quality,
    },
    device: {
      machineId: active.machineId,
      deviceId: active.deviceId,
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    },
    updatedAt: new Date().toISOString(),
  };
}

function modelEntry(id = 'timeout-test', modelName = 'timeout-test__dev') {
  return {
    config_name: id,
    config_switch: true,
    is_default: true,
    display_config: { display_name: 'Timeout Test' },
    model_detail_list: [{ model_name: modelName, max_tokens: 4096, prompt_max_tokens: 100000 }],
  };
}

function batchResponse(functions = ['chat_v3']) {
  return new Response(
    JSON.stringify({
      function_configs: functions.map((fn) => ({ function: fn, config_info_list: [modelEntry()] })),
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function request() {
  return { model: 'global-timeout-test', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
}

function fetchWithChat(handler, functions = ['chat_v3']) {
  return async (input, init = {}) => {
    if (String(input).endsWith(TRAE_CHAT_PATH)) {
      return handler(init);
    }
    if (String(input).endsWith(TRAE_BATCH_MODELS_PATH)) {
      return batchResponse(functions);
    }
    throw new Error(`unexpected mock endpoint: ${input}`);
  };
}

function pendingChat(init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });
}

function streamingChat(init, intervalMs = 0) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const emit = () => controller.enqueue(encoder.encode('event: output\ndata: {"response":"x"}\n\n'));
        emit();
        const interval = intervalMs > 0 ? setInterval(emit, intervalMs) : undefined;
        init.signal.addEventListener(
          'abort',
          () => {
            if (interval) {
              clearInterval(interval);
            }
            controller.error(init.signal.reason);
          },
          { once: true },
        );
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function completedChat(
  events = ['event: output\ndata: {"response":"ok"}\n\n', 'event: done\ndata: {"finish_reason":"stop"}\n\n'],
) {
  return new Response(events.join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function assertTimeout(error, code, source) {
  assert.equal(error.code, code);
  assert.equal(error.name, 'TimeoutError');
  assert.equal(error.timeout_diagnostics.abort_source, source);
  return true;
}

test('Trae batch discovery binds a realm-prefixed model to every function that listed it', async () => {
  const models = await fetchModelConfigs(session(), async (input) => {
    assert.match(String(input), new RegExp(`${TRAE_BATCH_MODELS_PATH}$`));
    return batchResponse(['chat_v3', 'solo_agent']);
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, 'global-timeout-test');
  assert.deepEqual(models[0].metadata.functions, ['chat_v3', 'solo_agent']);
  assert.equal(models[0].metadata.realm, 'global');
});

test('Trae discovery falls back from an empty batch response and tolerates individual function failure', async () => {
  await withEnv({ X_ADAPTER_TRAE_RETRY_MAX: '0' }, async () => {
    const observed = [];
    const models = await fetchModelConfigs(session('cn'), async (input, init) => {
      const url = String(input);
      if (url.endsWith(TRAE_BATCH_MODELS_PATH)) {
        return new Response(
          JSON.stringify({
            function_configs: [{ function: 'chat_v3', config_info_list: [{ config_name: '', config_switch: true }] }],
          }),
          { status: 200 },
        );
      }
      assert.match(url, new RegExp(`${TRAE_MODELS_PATH}$`));
      const fn = JSON.parse(init.body).function;
      observed.push(fn);
      if (fn === 'chat_v3') {
        return new Response(JSON.stringify({ config_info_list: [modelEntry('cn-test', 'cn-test__dev')] }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ message: 'unavailable' }), { status: 500 });
    });
    assert.equal(observed.filter((fn) => fn === 'chat_v3').length, 1);
    assert.equal(observed.filter((fn) => fn === 'solo_agent').length, 1);
    assert.equal(observed.filter((fn) => fn === 'solo_agent_lite').length, 1);
    assert.equal(observed.filter((fn) => fn === 'solo_work_lite').length, 1);
    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'cn-cn-test');
    assert.deepEqual(models[0].metadata.functions, ['chat_v3']);
  });
});

test('Trae model cache identity remains stable across token rotation and isolated across realms and accounts', async () => {
  await withTraeData(async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return batchResponse();
    };
    const first = session();
    const rotated = { ...first, token: 'rotated-token' };
    const otherAccount = { ...first, uid: 'other-global-user' };
    const cn = session('cn');
    assert.equal((await getModelCatalog(first, fetchImpl)).length, 1);
    assert.equal((await getModelCatalog(rotated, fetchImpl)).length, 1);
    assert.equal((await getModelCatalog(otherAccount, fetchImpl)).length, 1);
    assert.equal((await getModelCatalog(cn, fetchImpl))[0].id, 'cn-timeout-test');
    assert.equal(calls, 3);
  });
});

test('Trae chat rejects a model ID from another realm before sending chat', async () => {
  await withTraeData(async () => {
    let chats = 0;
    const fetchImpl = async (input) => {
      if (String(input).endsWith(TRAE_BATCH_MODELS_PATH)) {
        return batchResponse();
      }
      if (String(input).endsWith(TRAE_CHAT_PATH)) {
        chats += 1;
        return completedChat();
      }
      throw new Error(`unexpected mock endpoint: ${input}`);
    };
    await assert.rejects(
      async () => {
        for await (const _event of streamTraeChat(session('cn'), request(), fetchImpl)) {
          // consume
        }
      },
      { code: 'model_not_found' },
    );
    assert.equal(chats, 0);
  });
});

test('Trae request body uses the discovered function and native function tools', async () => {
  await withTraeData(async () => {
    const built = await buildTraeBody(
      session(),
      {
        ...request(),
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look something up',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          },
        ],
        tool_choice: 'auto',
      },
      'chat_v3',
      async () => batchResponse(),
    );
    assert.equal(built.body.function, 'chat_v3');
    assert.equal(built.body.config_name, 'timeout-test');
    assert.equal(built.body.model_name, 'timeout-test__dev');
    assert.equal(built.body.stream, true);
    assert.equal(built.body.tools[0].function.name, 'lookup');
    assert.equal(typeof built.body.tools[0].function.parameters, 'string');
    assert.equal(built.body.metadata, undefined);
  });
});

test('Trae chat headers and SSE preserve text, reasoning, tools, usage, and an explicit terminal', async () => {
  await withTraeData(async () => {
    let chatInit;
    const fetchImpl = fetchWithChat((init) => {
      chatInit = init;
      return completedChat([
        'event: output\ndata: {"reasoning_content":"think"}\n\n',
        'event: output\ndata: {"response":"answer"}\n\n',
        'event: output\ndata: {"tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"lookup","arguments":"{\\"query\\":\\"x\\"}"}}]}\n\n',
        'event: token_usage\ndata: {"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}\n\n',
        'event: done\ndata: {"finish_reason":"tool_calls"}\n\n',
      ]);
    });
    const events = [];
    for await (const event of streamTraeChat(session(), request(), fetchImpl)) {
      events.push(event);
    }
    assert.equal(chatInit.headers.authorization, 'Cloud-IDE-JWT global-token');
    assert.equal(chatInit.headers['x-cloudide-token'], 'global-token');
    assert.equal(chatInit.headers['x-device-id'], 'global-device');
    assert.deepEqual(
      events.map((event) => event.type),
      ['start', 'reasoning', 'text', 'tool_call_delta', 'usage', 'done'],
    );
    assert.equal(events.at(-1).finish_reason, 'tool_calls');
  });
});

test('Trae function fallback is limited to a discovered same-model function mismatch before SSE', async () => {
  await withTraeData(async () => {
    const functions = ['chat_v3', 'solo_agent'];
    let chats = 0;
    const fetchImpl = fetchWithChat((init) => {
      chats += 1;
      const fn = JSON.parse(init.body).function;
      if (fn === 'chat_v3') {
        return new Response(JSON.stringify({ code: 4023, message: 'function mismatch' }), { status: 400 });
      }
      return completedChat();
    }, functions);
    const events = [];
    for await (const event of streamTraeChat(session(), request(), fetchImpl)) {
      events.push(event);
    }
    assert.equal(chats, 2);
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(events.find((event) => event.type === 'text').delta, 'ok');
  });
});

test('Trae function mismatch in the first SSE event can use the next discovered function before output starts', async () => {
  await withTraeData(async () => {
    let chats = 0;
    const fetchImpl = fetchWithChat(() => {
      chats += 1;
      if (chats === 1) {
        return completedChat(['event: error\ndata: {"code":4023,"message":"function mismatch"}\n\n']);
      }
      return completedChat();
    }, ['chat_v3', 'solo_agent']);
    const events = [];
    for await (const event of streamTraeChat(session(), request(), fetchImpl)) {
      events.push(event);
    }
    assert.equal(chats, 2);
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(events.find((event) => event.type === 'text').delta, 'ok');
  });
});

test('Trae never switches function after any canonical SSE output has started', async () => {
  await withTraeData(async () => {
    let chats = 0;
    const fetchImpl = fetchWithChat(() => {
      chats += 1;
      return completedChat([
        'event: output\ndata: {"response":"visible"}\n\n',
        'event: error\ndata: {"code":4023,"message":"function mismatch"}\n\n',
      ]);
    }, ['chat_v3', 'solo_agent']);
    const visible = [];
    await assert.rejects(
      async () => {
        for await (const event of streamTraeChat(session(), request(), fetchImpl)) {
          visible.push(event);
        }
      },
      { code: 'upstream_stream_failed' },
    );
    assert.equal(chats, 1);
    assert.equal(visible.filter((event) => event.type === 'start').length, 1);
    assert.equal(visible.find((event) => event.type === 'text').delta, 'visible');
  });
});

test('Trae quota and ordinary HTTP failures never trigger function fallback or generic chat retry', async () => {
  await withTraeData(async () => {
    for (const [code, message, status] of [
      [4008, 'quota exhausted', 429],
      [1005, 'insufficient account entitlement', 400],
      [4001, 'invalid message content', 400],
    ]) {
      let chats = 0;
      const fetchImpl = fetchWithChat(() => {
        chats += 1;
        return new Response(JSON.stringify({ code, message }), { status });
      }, ['chat_v3', 'solo_agent']);
      await assert.rejects(
        async () => {
          for await (const _event of streamTraeChat(session(), request(), fetchImpl)) {
            // consume
          }
        },
        { code: 'upstream_http_error' },
      );
      assert.equal(chats, 1);
    }
  });
});

test('Trae 401 refreshes once and replays once before returning an authentication error', async () => {
  await withTraeData(async () => {
    writeTraeCredential(credential('global'));
    let chats = 0;
    let refreshes = 0;
    const fetchImpl = async (input, init) => {
      const url = String(input);
      if (url.endsWith(TRAE_BATCH_MODELS_PATH)) {
        return batchResponse();
      }
      if (url.endsWith('/trae/api/v3/oauth/ExchangeToken')) {
        refreshes += 1;
        return new Response(
          JSON.stringify({
            Result: {
              Token: 'refreshed-access',
              RefreshToken: 'refreshed-refresh',
              TokenExpireAt: Math.floor((Date.now() + 120_000) / 1000),
            },
          }),
          { status: 200 },
        );
      }
      if (url.endsWith(TRAE_CHAT_PATH)) {
        chats += 1;
        assert.equal(
          init.headers.authorization,
          chats === 1 ? 'Cloud-IDE-JWT global-token' : 'Cloud-IDE-JWT refreshed-access',
        );
        return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 });
      }
      throw new Error(`unexpected mock endpoint: ${url}`);
    };
    await assert.rejects(
      async () => {
        for await (const _event of streamTraeChat(session(), request(), fetchImpl)) {
          // consume
        }
      },
      { code: 'trae_auth_rejected' },
    );
    assert.equal(chats, 2);
    assert.equal(refreshes, 1);
  });
});

test('Trae client cancellation aborts the single in-flight chat without retry or fallback', async () => {
  await withTraeData(async () => {
    let chats = 0;
    const controller = new AbortController();
    const fetchImpl = fetchWithChat(
      (init) => {
        chats += 1;
        return pendingChat(init);
      },
      ['chat_v3', 'solo_agent'],
    );
    const consuming = (async () => {
      for await (const _event of streamTraeChat(session(), request(), fetchImpl, controller.signal)) {
        // consume
      }
    })();
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(consuming, (error) => {
      assert.equal(error.code, 'client_abort');
      assert.equal(error.name, 'AbortError');
      return true;
    });
    assert.equal(chats, 1);
  });
});

test('Trae stream without a terminal is rejected instead of synthesized as success', async () => {
  await withTraeData(async () => {
    await assert.rejects(
      async () => {
        for await (const _event of streamTraeChat(
          session(),
          request(),
          fetchWithChat(() => completedChat(['event: output\ndata: {"response":"partial"}\n\n'])),
        )) {
          // consume
        }
      },
      { code: 'upstream_stream_truncated' },
    );
  });
});

test('Trae chat enforces request output events, cancels upstream, and completes with length', async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS: undefined,
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES: '1024',
      },
      async () => {
        let cancelled = false;
        const fetchImpl = fetchWithChat(() => {
          return new Response(
            new ReadableStream({
              start(controller) {
                for (const delta of ['a', 'b', 'c', 'd']) {
                  controller.enqueue(encoder.encode(`event: output\ndata: {"response":"${delta}"}\n\n`));
                }
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        });
        const result = await runTraeChat(session(), { ...request(), max_tokens: 2 }, fetchImpl);
        assert.equal(result.text, 'ab');
        assert.equal(result.finish_reason, 'length');
        assert.equal(cancelled, true);
      },
    ),
  );
});

test('Trae chat truncates text at a UTF-8 boundary and cancels before exposing excess bytes', async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS: '10',
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES: '5',
      },
      async () => {
        let cancelled = false;
        const fetchImpl = fetchWithChat(() => {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode('event: output\ndata: {"response":"你好吗"}\n\n'));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        });
        const result = await runTraeChat(session(), { ...request(), max_tokens: 10 }, fetchImpl);
        assert.equal(result.text, '你');
        assert.equal(Buffer.byteLength(result.text, 'utf8'), 3);
        assert.equal(result.finish_reason, 'length');
        assert.equal(cancelled, true);
      },
    ),
  );
});

test('Trae chat never exposes a tool-call delta that exceeds the output byte cap', async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS: '10',
        X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES: '8',
      },
      async () => {
        let cancelled = false;
        const fetchImpl = fetchWithChat(() => {
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'event: output\ndata: {"tool_calls":[{"index":0,"id":"call_1","function_call":{"name":"lookup","arguments":"{}"}}]}\n\n',
                  ),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          );
        });
        const result = await runTraeChat(session(), { ...request(), max_tokens: 10 }, fetchImpl);
        assert.deepEqual(result.tool_calls, []);
        assert.equal(result.finish_reason, 'length');
        assert.equal(cancelled, true);
      },
    ),
  );
});

test('Trae output-limit defaults are bounded and configuration can only tighten the request event ceiling', () => {
  return withEnv(
    {
      X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS: undefined,
      X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES: undefined,
    },
    () => {
      assert.deepEqual(traeChatOutputLimits(32), { maxOutputEvents: 32, maxOutputBytes: 1048576 });
      return withEnv(
        { X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_EVENTS: '5', X_ADAPTER_TRAE_CHAT_MAX_OUTPUT_BYTES: '4096' },
        () => {
          assert.deepEqual(traeChatOutputLimits(32), { maxOutputEvents: 5, maxOutputBytes: 4096 });
        },
      );
    },
  );
});

test('Trae chat timeout defaults separate total duration, first event, and idle limits', () => {
  return withEnv(
    {
      X_ADAPTER_TRAE_CHAT_TIMEOUT_MS: undefined,
      X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: undefined,
      X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: undefined,
      X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: undefined,
    },
    () => {
      assert.deepEqual(traeChatTimeouts(), {
        maxDurationMs: 600000,
        firstEventTimeoutMs: 120000,
        idleTimeoutMs: 90000,
      });
    },
  );
});

test('legacy X_ADAPTER_TRAE_CHAT_TIMEOUT_MS remains a total-duration compatibility alias', () => {
  return withEnv(
    {
      X_ADAPTER_TRAE_CHAT_TIMEOUT_MS: '123',
      X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: undefined,
      X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: '456',
      X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: '789',
    },
    () => {
      assert.deepEqual(traeChatTimeouts(), { maxDurationMs: 123, firstEventTimeoutMs: 456, idleTimeoutMs: 789 });
    },
  );
});

test('Trae chat keeps the maximum-duration hard cap when its setting is non-positive', () => {
  return withEnv(
    {
      X_ADAPTER_TRAE_CHAT_TIMEOUT_MS: '0',
      X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: '0',
      X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: '0',
      X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: '0',
    },
    () => {
      assert.deepEqual(traeChatTimeouts(), { maxDurationMs: 600000, firstEventTimeoutMs: 0, idleTimeoutMs: 0 });
    },
  );
});

test('Trae chat fails with a first-event timeout when the upstream never starts SSE', { timeout: 1000 }, async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: '200',
        X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: '20',
        X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: '0',
      },
      async () => {
        const iterator = streamTraeChat(session(), request(), fetchWithChat(pendingChat));
        await assert.rejects(
          () => iterator.next(),
          (error) => assertTimeout(error, 'trae_chat_first_event_timeout', 'first_event_timeout'),
        );
      },
    ),
  );
});

test('Trae chat resets idle time on SSE and records an idle timeout after a stall', { timeout: 1000 }, async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: '200',
        X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: '100',
        X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: '20',
      },
      async () => {
        const iterator = streamTraeChat(
          session(),
          request(),
          fetchWithChat((init) => streamingChat(init)),
        );
        assert.equal((await iterator.next()).value.type, 'start');
        assert.equal((await iterator.next()).value.type, 'text');
        await assert.rejects(
          () => iterator.next(),
          (error) => {
            assertTimeout(error, 'trae_chat_idle_timeout', 'idle_timeout');
            assert.equal(error.timeout_diagnostics.upstream_sse_event_count, 1);
            return true;
          },
        );
      },
    ),
  );
});

test('Trae chat retains a hard maximum duration while upstream SSE remains active', { timeout: 1000 }, async () => {
  await withTraeData(() =>
    withEnv(
      {
        X_ADAPTER_TRAE_CHAT_MAX_DURATION_MS: '40',
        X_ADAPTER_TRAE_CHAT_FIRST_EVENT_TIMEOUT_MS: '100',
        X_ADAPTER_TRAE_CHAT_IDLE_TIMEOUT_MS: '100',
      },
      async () => {
        const iterator = streamTraeChat(
          session(),
          request(),
          fetchWithChat((init) => streamingChat(init, 5)),
        );
        assert.equal((await iterator.next()).value.type, 'start');
        await assert.rejects(
          async () => {
            for (;;) {
              if ((await iterator.next()).done) {
                return;
              }
            }
          },
          (error) => assertTimeout(error, 'trae_chat_max_duration_timeout', 'max_duration_timeout'),
        );
      },
    ),
  );
});

test('timeout diagnostics expose bounded timing fields without the raw upstream error', () => {
  const error = new Error('Trae upstream produced no SSE event for 90000ms.');
  error.name = 'TimeoutError';
  error.code = 'trae_chat_idle_timeout';
  error.timeout_diagnostics = {
    abort_source: 'idle_timeout',
    configured_max_duration_ms: 600000,
    configured_first_event_timeout_ms: 120000,
    configured_idle_timeout_ms: 90000,
    first_upstream_event_ms: 17,
    last_upstream_event_ms: 234,
    upstream_idle_ms: 90000,
    upstream_sse_event_count: 18,
  };

  assert.deepEqual(requestErrorDiagnostics(error), {
    error_kind: 'timeout',
    failure_stage: 'idle_timeout',
    error_cause_code: 'trae_chat_idle_timeout',
    abort_source: 'idle_timeout',
    configured_max_duration_ms: 600000,
    configured_first_event_timeout_ms: 120000,
    configured_idle_timeout_ms: 90000,
    first_upstream_event_ms: 17,
    last_upstream_event_ms: 234,
    upstream_idle_ms: 90000,
    upstream_sse_event_count: 18,
  });
});

test('mergeModelGroups never merges identical config names across realms', () => {
  const global = mergeModelGroups('global', { chat_v3: [modelEntry('same')] });
  const cn = mergeModelGroups('cn', { chat_v3: [modelEntry('same')] });
  assert.equal(global[0].id, 'global-same');
  assert.equal(cn[0].id, 'cn-same');
  assert.notEqual(global[0].id, cn[0].id);
});
