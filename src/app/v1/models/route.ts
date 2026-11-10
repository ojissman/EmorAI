// Root-level mirror of GET /v1/models.
// Some OpenAI-compatible clients are configured with just the host origin and
// append /v1/... themselves. EmorAI accepts both /api/v1/* and /v1/*.
import { GET as apiGet, OPTIONS as apiOptions } from '../../api/v1/models/route';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  return apiGet(req);
}

export async function OPTIONS() {
  return apiOptions();
}
