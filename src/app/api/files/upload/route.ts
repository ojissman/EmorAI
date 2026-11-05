import { storeUpload, MAX_UPLOAD_BYTES } from '@/lib/files';
import { ok, fail } from '@/lib/api/response';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** Upload images (vision) or documents (text/PDF analysis). Returns file metadata. */
export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, 'bad_request', 'Expected multipart/form-data with a "file" field.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) {
    return fail(400, 'bad_request', 'Missing "file" field.');
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail(413, 'too_large', 'Files are limited to 10 MB.');
  }
  const buffer = Buffer.from(await file.arrayBuffer());
  try {
    const stored = await storeUpload({
      name: file.name || 'upload',
      mime: file.type || 'application/octet-stream',
      buffer,
    });
    return ok({ file: { id: stored.id, name: stored.name, mime: stored.mime, size: stored.size, kind: stored.kind } }, { status: 201 });
  } catch (e) {
    const message = String((e as Error)?.message ?? e);
    if (message.startsWith('Unsupported file type')) {
      return fail(415, 'unsupported_type', message);
    }
    console.error('upload failed:', e);
    return fail(500, 'upload_failed', 'The upload could not be stored.');
  }
}
