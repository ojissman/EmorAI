import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { getModelInfoByModelId } from '@/lib/model-registry';
import { rateLimit } from '@/lib/rate-limit';
import { recordUsage, estimateUsage } from '@/lib/usage';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { SSE_HEADERS, sseEvent } from '@/lib/ai/sse';
import { ProviderError, generateTitle, webSearch } from '@/lib/ai/zai-adapter';
import { streamChatRouted, type RouteAttribution } from '@/lib/ai/router';
import { buildProviderMessages } from '@/lib/ai/prompt';
import { serializeMessage } from '@/lib/serialize';
import type { ChatStreamEvent, TokenUsage, WebSource } from '@/lib/types';
import type { Message } from '@prisma/client';

export const runtime = 'nodejs';
export const maxDuration = 300;

const chatRequestSchema = z.object({
  conversationId: z.string().min(1).optional(),
  message: z.string().max(64_000).optional(),
  modelId: z.string().min(1).max(120),
  mode: z.enum(['send', 'regenerate', 'edit']).default('send'),
  editMessageId: z.string().min(1).optional(),
  webSearch: z.boolean().default(false),
  attachmentIds: z.array(z.string().min(1)).max(6).default([]),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

async function loadHistoryWithFiles(conversationId: string, limit: number): Promise<Message[]> {
  const rows = await db.message.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
  });
  const windowed = rows.slice(-limit);
  const fileIds = new Set<string>();
  for (const m of windowed) {
    const atts = Array.isArray(m.attachments) ? (m.attachments as { id: string }[]) : [];
    for (const a of atts) if (a?.id) fileIds.add(a.id);
  }
  const files = fileIds.size > 0 ? await db.fileMetadata.findMany({ where: { id: { in: [...fileIds] } } }) : [];
  return windowed.map((m) => ({
    ...m,
    _files: files.filter((f) =>
      Array.isArray(m.attachments) ? (m.attachments as { id: string }[]).some((a) => a.id === f.id) : false
    ),
  }));
}

export async function POST(req: Request) {
  // Auth guard runs before any streaming starts.
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }

  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid chat request.', { details: parsed.error.flatten() });
  }
  const input = parsed.data;
  if (input.mode === 'send' && (!input.message || input.message.trim().length === 0) && input.attachmentIds.length === 0) {
    return fail(400, 'empty_message', 'Type a message before sending.');
  }
  if (input.mode === 'edit' && !input.editMessageId) {
    return fail(400, 'missing_edit_target', 'edit mode requires editMessageId.');
  }

  // Dashboard rate limiting (per client IP).
  const settings = await getSettings();
  const rl = rateLimit(`dash:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `You are sending messages too quickly. Retry after ${rl.retryAfterSec}s.`, {
      retry_after_sec: rl.retryAfterSec,
    });
  }

  // Resolve + validate model availability honestly (no silent switching).
  const model = await getModelInfoByModelId(input.modelId);
  if (!model) {
    return fail(400, 'unknown_model', `Model "${input.modelId}" is not in the EmorAI registry. Configure it in Settings → Models.`);
  }
  if (!model.enabled) {
    return fail(
      409,
      'model_disabled',
      `"${model.displayName}" is disabled in Settings → Models. Enable it or pick another model — EmorAI never switches models silently.`
    );
  }
  // Hoisted closures (persistAssistant below) cannot rely on control-flow
  // narrowing of `model`, so bake the non-null type into an alias.
  const activeModel = model;

  // ── Conversation state per mode ────────────────────────────────────────────
  let conversation = null as Awaited<ReturnType<typeof db.conversation.findUnique>>;
  let userMessage: Message | null = null;

  if (input.mode === 'send') {
    if (input.conversationId) {
      conversation = await db.conversation.findUnique({ where: { id: input.conversationId } });
      if (!conversation) return fail(404, 'conversation_not_found', 'That conversation no longer exists.');
    } else {
      conversation = await db.conversation.create({
        data: { title: 'New chat', modelId: model.modelId },
      });
    }
    const attachments = input.attachmentIds.length
      ? await db.fileMetadata.findMany({ where: { id: { in: input.attachmentIds } } })
      : [];
    const attachmentMeta = attachments.map((f) => ({
      id: f.id,
      name: f.name,
      mime: f.mime,
      size: f.size,
      kind: f.kind as 'image' | 'document',
    }));
    userMessage = await db.message.create({
      data: {
        conversationId: conversation.id,
        role: 'user',
        content: input.message?.trim() ?? '',
        webSearch: input.webSearch,
        attachments: attachmentMeta.length > 0 ? attachmentMeta : undefined,
      },
    });
  } else if (input.mode === 'regenerate') {
    if (!input.conversationId) return fail(400, 'missing_conversation', 'regenerate requires conversationId.');
    conversation = await db.conversation.findUnique({ where: { id: input.conversationId } });
    if (!conversation) return fail(404, 'conversation_not_found', 'That conversation no longer exists.');
    const lastAssistant = await db.message.findFirst({
      where: { conversationId: conversation.id, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
    });
    if (lastAssistant) await db.message.delete({ where: { id: lastAssistant.id } });
  } else {
    // edit: rewrite a user message and truncate everything after it
    if (!input.conversationId) return fail(400, 'missing_conversation', 'edit requires conversationId.');
    conversation = await db.conversation.findUnique({ where: { id: input.conversationId } });
    if (!conversation) return fail(404, 'conversation_not_found', 'That conversation no longer exists.');
    const target = await db.message.findUnique({ where: { id: input.editMessageId! } });
    if (!target || target.conversationId !== conversation.id) {
      return fail(404, 'message_not_found', 'The message being edited was not found.');
    }
    await db.message.deleteMany({
      where: { conversationId: conversation.id, createdAt: { gt: target.createdAt } },
    });
    userMessage = await db.message.update({
      where: { id: target.id },
      data: { content: input.message?.trim() ?? '', webSearch: input.webSearch },
    });
  }

  conversation = await db.conversation.update({
    where: { id: conversation.id },
    data: { modelId: model.modelId, lastMessageAt: new Date() },
  });

  const history = await loadHistoryWithFiles(conversation.id, settings.contextMessageLimit);

  // ── Optional web search (EmorAI-side tool, works with any text model) ─────
  let sources: WebSource[] | null = null;
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  if (input.webSearch && lastUser && lastUser.content.trim()) {
    try {
      sources = await webSearch(lastUser.content);
    } catch (e) {
      // Search failing must not kill the chat — proceed without results but record it.
      console.error('web_search failed:', e);
      sources = [];
    }
  }

  const providerMessages = await buildProviderMessages({
    history,
    systemInstructions: settings.systemInstructions,
    vision: model.capabilities.vision,
    webSearchSources: sources && sources.length > 0 ? sources : undefined,
  });

  const assistantMessage = await db.message.create({
    data: {
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      modelId: model.modelId,
      status: 'streaming',
    },
  });

  // ── SSE stream ─────────────────────────────────────────────────────────────
  const abortController = new AbortController();
  req.signal.addEventListener('abort', () => abortController.abort());
  const startedAt = Date.now();
  let finalUsage: TokenUsage | null = null;
  let servedModel: string | null = null;
  let fullContent = '';
  let fullReasoning = '';
  // routing attribution — filled by the router before the first event
  const attribution: RouteAttribution = {};

  async function persistAssistant(status: 'complete' | 'stopped' | 'error', errorText?: string) {
    const data = await db.message.update({
      where: { id: assistantMessage.id },
      data: {
        content: fullContent,
        reasoning: fullReasoning || null,
        servedModel,
        status,
        errorText: errorText ?? null,
        webSearch: input.webSearch,
        sources: sources && sources.length > 0 ? sources : undefined,
        promptTokens: finalUsage?.promptTokens ?? null,
        completionTokens: finalUsage?.completionTokens ?? null,
        totalTokens: finalUsage?.totalTokens ?? null,
        latencyMs: Date.now() - startedAt,
      },
    });
    await recordUsage({
      source: 'dashboard',
      conversationId: conversation!.id,
      modelId: activeModel.modelId,
      servedModel,
      usage: finalUsage ?? estimateUsage(providerMessages, fullContent),
      latencyMs: Date.now() - startedAt,
      success: status === 'complete',
      errorText,
      routeId: attribution.routeId ?? null,
      providerAccountId: attribution.providerAccountId ?? null,
    });
    return data;
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      let open = true;
      const send = (evt: ChatStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(sseEvent(evt)));
        } catch {
          open = false;
        }
      };

      const emitStart = () => {
        send({
          type: 'start',
          conversationId: conversation!.id,
          userMessageId: userMessage?.id ?? '',
          assistantMessageId: assistantMessage.id,
          modelId: model.modelId,
        });
        if (sources && sources.length > 0) send({ type: 'sources', sources });
      };

      try {
        emitStart();
        for await (const ev of streamChatRouted(
          input.modelId,
          {
            messages: providerMessages,
            temperature: settings.temperature,
            maxTokens: settings.maxTokens,
            signal: abortController.signal,
            requestId: `dash-${Date.now().toString(36)}`,
            attribution,
          },
          { vision: false, tools: false }
        )) {
          if (ev.type === 'delta') {
            fullContent += ev.content;
            send({ type: 'delta', content: ev.content });
          } else if (ev.type === 'reasoning') {
            fullReasoning += ev.content;
            send({ type: 'reasoning', content: ev.content });
          } else if (ev.type === 'served-model') {
            servedModel = ev.model;
            send({ type: 'served-model', modelId: model.modelId, servedModel: ev.model });
          } else if (ev.type === 'usage') {
            finalUsage = ev.usage;
          }
        }

        if (fullContent.trim().length === 0) {
          throw new ProviderError('provider_error', 'The provider returned an empty response. Try again or switch models.');
        }

        const saved = await persistAssistant('complete');

        if (finalUsage) send({ type: 'usage', usage: finalUsage });
        // done FIRST — the composer unlocks and the message finalizes while
        // the stream stays open for the cosmetic extras below.
        send({ type: 'done', message: serializeMessage(saved) });

        // Auto-title on the first exchange. Runs AFTER done (and never blocks
        // it): the title request joins the upstream start-gate at background
        // priority — when the provider is busy it balks and the local
        // fallback title is used instead of stacking latency or 429 pressure.
        if (settings.titleGeneration && conversation.title === 'New chat') {
          const count = await db.message.count({ where: { conversationId: conversation.id } });
          if (count <= 3) {
            const title = await generateTitle(lastUser?.content ?? input.message ?? '', fullContent);
            await db.conversation.update({ where: { id: conversation.id }, data: { title } });
            send({ type: 'title', title, conversationId: conversation.id });
          }
        }
      } catch (e) {
        const aborted = abortController.signal.aborted || (e as Error)?.name === 'AbortError';
        if (aborted) {
          const saved = await persistAssistant('stopped');
          send({ type: 'done', message: serializeMessage(saved) });
        } else {
          const err =
            e instanceof ProviderError
              ? e
              : new ProviderError('provider_error', String((e as Error)?.message ?? 'Unknown provider failure'));
          await persistAssistant('error', err.message);
          send({ type: 'error', code: err.code, message: err.message });
        }
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
