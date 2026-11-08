import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { refreshAsyncArtifact, serializeArtifact } from '@/lib/artifacts';
import { removeArtifactFile } from '@/lib/ai/media';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  let artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist (it may have been deleted).');
  artifact = await refreshAsyncArtifact(artifact);
  return Response.json({ artifact: serializeArtifact(artifact, { includeFiles: true }) });
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist (it may have been deleted).');
  if (artifact.storagePath) await removeArtifactFile(artifact.storagePath);
  await db.artifact.delete({ where: { id } });
  return Response.json({ ok: true });
}

export async function PATCH(_req: Request, { params }: Params) {
  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  return Response.json({ artifact: serializeArtifact(artifact) });
}
