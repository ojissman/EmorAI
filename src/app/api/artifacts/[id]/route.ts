import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { refreshAsyncArtifact, serializeArtifact } from '@/lib/artifacts';
import { removeArtifactFile } from '@/lib/ai/media';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  let artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist (it may have been deleted).');
  artifact = await refreshAsyncArtifact(artifact);
  return Response.json({ artifact: serializeArtifact(artifact, { includeFiles: true }) });
}

export async function DELETE(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist (it may have been deleted).');
  if (artifact.storagePath) await removeArtifactFile(artifact.storagePath);
  await db.artifact.delete({ where: { id } });
  return Response.json({ ok: true });
}

export async function PATCH(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  return Response.json({ artifact: serializeArtifact(artifact) });
}
