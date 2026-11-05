import { z } from 'zod';
import { db } from '@/lib/db';
import { authenticateV1 } from '@/lib/api/auth';
import { getModelInfoByModelId } from '@/lib/model-registry';
import { getSettings } from '@/lib/settings';
import { recordUsage, estimateUsage } from '@/lib/usage';
import { ProviderError, streamChat, completeChat } from '@/lib/ai/zai-adapter';
import { SSE_HEADERS, sseDone, sseEvent } from '@/lib/ai/sse';
import type { ProviderMessage } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 300;

function openAiError(status: number, code: string, message: string, type = 'invalid_request_error') {
  return Response.json({ error: { message, type, code } }, { status });
}

const contentPartSchema = z.object({
  type: z.enum(['text', 'image_url']),
  text: z.string().optional(),
  image_url: z.object({ url: z.string() }).optional(),
});

const bodySchema = z.object({
  model: z.string().min(1).max(120),
  messages: z
    .array(
      z.object({
        role: z.enum(['system', 'user', 'assistant']),
        content: z.union([z.string().max(200_000), z.array(contentPartSchema).max(16)]),
      })
    )
    .min(1)
    .max(128),
  stream: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(32_000).optional(),
  top_p: z.number().min(0).max(1).optional(),
});

function randomId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function textOf(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p) => p.type === 'text')
    .map((p) => p.text ?? '')
    .join('\n');
}

export async function POST(req: Request) {
  const auth = await authenticateV1(req);
  if (!auth.ok) return auth.response;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return openAiError(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return openAiError(400, 'invalid_request', `Invalid request payload: ${parsed.error.issues[0]?.message ?? 'malformed body'}`);
  }
  const body = parsed.data;

  const model = await getModelInfoByModelId(body.model);
  if (!model) {
    return openAiError(404, 'model_not_found', `Model "${body.model}" does not exist in this EmorAI installation. GET /api/v1/models lists available IDs.`, 'invalid_request_error');
  }
  if (!model.enabled) {
    return openAiError(409, 'model_disabled', `Model "${model.displayName}" is disabled by the administrator of this installation.`, 'invalid_request_error');
  }

  // Vision parts only reach vision-capable models.
  const hasImageParts = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
  );
  if (hasImageParts && !model.capabilities.vision) {
    return openAiError(400, 'vision_not_supported', `Model "${model.displayName}" does not support image inputs. Use a vision-capable model (e.g. glm-4.6v-flash).`);
  }

  const settings = await getSettings();
  const providerMessages: ProviderMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const created = Math.floor(Date.now() / 1000);
  const startedAt = Date.now();

  // ── Streaming (OpenAI chunk protocol) ──────────────────────────────────────
  if (body.stream) {
    let full = '';
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    let servedModel: string | null = null;
    let failure: { status: number; payload: unknown } | null = null;
    const abortController = new AbortController();
    req.signal.addEventListener('abort', () => abortController.abort());

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
          id: randomId('chatcmpl'),
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
            maxTokens: body.max_tokens ?? settings.maxTokens,
            signal: abortController.signal,
          })) {
            if (ev.type === 'delta') {
              full += ev.content;
              sendChunk({ ...baseChunk(), choices: [{ index: 0, delta: { content: ev.content }, finish_reason: null }] });
            } else if (ev.type === 'served-model') {
              servedModel = ev.model;
            } else if (ev.type === 'usage') {
              usage = {
                prompt_tokens: ev.usage.promptTokens,
                completion_tokens: ev.usage.completionTokens,
                total_tokens: ev.usage.totalTokens,
              };
            } else if (ev.type === 'finish') {
              sendChunk({
                ...baseChunk(),
                choices: [{ index: 0, delta: {}, finish_reason: ev.reason === 'length' ? 'length' : 'stop' }],
              });
            }
          }
          if (full.trim().length === 0) {
            throw new ProviderError('provider_error', 'The provider returned an empty response.');
          }
          void db.apiKey.update({ where: { id: auth.apiKeyId }, data: { requestCount: { increment: 1 }, lastUsedAt: new Date() } }).catch(() => undefined);
          await recordUsage({
            source: 'api',
            apiKeyId: auth.apiKeyId,
            modelId: model.modelId,
            servedModel,
            usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens } : estimateUsage(providerMessages, full),
            latencyMs: Date.now() - startedAt,
            success: true,
          });
          controller.enqueue(encoder.encode(sseDone()));
        } catch (e) {
          const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
          await recordUsage({
            source: 'api',
            apiKeyId: auth.apiKeyId,
            modelId: model.modelId,
            servedModel,
            success: false,
            errorText: err.message,
            latencyMs: Date.now() - startedAt,
          });
          failure = { status: err.status, payload: { error: { message: err.message, type: 'provider_error', code: err.code } } };
          sendChunk({
            ...baseChunk(),
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            error: { message: err.message, type: 'provider_error', code: err.code },
          });
        } finally {
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

    return new Response(stream, { headers: { ...SSE_HEADERS } });
  }

  // ── Non-streaming ──────────────────────────────────────────────────────────
  try {
    const res = await completeChat({
      messages: providerMessages,
      modelId: model.modelId,
      provider: model.provider,
      temperature: body.temperature ?? settings.temperature,
      maxTokens: body.max_tokens ?? settings.maxTokens,
    });
    if (!res.content || res.content.trim().length === 0) {
      throw new ProviderError('provider_error', 'The provider returned an empty response.');
    }
    const usage = res.usage ?? estimateUsage(providerMessages, res.content);
    await recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: model.modelId,
      servedModel: res.servedModel,
      usage,
      latencyMs: Date.now() - startedAt,
      success: true,
    });
    return Response.json({
      id: randomId('chatcmpl'),
      object: 'chat.completion',
      created,
      model: res.servedModel ?? model.modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: res.content },
          finish_reason: res.finishReason ?? 'stop',
        },
      ],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    });
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError('provider_error', String((e as Error)?.message ?? e));
    await recordUsage({
      source: 'api',
      apiKeyId: auth.apiKeyId,
      modelId: model.modelId,
      success: false,
      errorText: err.message,
      latencyMs: Date.now() - startedAt,
    });
    return openAiError(err.status, err.code, err.message, 'provider_error');
  }
}
