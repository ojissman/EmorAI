// Root-level mirror of GET /v1/models/{id}.
import { GET as apiGet, OPTIONS as apiOptions } from '../../../api/v1/models/[id]/route';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return apiGet(req, ctx);
}

export async function OPTIONS() {
  return apiOptions();
}
