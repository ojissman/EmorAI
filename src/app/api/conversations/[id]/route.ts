import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { serializeConversation, serializeMessage } from '@/lib/serialize';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: {
      messages: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  });
  if (!conversation) return fail(404, 'not_found', 'Conversation not found.');
  return ok({
    conversation: serializeConversation(conversation, conversation._count.messages),
    messages: conversation.messages.map(serializeMessage),
  });
}

const patchSchema = z.object({
  title: z.string().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  modelId: z.string().min(1).max(120).optional(),
  folderId: z.string().nullable().optional(),
});

export async function PATCH(req: Request, { params }: Params) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Invalid conversation update.', { details: parsed.error.flatten() });
  try {
    const conversation = await db.conversation.update({ where: { id }, data: parsed.data });
    return ok({ conversation: serializeConversation(conversation) });
  } catch {
    return fail(404, 'not_found', 'Conversation not found.');
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    await db.conversation.delete({ where: { id } });
    return ok({ deleted: true });
  } catch {
    return fail(404, 'not_found', 'Conversation not found.');
  }
}
