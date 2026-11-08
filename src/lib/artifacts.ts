import type { Artifact } from '@prisma/client';
import { db } from '@/lib/db';
import type { ArtifactFile, SerializedArtifact } from '@/lib/types';

export const ARTIFACT_KINDS = ['website', 'webapp', 'blog', 'document', 'image', 'video', 'audio'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export function serializeArtifact(a: Artifact, opts?: { includeFiles?: boolean }): SerializedArtifact {
  const files = opts?.includeFiles ? (a.files as ArtifactFile[] | null) : undefined;
  return {
    id: a.id,
    kind: a.kind as ArtifactKind,
    title: a.title,
    description: a.description,
    prompt: a.prompt,
    modelId: a.modelId,
    status: a.status as SerializedArtifact['status'],
    mime: a.mime,
    size: a.size,
    error: a.error,
    meta: (a.meta as Record<string, unknown> | null) ?? null,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
    ...(files ? { files } : {}),
    ...(opts?.includeFiles && a.providerTaskId ? { providerTaskId: a.providerTaskId } : {}),
  };
}

export function parseArtifactFiles(raw: unknown): ArtifactFile[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (f): f is ArtifactFile =>
        f !== null && typeof f === 'object' && typeof (f as ArtifactFile).path === 'string' && typeof (f as ArtifactFile).content === 'string'
    )
    .slice(0, 24)
    .map((f) => ({ path: f.path.slice(0, 200), content: f.content.slice(0, 400_000), entry: Boolean(f.entry) }));
}

/** Polls the provider for async artifacts (video) and refreshes the row. */
export async function refreshAsyncArtifact(a: Artifact): Promise<Artifact> {
  if (a.status !== 'processing' || a.kind !== 'video' || !a.providerTaskId) return a;
  const { queryVideoJob, downloadRemoteFile, writeArtifactFile } = await import('@/lib/ai/media');
  try {
    const job = await queryVideoJob(a.providerTaskId);
    if (job.status === 'success' && job.videoUrl) {
      const { buffer, mime } = await downloadRemoteFile(job.videoUrl);
      const { storagePath, size } = await writeArtifactFile(a.id, buffer);
      return await db.artifact.update({
        where: { id: a.id },
        data: { status: 'ready', storagePath, mime, size, error: null },
      });
    }
    if (job.status === 'failed') {
      return await db.artifact.update({
        where: { id: a.id },
        data: { status: 'failed', error: 'The video service reported the task failed.' },
      });
    }
    return a;
  } catch (e) {
    // Polling hiccup — keep processing state, record last error for diagnostics.
    return await db.artifact
      .update({ where: { id: a.id }, data: { error: (e as Error).message.slice(0, 300) } })
      .catch(() => a);
  }
}
