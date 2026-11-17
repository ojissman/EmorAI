import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { requireArtifactAccess } from '@/lib/artifact-access';
import { parseArtifactFiles } from '@/lib/artifacts';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; path: string[] }> };

const TEXT_MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

function mimeForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_MIME[ext] ?? 'application/octet-stream';
}

/** Serves a sibling file of a multi-file artifact (relative asset resolution). */
export async function GET(req: Request, { params }: Params) {
  // Route: /api/artifacts/[id]/preview/[...path] — the artifact id comes from
  // the [id] segment; [...path] is purely the sibling path. (The previous
  // implementation read the id out of [...path] — every request 400'd.)
  const { id: artifactId, path: segments } = await params;
  const subPath = segments?.join('/');
  if (!artifactId || !subPath) return fail(400, 'bad_path', 'Malformed artifact asset path.');

  // Admin session OR signed URL token propagated from the entry HTML
  // (rewriteEntryLinks appends ?ast=… to every sibling reference).
  const denied = await requireArtifactAccess(req, artifactId);
  if (denied) return denied;

  const artifact = await db.artifact.findUnique({ where: { id: artifactId } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  if (artifact.status !== 'ready') return fail(409, 'not_ready', `This artifact is still ${artifact.status}.`);

  const files = parseArtifactFiles(artifact.files);
  const normalized = decodeURIComponent(subPath).replace(/^\.?\//, '');
  const file =
    files.find((f) => f.path === normalized) ??
    files.find((f) => f.path.replace(/^\.\//, '') === normalized);
  if (!file) return fail(404, 'file_not_found', `The artifact does not contain "${normalized}".`);

  return new Response(file.content, {
    headers: {
      'Content-Type': mimeForPath(file.path),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
