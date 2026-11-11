import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { serializeMessage } from '@/lib/serialize';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const conversation = await db.conversation.findUnique({ where: { id } });
  if (!conversation) return fail(404, 'not_found', 'Conversation not found.');
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get('limit') ?? '0');
  const messages = await db.message.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: 'asc' },
    ...(limitParam > 0 ? { take: limitParam } : {}),
  });
  return ok({ messages: messages.map(serializeMessage) });
}
