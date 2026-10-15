import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ToolNameMapper,
  bindCanonicalToolCalls,
  canonicalToolsToTrae,
  normalizeSchema,
  responsesToolsToCanonical,
} from '../dist/protocol/tools.js';
import { responseJson, responsesSseFromResult } from '../dist/protocol/responses.js';

function subagentStyleSchema() {
  return {
    type: 'object',
    properties: {
      extensionBindings: { type: 'object', additionalProperties: true },
      config: {
        anyOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }],
      },
      preflight: {
        type: 'object',
        properties: {
          lanes: {
            type: 'array',
            items: {
              type: 'object',
              properties: { key: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      acceptance: {
        anyOf: [
          { type: 'string', deprecated: true },
          { type: 'object', additionalProperties: true },
        ],
      },
      literalFlags: {
        type: 'boolean',
        const: false,
        default: true,
        enum: [true, false],
        readOnly: true,
      },
    },
  };
}

function collectAdditionalProperties(schema) {
  const values = [];
  const visit = (value) => {
    if (!value || typeof value !== 'object') {
      return;
    }
    if (!Array.isArray(value) && Object.hasOwn(value, 'additionalProperties')) {
      values.push(value.additionalProperties);
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      visit(child);
    }
  };
  visit(schema);
  return values;
}

test('normalizeSchema preserves boolean-valued keywords in subagent-style schemas', () => {
  const schema = normalizeSchema(subagentStyleSchema());

  assert.equal(Object.hasOwn(schema.properties.extensionBindings, 'additionalProperties'), false);
  assert.equal(Object.hasOwn(schema.properties.config.anyOf[0], 'additionalProperties'), false);
  assert.equal(schema.properties.preflight.additionalProperties, false);
  assert.equal(schema.properties.preflight.properties.lanes.items.additionalProperties, false);
  assert.equal(schema.properties.acceptance.anyOf[0].deprecated, true);
  assert.equal(Object.hasOwn(schema.properties.acceptance.anyOf[1], 'additionalProperties'), false);
  assert.deepEqual(schema.properties.literalFlags, {
    type: 'boolean',
    const: false,
    default: true,
    enum: [true, false],
    readOnly: true,
  });
});

test('tool bindings preserve custom type and namespace child names across an upstream mapper', () => {
  const tools = responsesToolsToCanonical([
    { type: 'custom', name: 'raw_shell', description: 'Run raw input.' },
    {
      type: 'namespace',
      name: 'files',
      tools: [
        { type: 'function', name: 'read', parameters: { type: 'object', properties: {} } },
        { type: 'custom', name: 'eval', description: 'Run raw code.' },
      ],
    },
  ]);
  const mapper = new ToolNameMapper();
  const upstream = canonicalToolsToTrae(tools, mapper);
  const restored = mapper.restoreToolCalls([
    {
      id: 'custom',
      type: 'function',
      index: 0,
      function: { name: upstream[0].function.name, arguments: '{"input":"pwd"}' },
    },
    { id: 'namespaced', type: 'function', index: 1, function: { name: upstream[1].function.name, arguments: '{}' } },
  ]);

  assert.deepEqual(
    restored.map((call) => [call.function.name, call.client_type, call.namespace]),
    [
      ['raw_shell', 'custom', undefined],
      ['read', 'function', 'files'],
    ],
  );
  const rebound = bindCanonicalToolCalls(
    [{ id: 'namespaced', type: 'function', function: { name: tools[1].function.name, arguments: '{}' } }],
    tools,
  );
  assert.deepEqual(rebound[0].function.name, 'read');
  assert.equal(rebound[0].namespace, 'files');
  assert.equal(tools[2].client_type, 'custom');
  assert.equal(tools[2].client_name, 'eval');
  assert.equal(tools[2].namespace, 'files');
  assert.deepEqual(tools[2].function.parameters.required, ['input']);
});

test('Responses JSON restores custom calls as raw custom_tool_call output items', () => {
  const response = responseJson({
    model: 'trae-test',
    text: '',
    reasoning: '',
    tool_calls: [
      {
        id: 'custom',
        type: 'function',
        client_type: 'custom',
        function: { name: 'raw_shell', arguments: '{"input":"pwd"}' },
      },
    ],
    finish_reason: 'tool_calls',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });

  assert.deepEqual(response.output, [
    {
      id: 'cc_custom',
      type: 'custom_tool_call',
      status: 'completed',
      call_id: 'custom',
      name: 'raw_shell',
      input: 'pwd',
    },
  ]);
});

test('Responses JSON and SSE expose length termination as incomplete', () => {
  const result = {
    model: 'trae-test',
    text: 'partial',
    reasoning: '',
    tool_calls: [],
    finish_reason: 'length',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  };
  const response = responseJson(result);
  assert.equal(response.status, 'incomplete');
  assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });

  const sse = responsesSseFromResult(result);
  assert.match(sse, /event: response\.incomplete/);
  assert.doesNotMatch(sse, /event: response\.completed/);
});

test('Responses SSE from a non-streaming custom result uses raw input lifecycle events', () => {
  const sse = responsesSseFromResult({
    model: 'trae-test',
    text: '',
    reasoning: '',
    tool_calls: [
      {
        id: 'custom',
        type: 'function',
        client_type: 'custom',
        function: { name: 'raw_shell', arguments: '{"input":"pwd"}' },
      },
    ],
    finish_reason: 'tool_calls',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  });

  assert.match(sse, /event: response\.custom_tool_call_input\.delta/);
  assert.match(sse, /event: response\.custom_tool_call_input\.done/);
  assert.doesNotMatch(sse, /event: response\.function_call_arguments\.delta/);
  assert.match(sse, /"type":"custom_tool_call","status":"completed"/);
});

test('Responses to Trae conversion never serializes object-valued additionalProperties', () => {
  const canonical = responsesToolsToCanonical([
    { type: 'function', name: 'subagent', description: 'Delegate work.', parameters: subagentStyleSchema() },
  ]);
  const upstream = canonicalToolsToTrae(canonical);
  const parameters = JSON.parse(upstream[0].function.parameters);

  assert.equal(upstream[0].function.name, 'subagent');
  assert.deepEqual(collectAdditionalProperties(parameters), [false, false]);
});
