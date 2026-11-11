import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

const messageSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(200_000),
  modelId: z.string().optional().nullable(),
  servedModel: z.string().optional().nullable(),
  webSearch: z.boolean().optional(),
  sources: z.unknown().optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
});

const importSchema = z.object({
  format: z.literal('emorai-export'),
  version: z.number(),
  folders: z
    .array(z.object({ id: z.string().optional(), name: z.string().min(1).max(60), color: z.string().optional().nullable() }))
    .optional(),
  conversations: z
    .array(
      z.object({
        title: z.string().max(120).default('Imported chat'),
        pinned: z.boolean().optional(),
        modelId: z.string().max(120).optional(),
        folderId: z.string().optional().nullable(),
        createdAt: z.string().optional(),
        messages: z.array(messageSchema).max(2000),
      })
    )
    .max(2000),
});

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'The imported file must be valid JSON.');
  }
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_import', 'This file does not match the EmorAI export format.', {
      details: parsed.error.flatten().fieldErrors,
    });
  }
  const settings = await getSettings();

  // Map incoming folder names to fresh folders.
  const folderMap = new Map<string, string>();
  for (const f of parsed.data.folders ?? []) {
    const created = await db.folder.create({ data: { name: f.name.slice(0, 60), color: f.color ?? null } });
    if (f.id) folderMap.set(f.id, created.id);
  }

  let imported = 0;
  for (const c of parsed.data.conversations.slice(0, 2000)) {
    const created = await db.conversation.create({
      data: {
        title: (c.title || 'Imported chat').slice(0, 120),
        pinned: c.pinned ?? false,
        modelId: c.modelId ?? settings.defaultModelId,
        folderId: c.folderId ? folderMap.get(c.folderId) ?? null : null,
      },
    });
    let seq = 0;
    for (const m of c.messages) {
      const ts = m.createdAt ? new Date(m.createdAt) : new Date(Date.now() + seq++);
      await db.message.create({
        data: {
          conversationId: created.id,
          role: m.role,
          content: m.content,
          modelId: m.modelId ?? null,
          servedModel: m.servedModel ?? null,
          webSearch: m.webSearch ?? false,
          sources: m.sources ?? undefined,
          status: ['complete', 'stopped', 'error'].includes(m.status ?? '') ? m.status! : 'complete',
          createdAt: Number.isNaN(ts.getTime()) ? new Date() : ts,
        },
      });
    }
    const last = await db.message.findFirst({ where: { conversationId: created.id }, orderBy: { createdAt: 'desc' } });
    await db.conversation.update({
      where: { id: created.id },
      data: { lastMessageAt: last?.createdAt ?? created.createdAt },
    });
    imported += 1;
  }

  return ok({ imported, conversations: imported });
}
