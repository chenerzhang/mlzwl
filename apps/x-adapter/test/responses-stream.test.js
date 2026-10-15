import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicSseFromEvents, responsesSseFromEvents } from '../dist/protocol/streaming.js';

async function* streamTextToolText() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'text', delta: 'before' };
  yield {
    type: 'tool_call_delta',
    tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'echo', arguments: '{"a":' } }],
  };
  yield {
    type: 'tool_call_delta',
    tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'echo', arguments: '1}' } }],
  };
  yield { type: 'text', delta: 'after' };
  yield { type: 'done', finish_reason: 'stop' };
}

async function* streamReasoningThenTool() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'reasoning', delta: 'think' };
  yield {
    type: 'tool_call_delta',
    tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'echo', arguments: '{}' } }],
  };
  yield { type: 'done', finish_reason: 'tool_calls' };
}

async function* streamReasoningTextToolText() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'reasoning', delta: 'consider' };
  yield { type: 'text', delta: 'before' };
  yield {
    type: 'tool_call_delta',
    tool_calls: [{ id: 'call_1', index: 0, type: 'function', function: { name: 'echo', arguments: '{}' } }],
  };
  yield { type: 'text', delta: 'after' };
  yield { type: 'done', finish_reason: 'stop' };
}

async function* streamDoneThenText() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'done', finish_reason: 'stop' };
  yield { type: 'text', delta: 'invalid' };
}

async function* streamLengthLimited() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'text', delta: 'partial' };
  yield { type: 'done', finish_reason: 'length' };
}

async function* streamTextReasoning() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'text', delta: 'answer' };
  yield { type: 'reasoning', delta: 'afterthought' };
  yield { type: 'done', finish_reason: 'stop' };
}

async function* streamParallelToolsWithUsage() {
  yield { type: 'start', model: 'trae-test' };
  yield {
    type: 'tool_call_delta',
    tool_calls: [
      { id: 'call_1', index: 0, type: 'function', function: { name: 'first', arguments: '{' } },
      { id: 'call_2', index: 1, type: 'function', function: { name: 'second', arguments: '{"x":' } },
    ],
  };
  yield {
    type: 'tool_call_delta',
    tool_calls: [
      { id: 'call_1', index: 0, type: 'function', function: { name: '', arguments: '}' } },
      { id: 'call_2', index: 1, type: 'function', function: { name: '', arguments: '1}' } },
    ],
  };
  yield { type: 'usage', usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } };
  yield { type: 'done', finish_reason: 'tool_calls' };
}

async function* streamOnlyReasoning() {
  yield { type: 'start', model: 'trae-test' };
  yield { type: 'reasoning', delta: 'thought' };
  yield { type: 'done', finish_reason: 'stop' };
}

async function* streamCustomTool() {
  yield { type: 'start', model: 'trae-test' };
  yield {
    type: 'tool_call_delta',
    tool_calls: [
      {
        id: 'call_custom',
        index: 0,
        type: 'function',
        client_type: 'custom',
        namespace: 'shell',
        function: { name: 'exec', arguments: '{"input":"pri' },
      },
    ],
  };
  yield {
    type: 'tool_call_delta',
    tool_calls: [
      {
        id: 'call_custom',
        index: 0,
        type: 'function',
        client_type: 'custom',
        namespace: 'shell',
        function: { name: 'exec', arguments: 'nt(1)"}' },
      },
    ],
  };
  yield { type: 'done', finish_reason: 'tool_calls' };
}

function events(text, name) {
  const pattern = new RegExp(`event: ${name}\\ndata: (.+)\\n\\n`, 'g');
  return [...text.matchAll(pattern)].map((match) => JSON.parse(match[1]));
}

test('Responses streaming creates independent ordered message items across text/tool/text', async () => {
  const text = await responsesSseFromEvents(streamTextToolText(), 'trae-test');
  const added = events(text, 'response.output_item.added');
  assert.deepEqual(
    added.map((entry) => [entry.output_index, entry.item.type]),
    [
      [0, 'message'],
      [1, 'function_call'],
      [2, 'message'],
    ],
  );
  assert.notEqual(added[0].item.id, added[2].item.id);

  const completed = events(text, 'response.completed')[0].response;
  assert.equal(completed.output_text, 'beforeafter');
  assert.deepEqual(
    completed.output.map((item) => [item.type, item.content?.[0]?.text ?? item.arguments]),
    [
      ['message', 'before'],
      ['function_call', '{"a":1}'],
      ['message', 'after'],
    ],
  );
  assert.equal((text.match(/event: response.completed/g) ?? []).length, 1);
  assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
});

test('Responses streaming closes each segment before the next segment starts', async () => {
  const previous = process.env.X_ADAPTER_REASONING_PROJECTION;
  process.env.X_ADAPTER_REASONING_PROJECTION = 'summary';
  try {
    const text = await responsesSseFromEvents(streamReasoningTextToolText(), 'trae-test');
    const added = events(text, 'response.output_item.added');
    const done = events(text, 'response.output_item.done');
    assert.deepEqual(
      added.map((entry) => [entry.output_index, entry.item.type]),
      [
        [0, 'reasoning'],
        [1, 'message'],
        [2, 'function_call'],
        [3, 'message'],
      ],
    );
    assert.deepEqual(
      done.map((entry) => entry.output_index),
      [0, 1, 2, 3],
    );
    assert.deepEqual(
      events(text, 'response.completed')[0].response.output.map((item) => item.type),
      ['reasoning', 'message', 'function_call', 'message'],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.X_ADAPTER_REASONING_PROJECTION;
    } else {
      process.env.X_ADAPTER_REASONING_PROJECTION = previous;
    }
  }
});

test('Responses streaming keeps text → reasoning as separate ordered items', async () => {
  const previous = process.env.X_ADAPTER_REASONING_PROJECTION;
  process.env.X_ADAPTER_REASONING_PROJECTION = 'summary';
  try {
    const text = await responsesSseFromEvents(streamTextReasoning(), 'trae-test');
    assert.deepEqual(
      events(text, 'response.output_item.added').map((entry) => [entry.output_index, entry.item.type]),
      [
        [0, 'message'],
        [1, 'reasoning'],
      ],
    );
    assert.deepEqual(
      events(text, 'response.completed')[0].response.output.map((item) => item.type),
      ['message', 'reasoning'],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.X_ADAPTER_REASONING_PROJECTION;
    } else {
      process.env.X_ADAPTER_REASONING_PROJECTION = previous;
    }
  }
});

test('Responses streaming assigns the first visible item index to reasoning rather than reserving message index zero', async () => {
  const previous = process.env.X_ADAPTER_REASONING_PROJECTION;
  process.env.X_ADAPTER_REASONING_PROJECTION = 'summary';
  try {
    const text = await responsesSseFromEvents(streamReasoningThenTool(), 'trae-test');
    const added = events(text, 'response.output_item.added');
    assert.deepEqual(
      added.map((entry) => [entry.output_index, entry.item.type]),
      [
        [0, 'reasoning'],
        [1, 'function_call'],
      ],
    );
    const completed = events(text, 'response.completed')[0].response;
    assert.deepEqual(
      completed.output.map((item) => item.type),
      ['reasoning', 'function_call'],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.X_ADAPTER_REASONING_PROJECTION;
    } else {
      process.env.X_ADAPTER_REASONING_PROJECTION = previous;
    }
  }
});

test('Responses streaming preserves parallel tool indices, multi-deltas, and final usage', async () => {
  const text = await responsesSseFromEvents(streamParallelToolsWithUsage(), 'trae-test');
  const argumentDeltas = events(text, 'response.function_call_arguments.delta');
  assert.deepEqual(
    argumentDeltas.map((event) => [event.output_index, event.delta]),
    [
      [0, '{'],
      [1, '{"x":'],
      [0, '}'],
      [1, '1}'],
    ],
  );
  const completed = events(text, 'response.completed')[0].response;
  assert.deepEqual(
    completed.output.map((item) => [item.name, item.arguments]),
    [
      ['first', '{}'],
      ['second', '{"x":1}'],
    ],
  );
  assert.deepEqual(completed.usage, { input_tokens: 2, output_tokens: 3, total_tokens: 5 });
});

test('Responses streaming handles a pure reasoning response without manufacturing a message', async () => {
  const previous = process.env.X_ADAPTER_REASONING_PROJECTION;
  process.env.X_ADAPTER_REASONING_PROJECTION = 'summary';
  try {
    const text = await responsesSseFromEvents(streamOnlyReasoning(), 'trae-test');
    const completed = events(text, 'response.completed')[0].response;
    assert.equal(completed.output_text, '');
    assert.deepEqual(
      completed.output.map((item) => item.type),
      ['reasoning'],
    );
  } finally {
    if (previous === undefined) {
      delete process.env.X_ADAPTER_REASONING_PROJECTION;
    } else {
      process.env.X_ADAPTER_REASONING_PROJECTION = previous;
    }
  }
});

test('Responses streaming restores custom tool calls with the client-supported raw input lifecycle', async () => {
  const text = await responsesSseFromEvents(streamCustomTool(), 'trae-test');
  const added = events(text, 'response.output_item.added');
  assert.deepEqual(
    added.map((entry) => [entry.output_index, entry.item.type, entry.item.input]),
    [[0, 'custom_tool_call', '']],
  );
  assert.equal((text.match(/event: response\.function_call_arguments\.delta/g) ?? []).length, 0);
  assert.deepEqual(
    events(text, 'response.custom_tool_call_input.delta').map((entry) => entry.delta),
    ['pri', 'nt(1)'],
  );
  assert.deepEqual(
    events(text, 'response.custom_tool_call_input.done').map((entry) => entry.input),
    ['print(1)'],
  );
  const completed = events(text, 'response.completed')[0].response;
  assert.deepEqual(completed.output, [
    {
      id: 'cc_call_custom',
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'call_custom',
      name: 'exec',
      input: 'print(1)',
      namespace: 'shell',
    },
  ]);
});

test('Responses streaming exposes length termination as an incomplete response', async () => {
  const text = await responsesSseFromEvents(streamLengthLimited(), 'trae-test');
  assert.equal((text.match(/event: response\.completed/g) ?? []).length, 0);
  const incomplete = events(text, 'response.incomplete')[0].response;
  assert.equal(incomplete.status, 'incomplete');
  assert.deepEqual(incomplete.incomplete_details, { reason: 'max_output_tokens' });
  assert.equal(incomplete.output_text, 'partial');
  assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
});

test('Anthropic streaming maps length termination to max_tokens', async () => {
  const text = await anthropicSseFromEvents(streamLengthLimited(), 'trae-test');
  const delta = events(text, 'message_delta')[0].delta;
  assert.equal(delta.stop_reason, 'max_tokens');
});

test('Responses streaming fails exactly once when canonical events arrive after done', async () => {
  const text = await responsesSseFromEvents(streamDoneThenText(), 'trae-test');
  assert.equal((text.match(/event: response.failed/g) ?? []).length, 1);
  assert.equal((text.match(/event: response.completed/g) ?? []).length, 0);
  assert.equal((text.match(/data: \[DONE\]/g) ?? []).length, 1);
});
