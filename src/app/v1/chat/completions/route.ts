// Root-level mirror of POST /v1/chat/completions.
// Base URLs that work for OpenAI-compatible clients:
//   {origin}/api/v1  (canonical)   {origin}  (this mirror, client appends /v1/...)
import { POST as apiPost, OPTIONS as apiOptions } from '../../../api/v1/chat/completions/route';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  return apiPost(req);
}

export async function OPTIONS() {
  return apiOptions();
}
