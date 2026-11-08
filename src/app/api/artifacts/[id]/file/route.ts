import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { refreshAsyncArtifact } from '@/lib/artifacts';
import { readArtifactFile } from '@/lib/ai/media';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'text/markdown': 'md',
  'text/html': 'html',
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

function safeName(title: string, mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const base = title.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'artifact';
  return `${base}.${ext}`;
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  let artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  artifact = await refreshAsyncArtifact(artifact);
  if (artifact.status !== 'ready') {
    return fail(409, 'not_ready', `This artifact is still ${artifact.status}. Try again shortly.`);
  }
  if (!artifact.storagePath) return fail(404, 'no_file', 'This artifact has no downloadable file.');

  const buffer = await readArtifactFile(artifact.storagePath);
  if (!buffer) return fail(410, 'file_missing', 'The stored file for this artifact is missing on disk.');

  const filename = safeName(artifact.title, artifact.mime ?? 'application/octet-stream');
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': artifact.mime ?? 'application/octet-stream',
      'Content-Length': String(buffer.byteLength),
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
}
