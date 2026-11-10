// Root-level mirror of POST /v1/messages/count_tokens.
import { POST as apiPost, OPTIONS as apiOptions } from '../../../api/v1/messages/count_tokens/route';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  return apiPost(req);
}

export async function OPTIONS() {
  return apiOptions();
}
