import { z } from 'zod';
import { db } from '@/lib/db';
import { generateApiKey } from '@/lib/api-keys';
import { ok, fail } from '@/lib/api/response';
import { serializeApiKey } from '@/lib/serialize';

export const runtime = 'nodejs';

export async function GET() {
  const keys = await db.apiKey.findMany({ orderBy: { createdAt: 'desc' } });
  return ok({ keys: keys.map(serializeApiKey) });
}

const createSchema = z.object({
  name: z.string().min(1).max(60).trim(),
});

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return fail(400, 'invalid_request', 'Key name is required (max 60 chars).');

  const count = await db.apiKey.count({ where: { revokedAt: null } });
  if (count >= 50) {
    return fail(409, 'too_many_keys', 'Key limit reached (50 active keys). Revoke or delete unused keys first.');
  }

  const generated = generateApiKey();
  const row = await db.apiKey.create({
    data: {
      name: parsed.data.name,
      keyHash: generated.keyHash,
      prefix: generated.prefix,
    },
  });

  // Plaintext is returned exactly once, only at creation time.
  return ok({ key: serializeApiKey(row), plaintext: generated.plaintext }, { status: 201 });
}
