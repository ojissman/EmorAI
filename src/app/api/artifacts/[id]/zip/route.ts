import JSZip from 'jszip';
import { db } from '@/lib/db';
import { fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { parseArtifactFiles } from '@/lib/artifacts';
import { readArtifactFile } from '@/lib/ai/media';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

function safeBase(title: string): string {
  return title.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'artifact';
}

/** Zips a multi-file artifact (website/blog) or the single stored file. */
export async function GET(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;
  const artifact = await db.artifact.findUnique({ where: { id } });
  if (!artifact) return fail(404, 'artifact_not_found', 'That artifact does not exist.');
  if (artifact.status !== 'ready') return fail(409, 'not_ready', `This artifact is still ${artifact.status}.`);

  const zip = new JSZip();
  const files = parseArtifactFiles(artifact.files);
  let added = 0;

  if (files.length > 0) {
    for (const f of files) {
      zip.file(f.path.replace(/^\.\//, ''), f.content);
      added++;
    }
  } else if (artifact.storagePath) {
    const buffer = await readArtifactFile(artifact.storagePath);
    if (!buffer) return fail(410, 'file_missing', 'The stored file for this artifact is missing on disk.');
    const ext = (artifact.mime?.split('/').pop() ?? 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
    zip.file(`${safeBase(artifact.title)}.${ext}`, buffer);
    added++;
  }

  if (added === 0) return fail(404, 'nothing_to_zip', 'This artifact has no content to download.');

  zip.file(
    'README.md',
    [
      `# ${artifact.title}`,
      '',
      artifact.description || 'Generated with EmorAI.',
      '',
      `- Kind: ${artifact.kind}`,
      artifact.prompt ? `- Brief: ${artifact.prompt.slice(0, 500)}` : '',
      `- Generated: ${artifact.createdAt.toISOString()}`,
      '',
      'Open the entry HTML file in a browser for single-page sites, or serve this',
      'folder statically for multi-page projects.',
    ]
      .filter(Boolean)
      .join('\n')
  );

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Length': String(buffer.byteLength),
      'Content-Disposition': `attachment; filename="${safeBase(artifact.title)}.zip"`,
    },
  });
}
