import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { serializeArtifact, ARTIFACT_KINDS } from '@/lib/artifacts';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const kindsParam = url.searchParams.get('kinds') ?? '';
  const limitParam = Number(url.searchParams.get('limit') ?? '60');
  const rawKinds = kindsParam.split(',').map((k) => k.trim()).filter(Boolean);
  const kinds = rawKinds.filter((k): k is (typeof ARTIFACT_KINDS)[number] =>
    (ARTIFACT_KINDS as readonly string[]).includes(k)
  );
  const invalid = rawKinds.filter((k) => !(ARTIFACT_KINDS as readonly string[]).includes(k));
  if (invalid.length > 0) {
    return fail(400, 'invalid_kind', `Unknown artifact kind(s): ${invalid.join(', ')}.`);
  }
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 60;

  const artifacts = await db.artifact.findMany({
    where: kinds.length ? { kind: { in: kinds } } : undefined,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  return Response.json({ artifacts: artifacts.map((a) => serializeArtifact(a)) });
}

export async function DELETE() {
  return fail(405, 'method_not_allowed', 'Delete a specific artifact via /api/artifacts/[id].');
}
