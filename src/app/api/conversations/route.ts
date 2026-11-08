import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { ok, fail } from '@/lib/api/response';
import { serializeConversation } from '@/lib/serialize';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get('q')?.trim() ?? '';
  const folderId = url.searchParams.get('folderId');

  const where: Record<string, unknown> = {};
  if (folderId === 'none') where.folderId = null;
  else if (folderId) where.folderId = folderId;
  if (q) {
    where.title = { contains: q };
  }

  const conversations = await db.conversation.findMany({
    where,
    orderBy: [{ pinned: 'desc' }, { lastMessageAt: 'desc' }],
    take: 300,
    include: { _count: { select: { messages: true } } },
  });

  return ok({ conversations: conversations.map((c) => serializeConversation(c, c._count.messages)) });
}

const createSchema = z.object({
  title: z.string().max(120).optional(),
  modelId: z.string().max(120).optional(),
  folderId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body allowed
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid conversation payload.');
  const settings = await getSettings();
  const conversation = await db.conversation.create({
    data: {
      title: parsed.data.title ?? 'New chat',
      modelId: parsed.data.modelId ?? settings.defaultModelId,
      folderId: parsed.data.folderId ?? null,
    },
  });
  return ok({ conversation: serializeConversation(conversation, 0) }, { status: 201 });
}
