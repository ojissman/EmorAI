// Root-level mirror of POST /v1/messages (Anthropic Messages API).
// Claude Code / Anthropic SDK clients configure ANTHROPIC_BASE_URL and the
// SDK appends /v1/messages — this mirror makes {origin} work directly,
// while {origin}/api also works via the canonical mount.
import { POST as apiPost, OPTIONS as apiOptions } from '../../api/v1/messages/route';

export const runtime = 'nodejs';
export const maxDuration = 300;

export async function POST(req: Request) {
  return apiPost(req);
}

export async function OPTIONS() {
  return apiOptions();
}
