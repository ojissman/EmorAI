import { db } from '@/lib/db';
import { authenticateV1 } from '@/lib/api/auth';
import { resolveModel, listEnabledModels } from '@/lib/model-registry';
import { getSettings } from '@/lib/settings';
import { recordUsage, estimateUsage, requestBodyPreview, modelGuessFromRaw } from '@/lib/usage';
import { ProviderError } from '@/lib/ai/zai-adapter';
import { streamChatRouted, completeChatRouted, type RouteAttribution } from '@/lib/ai/router';
import { SSE_HEADERS } from '@/lib/ai/sse';
import { corsPreflight } from '@/lib/api/cors';
import { randomId } from '@/lib/api/protocol/openai';
import {
  anthropicBodySchema,
  anthropicError,
  anthropicAuthFailure,
  anthropicToProvider,
  anthropicProviderError,
  AnthropicStreamTranslator,
  ProtocolTranslationError,
  anthropicScopeFailure,
  anthropicModelAllowFailure,
  estimateInputTokens,
  buildAnthropicMessage,
} from '@/lib/api/protocol/anthropic';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ENDPOINT = '/api/v1/messages';

function endpointOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return ENDPOINT;
  }
}

export async function OPTIONS() {
  return corsPreflight();
}

export async function POST(req: Request) {
  const requestId = randomId('req');
  const authHeaders = { 'request-id': requestId };
  const startedAt = Date.now();
  const endpoint = endpointOf(req);

  const auth = await authenticateV1(req);
  if (!auth.ok) {
    void recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint,
      statusCode: auth.error.status,
      requestId,
      modelId: 'unknown',
      success: false,
      errorText: auth.error.message,
    }).catch(() => undefined);
    return anthropicAuthFailure(auth.error);
  }
  const key = auth.key;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return anthropicError(400, 'invalid_request_error', 'Request body must be valid JSON.', authHeaders);
  }
  const parsed = anthropicBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = `Invalid request: ${issue?.path.join('.') || 'body'} — ${issue?.message ?? 'malformed body'}`;
    // Schema rejections are logged with a body preview so client-compatibility
    // issues (like ZCode's leaked roles) are diagnosable from the dashboard —
    // previously these failures left no trace at all.
    void recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint,
      statusCode: 400,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: modelGuessFromRaw(raw),
      success: false,
      errorText: `${message} | body: ${requestBodyPreview(raw)}`,
    }).catch(() => undefined);
    return anthropicError(400, 'invalid_request_error', message, authHeaders);
  }
  const body = parsed.data;

  // ── Permission scopes (Anthropic view) ─────────────────────────────────────
  const scopeFail =
    anthropicScopeFailure(key, 'chat') ??
    (body.tools && body.tools.length > 0 ? anthropicScopeFailure(key, 'tools') : null) ??
    (body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))
      ? anthropicScopeFailure(key, 'vision')
      : null);
  const logClientError = (status: number, type: string, message: string, modelId: string) => {
    void recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint,
      statusCode: status,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId,
      success: false,
      errorText: `${type}: ${message}`.slice(0, 500),
    }).catch(() => undefined);
  };
  if (scopeFail) {
    logClientError(403, 'insufficient_scope', 'Key lacks required scope.', body.model);
    return scopeFail;
  }
  const modelFail = anthropicModelAllowFailure(key, body.model);
  if (modelFail) {
    logClientError(403, 'model_not_allowed', 'Model not on allowlist.', body.model);
    return modelFail;
  }

  // ── Model resolution ───────────────────────────────────────────────────────
  const resolved = await resolveModel(body.model);
  if (!resolved) {
    const available = await listEnabledModels();
    const message = `Model "${body.model}" does not exist in this EmorAI installation. Available models: ${available
      .map((m) => m.modelId)
      .join(', ')}. List them via GET /api/v1/models.`;
    logClientError(404, 'not_found_error', message, body.model);
    return anthropicError(404, 'not_found_error', message, authHeaders);
  }
  const model = resolved.model;
  if (!model.enabled) {
    const message = `Model "${model.displayName}" is disabled by the administrator of this installation.`;
    logClientError(404, 'model_disabled', message, model.modelId);
    return anthropicError(404, 'not_found_error', message, authHeaders);
  }
  // Provider-category models (adopted from openai/anthropic/self-hosted
  // accounts) execute through their configured ModelRoutes — the intelligent
  // router is the single eligibility authority and answers honestly (501)
  // when a model has no eligible route. No provider allowlist gate here.

  const hasImages = body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'));
  if (hasImages && !model.capabilities.vision) {
    return anthropicError(
      400,
      'invalid_request_error',
      `Model "${model.displayName}" does not support image inputs. Use a vision-capable model (e.g. glm-4.6v-flash).`,
      authHeaders
    );
  }
  if (body.tools && body.tools.length > 0 && !model.capabilities.tools) {
    return anthropicError(
      400,
      'invalid_request_error',
      `Model "${model.displayName}" does not support tool use.`,
      authHeaders
    );
  }

  // ── Protocol translation: Anthropic → provider ─────────────────────────────
  const settings = await getSettings();
  let translated;
  try {
    translated = anthropicToProvider(body, {
      defaultMaxTokens: Math.min(settings.maxTokens, 8192),
      modelMaxOutputTokens: model.maxOutputTokens,
    });
  } catch (e) {
    if (e instanceof ProtocolTranslationError) {
      return anthropicError(e.status, e.type, e.message, authHeaders);
    }
    return anthropicError(400, 'invalid_request_error', String((e as Error)?.message ?? e), authHeaders);
  }

  const messageId = randomId('msg');
  const estimatedInput = estimateInputTokens(translated.messages, null);

  const providerOpts = {
    messages: translated.messages,
    temperature: translated.temperature,
    maxTokens: translated.maxTokens,
    topP: translated.topP,
    topK: translated.topK,
    stop: translated.stop,
    tools: translated.tools,
    toolChoice: translated.toolChoice,
    thinkingEnabled: translated.thinkingEnabled,
  };
  // routing attribution — filled by the router before the first event
  const attribution: RouteAttribution = {};

  // ── Streaming (Anthropic SSE event protocol) ───────────────────────────────
  if (body.stream) {
    if (!model.streamSupported) {
      return anthropicError(400, 'invalid_request_error', `Model "${model.displayName}" does not support streaming.`, authHeaders);
    }
    const translator = new AnthropicStreamTranslator({
      messageId,
      requestedModel: body.model,
      estimatedInputTokens: estimatedInput,
    });
    let servedModel: string | null = null;
    let finishReason: string | null = null;
    let full = '';
    let sawToolCall = false;
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort());
    const timeout = setTimeout(() => abortController.abort(), 180_000);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let open = true;
        const write = (text: string) => {
          if (!open || text.length === 0) return;
          try {
            controller.enqueue(encoder.encode(text));
          } catch {
            open = false;
          }
        };

        write(translator.start());
        try {
          for await (const ev of streamChatRouted(
            body.model,
            { ...providerOpts, signal: abortController.signal, requestId, attribution },
            { vision: hasImages, tools: !!(body.tools && body.tools.length > 0) }
          )) {
            if (ev.type === 'delta') full += ev.content;
            if (ev.type === 'tool-call-delta') sawToolCall = true;
            if (ev.type === 'served-model') servedModel = ev.model;
            if (ev.type === 'finish') finishReason = ev.reason;
            write(translator.onEvent(ev));
          }
          if (full.trim().length === 0 && !sawToolCall) {
            throw new ProviderError('provider_error', 'The provider returned an empty response.');
          }
          write(translator.finish(finishReason));
          void db.apiKey
            .update({ where: { id: key.apiKeyId }, data: { requestCount: { increment: 1 }, lastUsedAt: new Date() } })
            .catch(() => undefined);
          const usage = translator.finalUsage;
          await recordUsage({
            source: 'api',
            protocol: 'anthropic',
            endpoint,
            statusCode: 200,
            requestId,
            apiKeyId: key.apiKeyId,
            modelId: model.modelId,
            servedModel,
            usage: usage ?? estimateUsage(translated.messages, full),
            latencyMs: Date.now() - startedAt,
            success: true,
            routeId: attribution.routeId ?? null,
            providerAccountId: attribution.providerAccountId ?? null,
          });
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
          write(
            translator.errorFrame(
              err.code === 'rate_limited' ? 'rate_limit_error' : 'overloaded_error',
              err.message
            )
          );
          await recordUsage({
            source: 'api',
            protocol: 'anthropic',
            endpoint,
            statusCode: err.status,
            requestId,
            apiKeyId: key.apiKeyId,
            modelId: model.modelId,
            servedModel,
            success: false,
            errorText: err.message,
            latencyMs: Date.now() - startedAt,
            routeId: attribution.routeId ?? null,
            providerAccountId: attribution.providerAccountId ?? null,
          });
        } finally {
          clearTimeout(timeout);
          open = false;
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      },
      cancel() {
        abortController.abort();
      },
    });

    return new Response(stream, {
      headers: {
        ...SSE_HEADERS,
        'request-id': requestId,
        'x-emorai-served-model': model.modelId,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'request-id, retry-after, x-emorai-served-model',
      },
    });
  }

  // ── Non-streaming (Anthropic message response) ─────────────────────────────
  try {
    const res = await completeChatRouted(
      body.model,
      { ...providerOpts, requestId, attribution },
      { vision: hasImages, tools: !!(body.tools && body.tools.length > 0) }
    );
    if ((!res.content || res.content.trim().length === 0) && res.toolCalls.length === 0) {
      throw new ProviderError('provider_error', 'The provider returned an empty response.');
    }
    const usage = res.usage ?? estimateUsage(translated.messages, res.content, res.toolCalls);
    await recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint,
      statusCode: 200,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: model.modelId,
      servedModel: res.servedModel,
      usage,
      latencyMs: Date.now() - startedAt,
      success: true,
      routeId: attribution.routeId ?? null,
      providerAccountId: attribution.providerAccountId ?? null,
    });
    const message = buildAnthropicMessage({
      id: messageId,
      requestedModel: body.model,
      servedModel: res.servedModel,
      content: res.content,
      toolCalls: res.toolCalls,
      finishReason: res.finishReason,
      usage,
    });
    return new Response(JSON.stringify(message), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'request-id': requestId,
        'x-emorai-served-model': res.servedModel ?? model.modelId,
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'request-id, retry-after, x-emorai-served-model',
      },
    });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
    await recordUsage({
      source: 'api',
      protocol: 'anthropic',
      endpoint,
      statusCode: err.status,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: model.modelId,
      success: false,
      errorText: err.message,
      latencyMs: Date.now() - startedAt,
      routeId: attribution.routeId ?? null,
      providerAccountId: attribution.providerAccountId ?? null,
    });
    const headers = { ...authHeaders };
    if (err.code === 'rate_limited') headers['retry-after'] = '15';
    return anthropicProviderError(err.code, err.message, err.status);
  }
}
