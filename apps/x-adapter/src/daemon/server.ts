import crypto from 'node:crypto';
import { serve } from '@hono/node-server';
import { Context, Hono } from 'hono';
import { VERSION, env, host, port } from '../config/env.js';
import { log, redactSensitiveText, requestLoggingEnabled } from '../logging/jsonl.js';
import { requestErrorDiagnostics, toolSchemaDiagnostics } from '../logging/request-diagnostics.js';
import { modelDiscoveryResponse } from '../models/discovery.js';
import { unwrapClaudeModelId } from '../models/model-id.js';
import { ModelRegistry } from '../models/registry.js';
import { PublicModel } from '../models/types.js';
import { filterVisibleModels } from '../models/visibility.js';
import { anthropicMessageJson, anthropicRequestToCanonical } from '../protocol/anthropic.js';
import { CanonicalRequest, CanonicalStreamEvent } from '../protocol/canonical.js';
import { chatCompletionJson, chatRequestToCanonical } from '../protocol/chat-completions.js';
import { estimateInputTokens } from '../protocol/compat.js';
import { responseJson, responsesRequestToCanonical } from '../protocol/responses.js';
import {
  anthropicSseIterable,
  chatCompletionsSseIterable,
  readableFromAsyncIterable,
  responsesSseIterable,
  withHeartbeat,
} from '../protocol/streaming.js';
import { validateCanonicalRequest, validateContextSize, validateModelInputModalities } from '../protocol/validation.js';
import { ExecutableProviderAdapter, createProviderAdapters } from '../providers/adapters.js';
import { clientAuthMiddleware } from '../security/client-auth.js';
import { assertLoopbackBindHost, localOnlyMiddleware } from '../security/local-only.js';
import { defaultSessionId, recordResponse, replayMessagesForPreviousResponse } from '../state/response-history.js';

export type ServerDependencies = {
  registry?: ModelRegistry;
  adapters?: ExecutableProviderAdapter[];
};

export function createApp(dependencies: ServerDependencies = {}): Hono {
  const adapters = dependencies.adapters ?? createProviderAdapters();
  const registry = dependencies.registry ?? new ModelRegistry(adapters);
  const app = new Hono();
  app.use('*', localOnlyMiddleware);
  app.use('*', clientAuthMiddleware);

  app.get('/health', (c) =>
    c.json({
      ok: true,
      name: 'x-adapter',
      version: VERSION,
      host: host(),
      port: port(),
      url: `http://${host()}:${port()}`,
    }),
  );

  app.get('/v1/providers', async (c) => {
    const catalog = await registry.discover();
    return c.json({ object: 'list', data: catalog.providerStatuses });
  });

  app.get('/v1/models', async (c) => {
    const catalog = await registry.discover();
    if (catalog.models.length === 0 && catalog.providerStatuses.every((status) => !status.available)) {
      return c.json(
        {
          error: {
            message: 'No x-adapter providers are currently available.',
            type: 'api_error',
            code: 'all_providers_unavailable',
          },
          providers: catalog.providerStatuses,
        },
        503,
      );
    }
    return c.json(modelDiscoveryResponse(filterVisibleModels(catalog.models), c.req.header('user-agent') ?? ''));
  });

  app.get('/v1/models/:id', async (c) => {
    try {
      return c.json(openAiModel(await registry.resolve(c.req.param('id'))));
    } catch (error) {
      return modelError(c, error);
    }
  });

  app.post('/v1/chat/completions', async (c) => {
    const requestStartedAt = Date.now();
    const requestId = `xa_${crypto.randomUUID().replaceAll('-', '')}`;
    let request: CanonicalRequest | undefined;
    let logFields: Record<string, unknown> = { request_id: requestId, protocol: 'chat_completions' };
    try {
      request = chatRequestToCanonical(await c.req.json());
      request.session_id ||= c.req.header('x-session-id') || undefined;
      const { model, adapter } = await resolveTarget(registry, adapters, request.model);
      request.model = model.id;
      const validation = validateCanonicalRequest(request);
      if (validation) {
        return validationError(c, validation);
      }
      const modalityValidation = validateModelInputModalities(request, model);
      if (modalityValidation) {
        return validationError(c, modalityValidation);
      }
      if (!request.messages.length) {
        return invalidInput(c, 'messages is required');
      }
      logFields = requestLogContext(requestId, 'chat_completions', request, model);
      if (request.stream) {
        const events = withFailureDiagnostics(
          adapter.execute(request, model, abortedWithClientSignal(c)),
          'chat.stream_failed',
          requestStartedAt,
          logFields,
          request,
        );
        return sse(readableFromAsyncIterable(withHeartbeat(chatCompletionsSseIterable(events, model.id))));
      }
      return c.json(chatCompletionJson(await adapter.run(request, model, c.req.raw.signal)));
    } catch (error) {
      logRequestFailure('chat.request_failed', requestStartedAt, logFields, request, error);
      return requestError(c, error);
    }
  });

  app.post('/v1/messages/count_tokens', async (c) => {
    try {
      return c.json(estimateInputTokens(await c.req.json()));
    } catch (error) {
      return c.json({ type: 'error', error: { type: 'invalid_request_error', message: errorMessage(error) } }, 400);
    }
  });

  app.post('/v1/messages', async (c) => {
    const requestStartedAt = Date.now();
    const requestId = `xa_${crypto.randomUUID().replaceAll('-', '')}`;
    let request: CanonicalRequest | undefined;
    let logFields: Record<string, unknown> = { request_id: requestId, protocol: 'anthropic_messages' };
    try {
      request = anthropicRequestToCanonical(await c.req.json());
      request.session_id ||= c.req.header('x-session-id') || undefined;
      request.model = unwrapClaudeModelId(request.model);
      const { model, adapter } = await resolveTarget(registry, adapters, request.model);
      request.model = model.id;
      const validation = validateCanonicalRequest(request);
      if (validation) {
        return c.json(
          {
            type: 'error',
            error: { type: 'invalid_request_error', message: validation.message, code: validation.code },
          },
          400,
        );
      }
      const modalityValidation = validateModelInputModalities(request, model);
      if (modalityValidation) {
        return c.json(
          {
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: modalityValidation.message,
              code: modalityValidation.code,
            },
          },
          400,
        );
      }
      if (!request.messages.length) {
        return c.json(
          { type: 'error', error: { type: 'invalid_request_error', message: 'messages is required' } },
          400,
        );
      }
      logFields = requestLogContext(requestId, 'anthropic_messages', request, model);
      if (request.stream) {
        const events = withFailureDiagnostics(
          adapter.execute(request, model, abortedWithClientSignal(c)),
          'messages.stream_failed',
          requestStartedAt,
          logFields,
          request,
        );
        return sse(readableFromAsyncIterable(withHeartbeat(anthropicSseIterable(events, model.id))));
      }
      return c.json(anthropicMessageJson(await adapter.run(request, model, c.req.raw.signal)));
    } catch (error) {
      logRequestFailure('messages.request_failed', requestStartedAt, logFields, request, error);
      const response = publicError(error);
      return c.json(
        {
          type: 'error',
          error: { type: response.clientError ? 'invalid_request_error' : 'api_error', ...response.error },
        },
        response.status,
      );
    }
  });

  const handleResponses = async (c: Context) => {
    const requestStartedAt = Date.now();
    const requestId = `xa_${crypto.randomUUID().replaceAll('-', '')}`;
    let request: CanonicalRequest | undefined;
    let logFields: Record<string, unknown> = { request_id: requestId, protocol: 'responses' };
    try {
      const body = await c.req.json();
      request = responsesRequestToCanonical(body);
      const { model, adapter } = await resolveTarget(registry, adapters, request.model);
      request.model = model.id;
      const validation = validateCanonicalRequest(request);
      if (validation) {
        return validationError(c, validation);
      }

      const sessionId = request.session_id || c.req.header('x-session-id') || defaultSessionId();
      const replay = replayMessagesForPreviousResponse(sessionId, request.previous_response_id, model.provider);
      const inputToolCallIds = toolCallIds(request.messages);
      const inputToolOutputIds = toolOutputIds(request.messages);
      const historyToolCallIds = toolCallIds(replay.messages);
      const replayToolOutputIds = toolOutputIds(replay.messages);
      const knownToolCallIds = [...new Set([...historyToolCallIds, ...inputToolCallIds])];
      const pendingToolCallIds = knownToolCallIds.filter(
        (callId) => ![...replayToolOutputIds, ...inputToolOutputIds].includes(callId),
      );
      logFields = {
        ...requestLogContext(requestId, 'responses', request, model),
        previous_response_id: request.previous_response_id ?? null,
        session_id_hash: sessionIdHash(sessionId),
        input_tool_call_ids: inputToolCallIds,
        input_tool_output_call_ids: inputToolOutputIds,
        history_tool_call_ids: historyToolCallIds,
        pending_tool_call_ids: pendingToolCallIds,
      };

      if (replay.warnings.some((warning) => warning.type === 'previous_response_provider_mismatch')) {
        return c.json(
          {
            error: {
              message: 'previous_response_id belongs to a different x-adapter provider.',
              type: 'invalid_request_error',
              code: 'previous_response_provider_mismatch',
            },
          },
          400,
        );
      }
      if (replay.warnings.some((warning) => warning.type === 'response_replay_bytes_exceeded')) {
        return c.json(
          {
            error: {
              message: 'Response history exceeds the message context byte limit; start a new conversation.',
              type: 'invalid_request_error',
              code: 'context_too_large',
            },
          },
          400,
        );
      }
      const unavailableHistory = replay.warnings.find((warning) =>
        [
          'missing_previous_response',
          'response_chain_cycle',
          'response_chain_truncated',
          'response_replay_chars_truncated',
        ].includes(warning.type),
      );
      if (unavailableHistory) {
        return c.json(
          {
            error: {
              message: 'previous_response_id is unavailable locally; start a new conversation.',
              type: 'invalid_request_error',
              code: 'previous_response_unavailable',
            },
          },
          409,
        );
      }
      const unknownToolOutputs = inputToolOutputIds.filter((callId) => !knownToolCallIds.includes(callId));
      if (unknownToolOutputs.length) {
        return invalidInput(c, `Tool output references unknown call IDs: ${unknownToolOutputs.join(', ')}`);
      }

      request.messages = [...replay.messages, ...request.messages];
      const contextValidation = validateContextSize(request.messages);
      if (contextValidation) {
        return validationError(c, contextValidation);
      }
      // Replay history is forwarded upstream, so validate the merged transcript.
      const modalityValidation = validateModelInputModalities(request, model);
      if (modalityValidation) {
        return validationError(c, modalityValidation);
      }
      if (!request.messages.length) {
        return invalidInput(c, 'input is required');
      }

      const responseId = `resp_${crypto.randomUUID().replaceAll('-', '')}`;
      const chainRootId = replay.rootResponseId;
      request.session_id = request.session_id || c.req.header('x-session-id') || chainRootId || responseId;
      const activeRequest = request;
      const responseFields = { ...logFields, response_id: responseId };
      logFields = responseFields;
      if (request.stream) {
        const events = withFailureDiagnostics(
          adapter.execute(activeRequest, model, abortedWithClientSignal(c)),
          'responses.stream_failed',
          requestStartedAt,
          responseFields,
          activeRequest,
        );
        return sse(
          readableFromAsyncIterable(
            withHeartbeat(
              responsesSseIterable(events, model.id, {
                responseId,
                previousResponseId: activeRequest.previous_response_id ?? null,
                onComplete: (response) => {
                  recordResponse({
                    id: responseId,
                    sessionId,
                    provider: model.provider,
                    previousResponseId: activeRequest.previous_response_id ?? null,
                    request: {
                      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
                      input: body.input,
                      model: model.id,
                    },
                    output: Array.isArray(response.output) ? response.output : [],
                    createdAt: Date.now(),
                  });
                },
              }),
            ),
          ),
        );
      }
      const result = await adapter.run(request, model, c.req.raw.signal);
      const response = responseJson(result, {
        id: responseId,
        previousResponseId: request.previous_response_id ?? null,
      });
      recordResponse({
        id: responseId,
        sessionId,
        provider: model.provider,
        previousResponseId: request.previous_response_id ?? null,
        request: {
          instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
          input: body.input,
          model: model.id,
        },
        output: response.output,
        createdAt: Date.now(),
      });
      return c.json(response);
    } catch (error) {
      logRequestFailure('responses.request_failed', requestStartedAt, logFields, request, error);
      return requestError(c, error);
    }
  };

  app.post('/v1/responses', handleResponses);
  app.post('/responses', handleResponses);
  return app;
}

async function resolveTarget(
  registry: ModelRegistry,
  adapters: readonly ExecutableProviderAdapter[],
  requestedModel: string,
): Promise<{ model: PublicModel; adapter: ExecutableProviderAdapter }> {
  const model = await registry.resolve(requestedModel);
  const adapter = adapters.find((candidate) => candidate.id === model.provider);
  if (!adapter) {
    const error = new Error(`x-adapter provider adapter is unavailable: ${model.provider}`);
    (error as NodeJS.ErrnoException).code = 'provider_adapter_unavailable';
    throw error;
  }
  return { model, adapter };
}

function openAiModel(model: PublicModel) {
  return {
    id: model.id,
    object: 'model',
    created: 0,
    owned_by: model.provider,
    root: model.id,
    parent: null,
    metadata: {
      provider: model.provider,
      upstream_id: model.upstreamId,
      config_name: model.configName,
      model_name: model.modelName,
      display_name: model.displayName,
      model_load: model.modelLoad ?? null,
      model_load_percent: model.modelLoad ?? null,
      hot: model.modelLoad ?? null,
      ...model.metadata,
      input_modalities: model.inputModalities ?? ['text'],
    },
  };
}

function toolCallIds(messages: readonly { tool_calls?: readonly { id: string }[] }[]): string[] {
  return [...new Set(messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id).filter(Boolean)))];
}

function toolOutputIds(messages: readonly { role: string; tool_call_id?: string }[]): string[] {
  return [
    ...new Set(
      messages.flatMap((message) => (message.role === 'tool' && message.tool_call_id ? [message.tool_call_id] : [])),
    ),
  ];
}

function sessionIdHash(sessionId: string): string {
  return crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
}

function abortedWithClientSignal(c: Context): AbortSignal {
  const abort = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => abort.abort(), { once: true });
  return abort.signal;
}

function sse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

function errorMessage(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function requestLogContext(
  requestId: string,
  protocol: 'chat_completions' | 'responses' | 'anthropic_messages',
  request: CanonicalRequest,
  model: PublicModel,
): Record<string, unknown> {
  return {
    request_id: requestId,
    protocol,
    model: model.id,
    provider: model.provider,
    stream: request.stream === true,
    tool_count: request.tools?.length ?? 0,
    tool_transport: model.provider === 'doubao' ? 'off' : 'native',
  };
}

function logRequestFailure(
  message: string,
  requestStartedAt: number,
  fields: Record<string, unknown>,
  request: CanonicalRequest | undefined,
  error: unknown,
): void {
  if (!requestLoggingEnabled()) {
    return;
  }
  const diagnostics = requestErrorDiagnostics(error);
  const includeToolSchema =
    diagnostics.error_kind === 'invalid_tool_schema' ||
    diagnostics.error_kind === 'invalid_function_parameters' ||
    (Boolean(request?.tools?.length) && toolSchemaFailureLoggingEnabled());
  log('error', message, {
    ...fields,
    duration_ms: Date.now() - requestStartedAt,
    error_code:
      typeof fields.provider === 'string'
        ? `${fields.provider}_upstream_error`
        : ((error as NodeJS.ErrnoException).code ?? 'provider_request_failed'),
    error_name: error instanceof Error ? error.name : 'Error',
    ...diagnostics,
    ...(includeToolSchema
      ? {
          tool_schema: request
            ? toolSchemaDiagnostics(request.tools, {
                choice: request.tool_choice,
                focusUpstreamName: diagnostics.upstream_tool_name,
                applyChoice: fields.provider !== 'doubao',
                mapToolNames: fields.provider !== 'doubao',
              })
            : undefined,
        }
      : {}),
  });
}

function toolSchemaFailureLoggingEnabled(): boolean {
  const value = env('X_ADAPTER_TOOL_SCHEMA_FAILURE_LOGGING', '1').trim().toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(value);
}

async function* withFailureDiagnostics(
  events: AsyncIterable<CanonicalStreamEvent>,
  message: string,
  requestStartedAt: number,
  fields: Record<string, unknown>,
  request: CanonicalRequest,
): AsyncGenerator<CanonicalStreamEvent> {
  let upstreamEventCount = 0;
  try {
    for await (const event of events) {
      if (event.type !== 'start') {
        upstreamEventCount += 1;
      }
      yield event;
    }
  } catch (error) {
    logRequestFailure(
      message,
      requestStartedAt,
      { ...fields, upstream_event_count: upstreamEventCount },
      request,
      error,
    );
    throw error;
  }
}

function invalidInput(c: Context, message: string) {
  return c.json({ error: { message, type: 'invalid_request_error', code: 'invalid_input' } }, 400);
}

function validationError(c: Context, validation: { message: string; code: string; param?: string; status: number }) {
  return c.json(
    {
      error: {
        message: validation.message,
        type: 'invalid_request_error',
        code: validation.code,
        param: validation.param,
      },
    },
    validation.status as 400,
  );
}

function modelError(c: Context, error: unknown) {
  return c.json(
    {
      error: {
        message: errorMessage(error),
        type: 'invalid_request_error',
        code: (error as NodeJS.ErrnoException).code ?? 'model_not_found',
      },
    },
    404,
  );
}

function publicError(error: unknown): {
  error: { message: string; code: string };
  status: 400 | 401 | 404 | 409 | 502;
  clientError: boolean;
} {
  const code = (error as NodeJS.ErrnoException).code ?? 'provider_request_failed';
  const clientError = [
    'invalid_input',
    'unsupported_tools',
    'unsupported_hosted_search',
    'unsupported_multimodal_content',
  ].includes(code);
  const status =
    code === 'model_not_found'
      ? 404
      : code === 'previous_response_unavailable'
        ? 409
        : code.startsWith('missing_') ||
            code === 'invalid_doubao_credentials' ||
            code === 'invalid_trae_credentials' ||
            code === 'insecure_trae_credentials' ||
            code === 'expired_trae_credentials'
          ? 401
          : clientError
            ? 400
            : 502;
  return { error: { message: errorMessage(error), code }, status, clientError };
}

function requestError(c: Context, error: unknown) {
  const response = publicError(error);
  return c.json(
    {
      error: {
        ...response.error,
        type: response.clientError ? 'invalid_request_error' : 'api_error',
      },
    },
    response.status,
  );
}

export function startHttpServer(dependencies?: ServerDependencies) {
  const bindHost = assertLoopbackBindHost(host());
  const bindPort = port();
  const app = createApp(dependencies);
  const server = serve({ fetch: app.fetch, hostname: bindHost, port: bindPort });
  return { app, server, host: bindHost, port: bindPort };
}
