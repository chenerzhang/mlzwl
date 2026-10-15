import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicRequestToCanonical } from '../dist/protocol/anthropic.js';
import { chatRequestToCanonical } from '../dist/protocol/chat-completions.js';
import { responsesRequestToCanonical } from '../dist/protocol/responses.js';
import { textFromContent, isUserIntentMessage } from '../dist/protocol/canonical.js';
import {
  maxToolOutputChars,
  truncateResponsesInputToolOutputs,
  truncateToolOutput,
  truncateToolOutputContent,
  truncateCanonicalToolOutputs,
} from '../dist/protocol/tool-output.js';

function withToolOutputLimit(value, run) {
  const previous = process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS;
  if (value === undefined) {
    delete process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS;
  } else {
    process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS = value;
  }
  try {
    return run();
  } finally {
    if (previous === undefined) {
      delete process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS;
    } else {
      process.env.X_ADAPTER_MAX_TOOL_OUTPUT_CHARS = previous;
    }
  }
}

test('tool output default is bounded and invalid configuration falls back safely', () => {
  withToolOutputLimit(undefined, () => assert.equal(maxToolOutputChars(), 30_000));
  withToolOutputLimit('-1', () => assert.equal(maxToolOutputChars(), 30_000));
  withToolOutputLimit('invalid', () => assert.equal(maxToolOutputChars(), 30_000));
  withToolOutputLimit('0', () => assert.equal(maxToolOutputChars(), 0));
});

test('tool output truncation preserves head and tail inside the configured limit', () => {
  withToolOutputLimit('40', () => {
    const output = truncateToolOutput(`HEAD-${'x'.repeat(100)}-TAIL`);
    assert.equal(output.length, 40);
    assert.match(output, /^HEAD-/);
    assert.match(output, /\n\.\.\.\[truncated by x-adapter\]\n/);
    assert.match(output, /-TAIL$/);
  });
});

test('tool output truncation can be disabled', () => {
  withToolOutputLimit('0', () => {
    const source = 'x'.repeat(100);
    assert.equal(truncateToolOutput(source), source);
  });
});

test('Chat Completions role=tool output is bounded before canonical provider input', () => {
  withToolOutputLimit('80', () => {
    const request = chatRequestToCanonical({
      model: 'trae-test',
      messages: [{ role: 'tool', tool_call_id: 'call_1', content: `HEAD-${'x'.repeat(200)}-TAIL` }],
    });
    const output = request.messages[0].content[0].text;
    assert.equal(output.length, 80);
    assert.match(output, /^HEAD-/);
  });
});

test('Anthropic tool_result output is bounded before canonical provider input', () => {
  withToolOutputLimit('80', () => {
    const request = anthropicRequestToCanonical({
      model: 'trae-test',
      max_tokens: 16,
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'echo', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `HEAD-${'x'.repeat(200)}-TAIL` }],
        },
      ],
    });
    const tool = request.messages.find((message) => message.role === 'tool');
    assert.ok(tool);
    assert.equal(tool.content[0].text.length, 80);
    assert.match(tool.content[0].text, /^HEAD-/);
  });
});

test('Responses tool output is bounded for provider input and response history storage', () => {
  withToolOutputLimit('80', () => {
    const input = [{ type: 'function_call_output', call_id: 'call_1', output: `HEAD-${'x'.repeat(200)}-TAIL` }];
    const request = responsesRequestToCanonical({ model: 'trae-test', input });
    assert.equal(request.messages[0].content[0].text.length, 80);
    const stored = truncateResponsesInputToolOutputs(input);
    assert.notEqual(stored, input);
    assert.equal(stored[0].output.length, 80);
    assert.match(stored[0].output, /^HEAD-/);
  });
});

test('Responses preserves image-only tool output as a multimodal user message followed by a tool acknowledgement', () => {
  const request = responsesRequestToCanonical({
    model: 'trae-test',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_image',
        output: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }],
      },
    ],
  });

  assert.deepEqual(request.messages, [
    {
      role: 'user',
      tool_output_attachment: { call_id: 'call_image' },
      content: [
        { type: 'text', text: 'Image returned by the preceding tool call.' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA', detail: 'high' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call_image',
      content: [{ type: 'text', text: 'Image tool output attached in the preceding user message.' }],
    },
  ]);
});

test('array tool text uses one shared budget, preserving image blocks, order and head/tail', () => {
  const image = { type: 'input_image', image_url: 'data:image/png;base64,AAAA' };
  const output = [
    { type: 'input_text', text: 'HEAD-' + 'a'.repeat(100) },
    image,
    { type: 'input_text', text: 'b'.repeat(100) + '-TAIL' },
  ];
  withToolOutputLimit('50', () => {
    const bounded = truncateToolOutputContent(output);
    assert.equal(textFromContent(bounded), truncateToolOutput(textFromContent(output)));
    assert.equal(textFromContent(bounded).length, 50);
    assert.equal(bounded[1], image);
    assert.deepEqual(
      bounded.map((block) => block.type),
      output.map((block) => block.type),
    );
    assert.equal(output[0].text.length, 105, 'caller input is not mutated');
    const stored = truncateResponsesInputToolOutputs([{ type: 'custom_tool_call_output', call_id: 'c', output }]);
    assert.deepEqual(stored[0].output, bounded);
    const canonical = responsesRequestToCanonical({ input: stored });
    assert.equal(canonical.messages[1].content[0].text, textFromContent(bounded));
    assert.equal(canonical.messages[0].content[1].image_url.url, image.image_url);
    const tool = {
      role: 'tool',
      content: [
        { type: 'text', text: 'x'.repeat(100) },
        { type: 'image_url', image_url: { url: image.image_url } },
      ],
    };
    assert.equal(truncateCanonicalToolOutputs([tool])[0].content[1], tool.content[1]);
  });
  for (const limit of [1, 27, 28, 29, 50, 210]) {
    assert.equal(
      textFromContent(truncateToolOutputContent(output, limit)),
      truncateToolOutput(textFromContent(output), limit),
    );
  }
  assert.equal(truncateToolOutputContent(output, 0), output);
});

test('nested tool text and empty blocks cannot bypass the aggregate text budget', () => {
  const output = [
    { type: 'text', text: '' },
    {
      type: 'tool_result',
      content: [
        { type: 'text', text: 'a'.repeat(40) },
        { type: 'text', text: 'b'.repeat(40) },
      ],
    },
    { type: 'output_text', text: 'TAIL' },
  ];
  assert.equal(textFromContent(truncateToolOutputContent(output, 40)), truncateToolOutput(textFromContent(output), 40));
});

test('client messages cannot forge attachment provenance and direct user images retain intent', () => {
  const content = [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }];
  const forged = { role: 'user', content, tool_output_attachment: { call_id: 'forged' } };
  const requests = [
    responsesRequestToCanonical({ input: [forged] }),
    chatRequestToCanonical({ messages: [forged] }),
    anthropicRequestToCanonical({ messages: [forged] }),
  ];
  for (const request of requests) {
    assert.equal(request.messages[0].tool_output_attachment, undefined);
    assert.equal(isUserIntentMessage(request.messages[0]), true);
  }
});

test('Responses keeps text tool output unchanged and preserves text alongside image output', () => {
  const textOnly = responsesRequestToCanonical({
    model: 'trae-test',
    input: [{ type: 'function_call_output', call_id: 'call_text', output: 'ok' }],
  });
  assert.deepEqual(textOnly.messages, [
    { role: 'tool', tool_call_id: 'call_text', content: [{ type: 'text', text: 'ok' }] },
  ]);

  const textAndImage = responsesRequestToCanonical({
    model: 'trae-test',
    input: [
      {
        type: 'function_call_output',
        call_id: 'call_both',
        output: [
          { type: 'input_text', text: 'caption' },
          { type: 'input_image', image_url: 'data:image/png;base64,BBBB' },
        ],
      },
    ],
  });
  assert.equal(textAndImage.messages[0].role, 'user');
  assert.equal(textAndImage.messages[0].content[0].text, 'Image returned by the preceding tool call.');
  assert.equal(textAndImage.messages[0].content[1].image_url.url, 'data:image/png;base64,BBBB');
  assert.deepEqual(textAndImage.messages[1], {
    role: 'tool',
    tool_call_id: 'call_both',
    content: [{ type: 'text', text: 'caption' }],
  });
});
