import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearResponseHistory,
  collectResponseChain,
  getResponseRecord,
  recordResponse,
  replayMessagesForPreviousResponse,
} from '../dist/state/response-history.js';

async function withHistoryEnv(values, run) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearResponseHistory();
  try {
    return await run();
  } finally {
    clearResponseHistory();
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function record(id, sessionId, previousResponseId = null, input = id) {
  recordResponse({
    id,
    sessionId,
    previousResponseId,
    provider: 'trae',
    request: { input },
    output: [],
    createdAt: Date.now(),
  });
}

test('response history limits records per session and fails closed on evicted chains', async () => {
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_RECORDS_PER_SESSION: '1' }, () => {
    record('resp_1', 'session');
    record('resp_2', 'session', 'resp_1');
    assert.equal(getResponseRecord('session', 'resp_1'), undefined);
    const replay = replayMessagesForPreviousResponse('session', 'resp_2', 'trae');
    assert.equal(replay.messages.length, 1, 'the surviving tail is never forwarded because the warning fails closed');
    assert.equal(replay.warnings[0].type, 'missing_previous_response');
  });
});

test('response history evicts least-recently-used sessions at the configured capacity', async () => {
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_SESSIONS: '1' }, () => {
    record('resp_a', 'session-a');
    record('resp_b', 'session-b');
    assert.equal(getResponseRecord('session-a', 'resp_a'), undefined);
    assert.ok(getResponseRecord('session-b', 'resp_b'));
  });
});

test('response history TTL evicts inactive sessions and leaves TTL=0 disabled', async () => {
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_TTL_MS: '1' }, async () => {
    record('resp_1', 'session');
    await new Promise((resolve) => setTimeout(resolve, 4));
    assert.equal(getResponseRecord('session', 'resp_1'), undefined);
  });
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_TTL_MS: '0' }, () => {
    record('resp_1', 'session');
    assert.ok(getResponseRecord('session', 'resp_1'));
  });
});

test('response history replay response and character limits report incomplete chains without silently enlarging them', async () => {
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_RESPONSES: '1' }, () => {
    record('resp_1', 'session', null, 'first');
    record('resp_2', 'session', 'resp_1', 'second');
    const replay = replayMessagesForPreviousResponse('session', 'resp_2', 'trae');
    assert.deepEqual(
      replay.messages.map((message) => message.content[0].text),
      ['second'],
    );
    assert.equal(replay.warnings[0]?.type, 'response_chain_truncated');
  });
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_CHARS: '6' }, () => {
    record('resp_1', 'session', null, 'first');
    record('resp_2', 'session', 'resp_1', 'second');
    const replay = replayMessagesForPreviousResponse('session', 'resp_2', 'trae');
    assert.deepEqual(
      replay.messages.map((message) => message.content[0].text),
      ['first'],
    );
    assert.equal(replay.warnings[0]?.type, 'response_replay_chars_truncated');
  });
});

test('response history can disable count and replay limits with zero', async () => {
  await withHistoryEnv(
    {
      X_ADAPTER_RESPONSE_HISTORY_MAX_RECORDS_PER_SESSION: '0',
      X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_RESPONSES: '0',
      X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_CHARS: '0',
    },
    () => {
      record('resp_1', 'session', null, 'a'.repeat(100));
      record('resp_2', 'session', 'resp_1', 'b'.repeat(100));
      const replay = replayMessagesForPreviousResponse('session', 'resp_2', 'trae');
      assert.equal(replay.warnings.length, 0);
      assert.deepEqual(
        replay.messages.map((message) => message.content[0].text),
        ['a'.repeat(100), 'b'.repeat(100)],
      );
    },
  );
});

test('history byte accounting covers replacement, LRU access, record pruning, expiration and clear', async () => {
  await withHistoryEnv(
    { X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES: '650', X_ADAPTER_RESPONSE_HISTORY_MAX_RECORDS_PER_SESSION: '0' },
    () => {
      record('a', 'session-a', null, 'x'.repeat(100));
      record('b', 'session-b', null, 'x'.repeat(100));
      assert.ok(getResponseRecord('session-a', 'a')); // touch a, so b is oldest
      record('c', 'session-c', null, 'x'.repeat(100));
      assert.equal(getResponseRecord('session-b', 'b'), undefined);
      assert.ok(getResponseRecord('session-a', 'a'));
      record('a', 'session-a', null, 'small');
      record('d', 'session-d', null, 'small');
      assert.ok(getResponseRecord('session-c', 'c'), 'replacement must release the old bytes');
      record('oversized', 'session-large', null, 'x'.repeat(1000));
      assert.equal(getResponseRecord('session-large', 'oversized'), undefined);
      assert.ok(getResponseRecord('session-c', 'c'), 'uncacheable records must not evict healthy sessions');
      clearResponseHistory();
      record('e', 'session-e', null, 'x'.repeat(100));
      record('f', 'session-f', null, 'x'.repeat(100));
      assert.ok(getResponseRecord('session-e', 'e'));
    },
  );
  await withHistoryEnv(
    { X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES: '400', X_ADAPTER_RESPONSE_HISTORY_MAX_RECORDS_PER_SESSION: '1' },
    () => {
      for (let i = 0; i < 4; i += 1) {
        record(`r${i}`, 'same', null, 'x'.repeat(100));
      }
      assert.ok(getResponseRecord('same', 'r3'));
      assert.equal(getResponseRecord('same', 'r2'), undefined);
      record('small', 'other', null, '');
      assert.ok(getResponseRecord('same', 'r3'), 'record eviction releases bytes');
    },
  );
  await withHistoryEnv(
    { X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES: '500', X_ADAPTER_RESPONSE_HISTORY_TTL_MS: '1' },
    async () => {
      record('old', 'old');
      await new Promise((resolve) => setTimeout(resolve, 4));
      record('new', 'new');
      assert.ok(getResponseRecord('new', 'new'));
      assert.equal(getResponseRecord('old', 'old'), undefined);
    },
  );
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES: '0' }, () => {
    record('large', 'large', null, 'x'.repeat(1000));
    assert.ok(getResponseRecord('large', 'large'));
  });
});

test('history byte limits accept exact record size and reject one byte over without failing the response', async () => {
  const item = {
    id: 'exact',
    sessionId: 'session',
    provider: 'trae',
    request: { input: 'x' },
    output: [],
    createdAt: 1,
  };
  const size = Buffer.byteLength(JSON.stringify(item));
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_TOTAL_BYTES: String(size) }, () => {
    recordResponse(item);
    assert.ok(getResponseRecord('session', 'exact'));
    recordResponse({ ...item, request: { input: 'xx' } });
    assert.equal(getResponseRecord('session', 'exact'), undefined);
  });
});

test('image replay byte budget rejects oversized history and returned messages cannot mutate the cache', async () => {
  await withHistoryEnv(
    { X_ADAPTER_MAX_CONTEXT_BYTES: '700', X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_CHARS: '200000' },
    () => {
      const input = [
        {
          type: 'function_call_output',
          call_id: 'image',
          output: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'A'.repeat(1024) }],
        },
      ];
      record('large', 'session', null, input);
      const replay = replayMessagesForPreviousResponse('session', 'large', 'trae');
      assert.deepEqual(replay.messages, []);
      assert.equal(replay.warnings[0].type, 'response_replay_bytes_exceeded');
      assert.equal(
        collectResponseChain('session', 'large').records.length,
        1,
        'chain inspection remains independent of replay policy',
      );
    },
  );
  await withHistoryEnv({ X_ADAPTER_MAX_CONTEXT_BYTES: '0' }, () => {
    record('small', 'session', null, 'original');
    const replay = replayMessagesForPreviousResponse('session', 'small', 'trae');
    replay.messages[0].content[0].text = 'mutated';
    assert.equal(replayMessagesForPreviousResponse('session', 'small', 'trae').messages[0].content[0].text, 'original');
  });
});

test('recordResponse bounds array text in both input and output before cloning', async () => {
  await withHistoryEnv({ X_ADAPTER_MAX_TOOL_OUTPUT_CHARS: '40' }, () => {
    const item = {
      type: 'custom_tool_call_output',
      call_id: 'c',
      output: [
        { type: 'input_text', text: 'x'.repeat(100) },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    };
    recordResponse({ id: 'bounded', sessionId: 'session', request: { input: [item] }, output: [item], createdAt: 1 });
    const stored = getResponseRecord('session', 'bounded');
    assert.equal(stored.request.input[0].output[0].text.length, 40);
    assert.equal(stored.output[0].output[0].text.length, 40);
    assert.equal(stored.output[0].output[1].image_url, item.output[1].image_url);
    assert.equal(item.output[0].text.length, 100);
  });
});

test('replay limits do not exempt a first oversized message or reject an exact complete response count', async () => {
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_CHARS: '3' }, () => {
    record('r', 's', null, '1234');
    const replay = replayMessagesForPreviousResponse('s', 'r');
    assert.deepEqual(replay.messages, []);
    assert.equal(replay.warnings[0].type, 'response_replay_chars_truncated');
  });
  await withHistoryEnv({ X_ADAPTER_RESPONSE_HISTORY_MAX_REPLAY_RESPONSES: '1' }, () => {
    record('r', 's');
    assert.deepEqual(replayMessagesForPreviousResponse('s', 'r').warnings, []);
  });
});

test('response history preserves image tool outputs in request input and stored output', async () => {
  await withHistoryEnv({}, () => {
    const imageOutput = [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }];
    recordResponse({
      id: 'resp_image',
      sessionId: 'session',
      previousResponseId: null,
      provider: 'trae',
      request: {
        input: [{ type: 'function_call_output', call_id: 'call_request', output: imageOutput }],
      },
      output: [{ type: 'function_call_output', call_id: 'call_output', output: imageOutput }],
      createdAt: Date.now(),
    });

    const replay = replayMessagesForPreviousResponse('session', 'resp_image', 'trae');
    assert.deepEqual(
      replay.messages.map((message) => ({
        role: message.role,
        tool_call_id: message.tool_call_id,
        content: message.content,
      })),
      [
        {
          role: 'user',
          tool_call_id: undefined,
          content: [
            { type: 'text', text: 'Image returned by the preceding tool call.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: undefined } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_request',
          content: [{ type: 'text', text: 'Image tool output attached in the preceding user message.' }],
        },
        {
          role: 'user',
          tool_call_id: undefined,
          content: [
            { type: 'text', text: 'Image returned by the preceding tool call.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: undefined } },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_output',
          content: [{ type: 'text', text: 'Image tool output attached in the preceding user message.' }],
        },
      ],
    );
  });
});
