import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';

export const UPLOAD_DIR = path.join(process.cwd(), 'db', 'uploads');

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB

const IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

const TEXT_LIKE_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rb', '.go', '.rs', '.java',
  '.c', '.h', '.cpp', '.cs', '.php', '.sh', '.sql', '.html', '.xml', '.css',
  '.toml', '.ini', '.env',
]);

export function classifyUpload(name: string, mime: string): 'image' | 'document' | 'unsupported' {
  const lowerName = name.toLowerCase();
  if (IMAGE_MIMES.has(mime) || /\.(png|jpe?g|webp|gif|bmp)$/.test(lowerName)) return 'image';
  if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) return 'document';
  const ext = path.extname(lowerName);
  if (TEXT_LIKE_EXTENSIONS.has(ext) || mime.startsWith('text/')) return 'document';
  return 'unsupported';
}

/**
 * Extracts text from a document buffer so it can be injected into model context.
 * PDFs are parsed server-side; text-like files are read as UTF-8.
 */
export async function extractDocumentText(
  name: string,
  mime: string,
  buffer: Buffer
): Promise<string | null> {
  const lowerName = name.toLowerCase();
  try {
    if (mime === 'application/pdf' || lowerName.endsWith('.pdf')) {
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      try {
        const result = await parser.getText();
        const text = (result?.total ?? '').toString();
        return text.trim().length > 0 ? text.slice(0, 120_000) : null;
      } finally {
        await parser.destroy();
      }
    }
    const ext = path.extname(lowerName);
    if (TEXT_LIKE_EXTENSIONS.has(ext) || mime.startsWith('text/')) {
      const text = buffer.toString('utf8');
      return text.trim().length > 0 ? text.slice(0, 120_000) : null;
    }
    return null;
  } catch (e) {
    console.error(`Text extraction failed for ${name}:`, e);
    return null;
  }
}

export type StoredFile = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'document';
  extractedText: string | null;
};

/** Persists an upload to disk + metadata row. Throws on invalid input. */
export async function storeUpload(file: {
  name: string;
  mime: string;
  buffer: Buffer;
}): Promise<StoredFile> {
  const kind = classifyUpload(file.name, file.mime);
  if (kind === 'unsupported') {
    throw new Error(`Unsupported file type: ${file.name}`);
  }
  if (file.buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds the 10 MB upload limit');
  }
  await mkdir(UPLOAD_DIR, { recursive: true });
  const meta = await db.fileMetadata.create({
    data: {
      name: file.name.slice(0, 255),
      mime: file.mime || 'application/octet-stream',
      size: file.buffer.byteLength,
      kind,
      storagePath: 'pending',
    },
  });
  const storagePath = path.join(UPLOAD_DIR, meta.id);
  await writeFile(storagePath, file.buffer);
  const extractedText = kind === 'document' ? await extractDocumentText(file.name, file.mime, file.buffer) : null;
  await db.fileMetadata.update({ where: { id: meta.id }, data: { storagePath, extractedText } });
  return {
    id: meta.id,
    name: meta.name,
    mime: meta.mime,
    size: meta.size,
    kind,
    extractedText,
  };
}

export async function readStoredFile(fileId: string): Promise<{ meta: { mime: string; name: string; kind: string }; buffer: Buffer } | null> {
  const meta = await db.fileMetadata.findUnique({ where: { id: fileId } });
  if (!meta) return null;
  try {
    const buffer = await readFile(meta.storagePath);
    return { meta: { mime: meta.mime, name: meta.name, kind: meta.kind }, buffer };
  } catch {
    return null;
  }
}

export async function deleteStoredFile(fileId: string): Promise<void> {
  const meta = await db.fileMetadata.findUnique({ where: { id: fileId } });
  if (!meta) return;
  try {
    await unlink(meta.storagePath);
  } catch {
    // ignore missing files
  }
  await db.fileMetadata.delete({ where: { id: fileId } });
}

/** Builds a data URI for image attachments (vision models). */
export async function imageDataUri(fileId: string): Promise<string | null> {
  const stored = await readStoredFile(fileId);
  if (!stored || stored.meta.kind !== 'image') return null;
  return `data:${stored.meta.mime};base64,${stored.buffer.toString('base64')}`;
}
