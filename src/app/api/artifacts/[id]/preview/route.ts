import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { requireArtifactAccess, ARTIFACT_TOKEN_QUERY } from '@/lib/artifact-access';
import { parseArtifactFiles } from '@/lib/artifacts';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const SUBPATH_BASE = (artifactId: string) => `/api/artifacts/${artifactId}/preview/`;

/**
 * Rewrites relative href/src references in an artifact's entry HTML to the
 * signed subpath URLs. Serves two purposes:
 *   1. relative links resolve correctly against the preview subpath route
 *      (a plain `style.css` against `/api/artifacts/{id}/preview` would
 *      otherwise resolve OUTSIDE the preview tree and 404);
 *   2. the short-lived signed access token propagates to every sibling
 *      request, so multi-file artifacts render inside cross-site embeds
 *      (space-z.ai preview panel) where cookies never arrive.
 */
export function rewriteEntryLinks(html: string, artifactId: string, token: string | null): string {
  const withToken = (path: string) =>
    token
      ? `${SUBPATH_BASE(artifactId)}${path}?${ARTIFACT_TOKEN_QUERY}=${encodeURIComponent(token)}`
      : `${SUBPATH_BASE(artifactId)}${path}`;
  return html.replace(
    /(\s(?:href|src)\s*=\s*)(["'])([^"']*)\2/gi,
    (match, prefix: string, quote: string, value: string) => {
      if (!value) return match;
      // Leave absolute, schemed, protocol-relative, fragment and API URLs alone.
      if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/api\/|\/)/i.test(value)) return match;
      const path = value.replace(/^\.\//, '').split(/[?#]/)[0];
      if (!path || path.startsWith('../')) return match;
      return `${prefix}${quote}${withToken(path.split('/').map(encodeURIComponent).join('/'))}${quote}`;
    }
  );
}

/** Serves the entry HTML of a multi-file artifact inline so it can be previewed
 *  inside a sandboxed iframe. Sibling files resolve relative links through
 *  /api/artifacts/[id]/preview/[...path].
 */
export async function GET(req: Request, { params }: Params) {
  const { id } = await params;
  // Admin session OR short-lived signed URL (browser-native iframe loads
  // cannot send headers/cookies through cross-site embeds).
  const denied = await requireArtifactAccess(req, id);
  if (denied) return denied;

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

  const token = new URL(req.url).searchParams.get(ARTIFACT_TOKEN_QUERY);
  const html = rewriteEntryLinks(entry.content, id, token);

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
