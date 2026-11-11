import { db } from '@/lib/db';
import { ok } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

const EXPORT_VERSION = 1;

/** Exports every conversation + message as a portable JSON document. */
export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const conversations = await db.conversation.findMany({
    orderBy: { createdAt: 'asc' },
    include: { messages: { orderBy: { createdAt: 'asc' } } },
  });
  const folders = await db.folder.findMany({ orderBy: { createdAt: 'asc' } });

  const payload = {
    format: 'emorai-export',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    folders: folders.map((f) => ({ id: f.id, name: f.name, color: f.color })),
    conversations: conversations.map((c) => ({
      title: c.title,
      pinned: c.pinned,
      modelId: c.modelId,
      folderId: c.folderId,
      createdAt: c.createdAt.toISOString(),
      messages: c.messages.map((m) => ({
        role: m.role,
        content: m.content,
        modelId: m.modelId,
        servedModel: m.servedModel,
        webSearch: m.webSearch,
        sources: m.sources,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
      })),
    })),
  };

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="emorai-export-${date}.json"`,
    },
  });
}
