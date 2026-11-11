import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { getModelInfoByModelId } from '@/lib/model-registry';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { completeChat } from '@/lib/ai/zai-adapter';
import { recordUsage, estimateUsage } from '@/lib/usage';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/** Conversation summarization capability: condenses a conversation into a brief. */
export async function POST(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  if (!conversation) return fail(404, 'not_found', 'Conversation not found.');
  if (conversation.messages.length === 0) return fail(400, 'empty', 'Nothing to summarize yet.');

  const settings = await getSettings();
  const model =
    (await getModelInfoByModelId(conversation.modelId)) ??
    (await getModelInfoByModelId(settings.defaultModelId));
  if (!model || !model.enabled) {
    return fail(409, 'model_unavailable', 'No enabled model is available to generate the summary. Check Settings → Models.');
  }

  const transcript = conversation.messages
    .slice(-40)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 2000)}`)
    .join('\n\n')
    .slice(0, 60_000);

  const started = Date.now();
  try {
    const res = await completeChat({
      messages: [
        {
          role: 'system',
          content:
            'You summarize conversations. Produce a Markdown summary: a one-paragraph overview, then bullet points of key facts, decisions and open questions. Keep it under 250 words.',
        },
        { role: 'user', content: `Summarize this conversation:\n\n${transcript}` },
      ],
      modelId: model.modelId,
      provider: model.provider,
      temperature: 0.3,
      maxTokens: 800,
    });
    await recordUsage({
      source: 'dashboard',
      conversationId: conversation.id,
      modelId: model.modelId,
      servedModel: res.servedModel,
      usage: res.usage ?? estimateUsage([{ content: transcript }], res.content),
      latencyMs: Date.now() - started,
    });
    return ok({ summary: res.content, servedModel: res.servedModel });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    await recordUsage({
      source: 'dashboard',
      conversationId: conversation.id,
      modelId: model.modelId,
      success: false,
      errorText: message,
      latencyMs: Date.now() - started,
    });
    return fail(502, 'summary_failed', message);
  }
}
