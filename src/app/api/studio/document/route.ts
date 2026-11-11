import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { getModelInfoByModelId, listEnabledModels } from '@/lib/model-registry';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { completeChat } from '@/lib/ai/zai-adapter';
import { markdownToDocx, htmlToPdf, writeArtifactFile } from '@/lib/ai/media';
import { serializeArtifact } from '@/lib/artifacts';

export const runtime = 'nodejs';
export const maxDuration = 300;

const schema = z.object({
  title: z.string().min(1).max(120),
  prompt: z.string().min(3).max(8000),
  format: z.enum(['md', 'html', 'docx', 'pdf']),
  modelId: z.string().min(1).max(120).optional(),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

function stripFences(text: string): string {
  const trimmed = text.trim();
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(trimmed);
  return fence ? fence[1].trim() : trimmed;
}

const DOC_SYSTEM = `You are EmorAI's professional document writer. Write polished, well-structured, publication-ready documents.
Rules:
- Output ONLY the document content itself — no meta commentary, no explanations, no code fences around the whole document.
- For markdown formats: use clean Markdown (headings #/##/###, paragraphs, bullet lists, tables, **bold**, *italic*, > quotes, --- separators).
- For HTML formats: output a complete standalone HTML document with <head> including <title>, embedded CSS, semantic structure, print-friendly typography. No JavaScript frameworks, no external network resources (no CDN links) — keep everything self-contained.
- Match the user's requested tone, length and audience.`;

function mimeFor(format: 'md' | 'html' | 'docx' | 'pdf'): string {
  switch (format) {
    case 'md':
      return 'text/markdown';
    case 'html':
      return 'text/html';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pdf':
      return 'application/pdf';
  }
}

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid document request.', { details: parsed.error.flatten() });
  }
  const { title, prompt, format, modelId } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`studio:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many generation requests. Retry after ${rl.retryAfterSec}s.`);
  }

  // Resolve the writing model (same rules as chat: no silent switching).
  const effectiveModelId = modelId ?? settings.defaultModelId;
  const model = effectiveModelId
    ? await getModelInfoByModelId(effectiveModelId)
    : (await listEnabledModels())[0] ?? null;
  if (!model) {
    return fail(400, 'unknown_model', `Model "${effectiveModelId ?? '(default)'}" is not available. Pick one in Settings → Models.`);
  }
  if (!model.enabled) {
    return fail(409, 'model_disabled', `"${model.displayName}" is disabled. Enable it in Settings → Models first.`);
  }

  const row = await db.artifact.create({
    data: {
      kind: 'document',
      title: title.trim(),
      description: '',
      prompt,
      modelId: model.modelId,
      status: 'processing',
      meta: { format },
    },
  });

  try {
    const wantsHtml = format === 'html' || format === 'pdf';
    const completion = await completeChat({
      modelId: model.modelId,
      provider: model.provider,
      messages: [
        { role: 'system', content: DOC_SYSTEM },
        {
          role: 'user',
          content: wantsHtml
            ? `Write a standalone HTML document titled "${title}".\n\nBrief:\n${prompt}`
            : `Write a markdown document titled "${title}".\n\nBrief:\n${prompt}`,
        },
      ],
      temperature: 0.6,
    });

    if (!completion.content.trim()) {
      throw new Error('The writing model returned an empty document.');
    }

    let buffer: Buffer;
    if (format === 'md') {
      buffer = Buffer.from(stripFences(completion.content), 'utf8');
    } else if (format === 'html') {
      buffer = Buffer.from(stripFences(completion.content), 'utf8');
    } else if (format === 'docx') {
      buffer = await markdownToDocx(stripFences(completion.content), title.trim());
    } else {
      // pdf: model writes HTML, chromium prints it
      buffer = await htmlToPdf(stripFences(completion.content));
    }

    const { storagePath, size: bytes } = await writeArtifactFile(row.id, buffer);
    const updated = await db.artifact.update({
      where: { id: row.id },
      data: { status: 'ready', storagePath, mime: mimeFor(format), size: bytes },
    });
    return Response.json({ artifact: serializeArtifact(updated) });
  } catch (e) {
    const message = (e as Error).message.slice(0, 300);
    await db.artifact
      .update({ where: { id: row.id }, data: { status: 'failed', error: message } })
      .catch(() => undefined);
    return fail(502, 'doc_failed', `Document generation failed: ${message}`);
  }
}
