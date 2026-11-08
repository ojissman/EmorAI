import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { parseArtifactFiles } from '@/lib/artifacts';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const TEXT_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
};

function mimeForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Serves the entry HTML of a multi-file artifact inline so it can be previewed
 * inside a sandboxed iframe. Sibling files resolve relative links through
 * /api/artifacts/[id]/preview/[...path].
 */
export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  if (artifact.status !== 'ready') {
    return fail(409, 'not_ready', `This artifact is still ${artifact.status}.`);
  }
  const files = parseArtifactFiles(artifact.files);
  if (files.length === 0) return fail(404, 'no_files', 'This artifact has no previewable files.');

  const entry =
    files.find((f) => f.entry && f.path.toLowerCase().endsWith('.html')) ??
    files.find((f) => f.path.toLowerCase().endsWith('.html')) ??
    files[0];

  return new Response(entry.content, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
