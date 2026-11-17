import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { issueArtifactToken, ARTIFACT_TOKEN_QUERY } from '@/lib/artifact-access';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/artifacts/[id]/access?kind=file|preview|zip
 *
 * Administrator-authenticated issuer of short-lived signed URLs so artifact
 * bytes can render in browser-native elements (<img>/<video>/<iframe>/links)
 * where neither cookies nor custom headers are available (cross-site embeds
 * like the space-z.ai preview panel). Token: 5 minutes, one artifact id.
 */
export async function GET(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const kind = new URL(req.url).searchParams.get('kind') ?? 'file';
  if (!['file', 'preview', 'zip'].includes(kind)) {
    return fail(400, 'invalid_request', 'kind must be one of: file, preview, zip.');
  }

  const artifact = await db.artifact.findUnique({ where: { id }, select: { id: true, status: true } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');

  const { token, expiresAt } = issueArtifactToken(id);
  const base =
    kind === 'file' ? `/api/artifacts/${id}/file` : kind === 'zip' ? `/api/artifacts/${id}/zip` : `/api/artifacts/${id}/preview`;
  return ok({
    url: `${base}?${ARTIFACT_TOKEN_QUERY}=${encodeURIComponent(token)}`,
    kind,
    artifactId: id,
    expiresAt: expiresAt.toISOString(),
  });
}
