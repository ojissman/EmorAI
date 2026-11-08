import { z } from 'zod';
import { db } from '@/lib/db';
import { authenticateV1, scopeFailure, modelAllowFailure } from '@/lib/api/auth';
import { resolveModel, listEnabledModels } from '@/lib/model-registry';
import { getSettings } from '@/lib/settings';
import { recordUsage, estimateUsage, requestBodyPreview, modelGuessFromRaw } from '@/lib/usage';
import { ProviderError, streamChat, completeChat } from '@/lib/ai/zai-adapter';
import { SSE_HEADERS, sseDone, sseEvent } from '@/lib/ai/sse';
import { corsPreflight, corsJson } from '@/lib/api/cors';
import {
  chatCompletionsBodySchema,
  openAiError,
  openAiAuthFailure,
  randomId,
  normalizeStop,
  toOpenAiFinishReason,
} from '@/lib/api/protocol/openai';
import type { ProviderContentPart, ProviderMessage, ProviderTool, ProviderToolCall } from '@/lib/types';
import { normalizeChatRole, finalizeProviderMessages } from '@/lib/api/protocol/roles';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ENDPOINT = '/api/v1/chat/completions';

function endpointOf(req: Request): string {
  try {
    return new URL(req.url).pathname;
  } catch {
    return ENDPOINT;
  }
}

function textOf(content: string | Array<{ type: string; text?: string }> | null): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === 'text')
      .map((p) => p.text ?? '')
      .join('\n');
  }
  return '';
}

/** Translates validated OpenAI-format messages into provider messages. */
function toProviderMessages(
  messages: z.infer<typeof chatCompletionsBodySchema>['messages']
): ProviderMessage[] {
  const out: ProviderMessage[] = [];
  for (const m of messages) {
    // Liberal role normalization — see lib/api/protocol/roles.ts
    const role = normalizeChatRole(m.role);
    if (role === 'tool') {
      const toolCallId = m.tool_call_id ?? m.name;
      if (!toolCallId) {
        throw new ProviderError('bad_request', 'Messages with role "tool" require a tool_call_id.', { status: 400 });
      }
      out.push({ role: 'tool', content: textOf(m.content), tool_call_id: toolCallId });
    } else if (role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      const toolCalls: ProviderToolCall[] = m.tool_calls.map((tc, i) => ({
        id: tc.id && tc.id.length > 0 ? tc.id : `call_${Date.now().toString(36)}_${i}`,
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments ?? '{}' },
      }));
      out.push({ role: 'assistant', content: textOf(m.content), tool_calls: toolCalls });
    } else if (Array.isArray(m.content)) {
      const parts: ProviderContentPart[] = m.content
        .filter((p) => p.type === 'text' || p.type === 'image_url')
        .map((p) =>
          p.type === 'text'
            ? { type: 'text' as const, text: p.text ?? '' }
            : { type: 'image_url' as const, image_url: { url: p.image_url?.url ?? '' } }
        )
        .filter((p) => (p.type === 'text' ? p.text.length > 0 : p.image_url.url.length > 0));
      out.push({ role, content: parts.length > 0 ? parts : textOf(m.content) });
    } else {
      out.push({ role, content: textOf(m.content) });
    }
  }
  // Enforce upstream invariants: single leading system message (mid-conversation
  // system content is hoisted), merged consecutive same-role messages, no
  // empty non-tool messages.
  return finalizeProviderMessages(out);
}

function toProviderTools(
  tools: z.infer<typeof chatCompletionsBodySchema>['tools']
): ProviderTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description ?? '',
      parameters: t.function.parameters ?? { type: 'object', properties: {} },
    },
  }));
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
      protocol: 'openai',
      endpoint,
      statusCode: auth.error.status,
      requestId,
      modelId: 'unknown',
      success: false,
      errorText: auth.error.message,
    }).catch(() => undefined);
    return openAiAuthFailure(auth.error);
  }
  const key = auth.key;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return openAiError(400, 'bad_json', 'Request body must be valid JSON.', 'invalid_request_error', undefined, authHeaders);
  }
  const parsed = chatCompletionsBodySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = `Invalid request payload: ${issue?.path.join('.') || 'body'} — ${issue?.message ?? 'malformed body'}`;
    // Schema rejections are logged with a body preview so client-compatibility
    // issues are diagnosable from the dashboard.
    void recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint,
      statusCode: 400,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: modelGuessFromRaw(raw),
      success: false,
      errorText: `${message} | body: ${requestBodyPreview(raw)}`,
    }).catch(() => undefined);
    return openAiError(400, 'invalid_request', message, 'invalid_request_error', undefined, authHeaders);
  }
  const body = parsed.data;

  // ── Permission scopes ──────────────────────────────────────────────────────
  const scopeFail =
    scopeFailure(key, 'chat') ??
    (body.tools && body.tools.length > 0 ? scopeFailure(key, 'tools') : null) ??
    (body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'))
      ? scopeFailure(key, 'vision')
      : null);
  const logClientError = (status: number, code: string, message: string, modelId: string) => {
    void recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint,
      statusCode: status,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId,
      success: false,
      errorText: `${code}: ${message}`.slice(0, 500),
    }).catch(() => undefined);
  };
  if (scopeFail) {
    logClientError(scopeFail.status, scopeFail.code, scopeFail.message, body.model);
    return openAiAuthFailure(scopeFail);
  }
  const modelFail = modelAllowFailure(key, body.model);
  if (modelFail) {
    logClientError(modelFail.status, modelFail.code, modelFail.message, body.model);
    return openAiAuthFailure(modelFail);
  }

  // ── Model resolution (registry + transparent aliases) ──────────────────────
  const resolved = await resolveModel(body.model);
  if (!resolved) {
    const available = await listEnabledModels();
    const message = `Model "${body.model}" does not exist in this EmorAI installation. Available models: ${available
      .map((m) => m.modelId)
      .join(', ')}. GET /api/v1/models lists them.`;
    logClientError(404, 'model_not_found', message, body.model);
    return openAiError(404, 'model_not_found', message, 'invalid_request_error', undefined, authHeaders);
  }
  const model = resolved.model;
  if (!model.enabled) {
    const message = `Model "${model.displayName}" is disabled by the administrator of this installation.`;
    logClientError(409, 'model_disabled', message, model.modelId);
    return openAiError(409, 'model_disabled', message, 'invalid_request_error', undefined, authHeaders);
  }
  if (model.provider !== 'zai') {
    return openAiError(
      501,
      'provider_unavailable',
      `Model "${model.modelId}" routes to provider "${model.provider}", which is not configured on this installation.`,
      'api_error',
      undefined,
      authHeaders
    );
  }

  // Vision parts only reach vision-capable models.
  const hasImageParts = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
  if (hasImageParts && !model.capabilities.vision) {
    return openAiError(
      400,
      'vision_not_supported',
      `Model "${model.displayName}" does not support image inputs. Use a vision-capable model (e.g. glm-4.6v-flash).`,
      'invalid_request_error',
      undefined,
      authHeaders
    );
  }
  if (body.stream && !model.streamSupported) {
    return openAiError(
      400,
      'streaming_not_supported',
      `Model "${model.displayName}" does not support streaming responses.`,
      'invalid_request_error',
      undefined,
      authHeaders
    );
  }

  // Tools only reach tool-capable models (honest capability gate).
  const providerTools = toProviderTools(body.tools);
  if (providerTools && !model.capabilities.tools) {
    return openAiError(
      400,
      'tools_not_supported',
      `Model "${model.displayName}" does not support tool/function calling.`,
      'invalid_request_error',
      undefined,
      authHeaders
    );
  }

  let providerMessages: ProviderMessage[];
  try {
    providerMessages = toProviderMessages(body.messages);
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('bad_request', String((e as Error)?.message ?? e), { status: 400 });
    return openAiError(err.status, err.code, err.message, 'invalid_request_error', undefined, authHeaders);
  }

  const settings = await getSettings();
  const requestedMaxTokens = body.max_tokens ?? body.max_completion_tokens ?? settings.maxTokens;
  const maxTokens = model.maxOutputTokens ? Math.min(requestedMaxTokens, model.maxOutputTokens) : requestedMaxTokens;
  const stop = normalizeStop(body.stop);

  const created = Math.floor(Date.now() / 1000);
  const completionId = randomId('chatcmpl');
  const includeUsage = body.stream_options?.include_usage === true;

  // ── Streaming (OpenAI chunk protocol) ──────────────────────────────────────
  if (body.stream) {
    let full = '';
    let toolCallsOut: Record<number, { id: string; name: string; args: string }> = {};
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    let servedModel: string | null = null;
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort());
    // hard timeout: 180s wall clock for the whole stream
    const timeout = setTimeout(() => abortController.abort(), 180_000);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        let open = true;
        const sendChunk = (payload: unknown) => {
          if (!open) return;
          try {
            controller.enqueue(encoder.encode(sseEvent(payload)));
          } catch {
            open = false;
          }
        };

        const baseChunk = () => ({
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model: servedModel ?? model.modelId,
        });

        try {
          sendChunk({
            ...baseChunk(),
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
          });
          for await (const ev of streamChat({
            messages: providerMessages,
            modelId: model.modelId,
            provider: model.provider,
            temperature: body.temperature ?? settings.temperature,
            maxTokens,
            topP: body.top_p,
            stop,
            tools: providerTools,
            toolChoice: body.tool_choice,
            signal: abortController.signal,
          })) {
            if (ev.type === 'delta') {
              full += ev.content;
              sendChunk({ ...baseChunk(), choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }] });
            } else if (ev.type === 'served-model') {
              servedModel = ev.model;
            } else if (ev.type === 'reasoning') {
              // GLM reasoning trace — forwarded as the de-facto
              // `reasoning_content` delta extension (OpenRouter/GLM style).
              sendChunk({
                ...baseChunk(),
                choices: [{ index: 0, delta: { reasoning_content: ev.content }, finish_reason: null }],
              });
            } else if (ev.type === 'tool-call-delta') {
              const slot = (toolCallsOut[ev.call.index] ??= {
                id: ev.call.id ?? `call_${completionId}_${ev.call.index}`,
                name: '',
                args: '',
              });
              if (ev.call.id) slot.id = ev.call.id;
              if (ev.call.name) slot.name = ev.call.name;
              if (ev.call.argumentsDelta) slot.args += ev.call.argumentsDelta;
              sendChunk({
                ...baseChunk(),
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: ev.call.index,
                          id: ev.call.id ?? (ev.call.name ? slot.id : undefined),
                          type: 'function',
                          function: {
                            name: ev.call.name ?? '',
                            arguments: ev.call.argumentsDelta ?? '',
                          },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              });
            } else if (ev.type === 'usage') {
              usage = {
                prompt_tokens: ev.usage.promptTokens,
                completion_tokens: ev.usage.completionTokens,
                total_tokens: ev.usage.totalTokens,
              };
            } else if (ev.type === 'finish') {
              sendChunk({
                ...baseChunk(),
                choices: [{ index: 0, delta: {}, finish_reason: toOpenAiFinishReason(ev.reason) }],
              });
            }
          }
          if (full.trim().length === 0 && Object.keys(toolCallsOut).length === 0) {
            throw new ProviderError('provider_error', 'The provider returned an empty response.');
          }
          if (includeUsage) {
            const finalUsage =
              usage ??
              (() => {
                const est = estimateUsage(providerMessages, full, Object.values(toolCallsOut).map((t) => ({ arguments: t.args })));
                return { prompt_tokens: est.promptTokens, completion_tokens: est.completionTokens, total_tokens: est.totalTokens };
              })();
            usage = finalUsage;
            sendChunk({ ...baseChunk(), choices: [], usage: finalUsage });
          }
          void db.apiKey.update({ where: { id: key.apiKeyId }, data: { requestCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
          await recordUsage({
            source: 'api',
            protocol: 'openai',
            endpoint,
            statusCode: 200,
            requestId,
            apiKeyId: key.apiKeyId,
            modelId: model.modelId,
            servedModel,
            usage: usage
              ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens }
              : estimateUsage(providerMessages, full, Object.values(toolCallsOut).map((t) => ({ arguments: t.args }))),
            latencyMs: Date.now() - startedAt,
            success: true,
          });
          controller.enqueue(encoder.encode(sseDone()));
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
          await recordUsage({
            source: 'api',
            protocol: 'openai',
            endpoint,
            statusCode: err.status,
            requestId,
            apiKeyId: key.apiKeyId,
            modelId: model.modelId,
            servedModel,
            success: false,
            errorText: err.message,
            latencyMs: Date.now() - startedAt,
          });
          sendChunk({
            ...baseChunk(),
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            error: { message: err.message, type: 'provider_error', code: err.code },
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

  // ── Non-streaming ──────────────────────────────────────────────────────────
  try {
    const res = await completeChat({
      messages: providerMessages,
      modelId: model.modelId,
      provider: model.provider,
      temperature: body.temperature ?? settings.temperature,
      maxTokens,
      topP: body.top_p,
      stop,
      tools: providerTools,
      toolChoice: body.tool_choice,
    });
    if ((!res.content || res.content.trim().length === 0) && res.toolCalls.length === 0) {
      throw new ProviderError('provider_error', 'The provider returned an empty response.');
    }
    const usage = res.usage ?? estimateUsage(providerMessages, res.content, res.toolCalls);
    await recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint,
      statusCode: 200,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: model.modelId,
      servedModel: res.servedModel,
      usage,
      latencyMs: Date.now() - startedAt,
      success: true,
    });
    const message: Record<string, unknown> = { role: 'assistant', content: res.content };
    if (res.toolCalls.length > 0) {
      message.tool_calls = res.toolCalls;
      if (!res.content) message.content = null;
    }
    if (res.reasoning) message.reasoning_content = res.reasoning;
    return corsJson(
      {
        id: completionId,
        object: 'chat.completion',
        created,
        model: res.servedModel ?? model.modelId,
        choices: [
          {
            index: 0,
            message,
            finish_reason: toOpenAiFinishReason(res.finishReason),
          },
        ],
        usage: {
          prompt_tokens: usage.promptTokens,
          completion_tokens: usage.completionTokens,
          total_tokens: usage.totalTokens,
        },
        // EmorAI transparency extension
        emorai_requested_model: model.modelId,
      },
      { headers: { ...authHeaders, 'x-emorai-served-model': res.servedModel ?? model.modelId } }
    );
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
    await recordUsage({
      source: 'api',
      protocol: 'openai',
      endpoint,
      statusCode: err.status,
      requestId,
      apiKeyId: key.apiKeyId,
      modelId: model.modelId,
      success: false,
      errorText: err.message,
      latencyMs: Date.now() - startedAt,
    });
    const headers = { ...authHeaders };
    if (err.code === 'rate_limited') headers['retry-after'] = '15';
    return openAiError(err.status, err.code, err.message, 'provider_error', undefined, headers);
  }
}
