// ─── Ops alerts (admin) ───────────────────────────────────────────────────────
// Alerting-foundation surface (Phase 10, Priority 7): the latest 100 AlertEvents
// (provider health, budget, model sync — recorded by background jobs and the
// accounting path) plus acknowledgement. Delivery channels (email/webhook) are
// intentionally not fabricated: events are recorded and surfaced here; wiring a
// notifier is configuration. Admin session + CSRF guarded via requireAdmin
// (CSRF applies to the POST).

import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';

export const runtime = 'nodejs';

function serializeAlert(row: {
  id: string;
  level: string;
  category: string;
  message: string;
  meta: unknown;
  acknowledgedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    level: row.level,
    category: row.category,
    message: row.message,
    meta: row.meta ?? null,
    acknowledgedAt: row.acknowledgedAt ? row.acknowledgedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function GET(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const alerts = await db.alertEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  return ok({
    alerts: alerts.map(serializeAlert),
    note: 'Alerting is record-only: delivery channels (email/webhook) are configuration, not provided by this installation.',
  });
}

const ackSchema = z.object({ id: z.string().min(1).max(64) });

export async function POST(req: Request) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = ackSchema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Body must be { id: string } — the AlertEvent id to acknowledge.', { details: parsed.error.flatten() });
  }

  const existing = await db.alertEvent.findUnique({ where: { id: parsed.data.id } });
  if (!existing) {
    return fail(404, 'alert_not_found', 'No AlertEvent with that id.');
  }
  if (existing.acknowledgedAt) {
    // idempotent — already acknowledged; the current state is returned
    return ok({ alert: serializeAlert(existing), alreadyAcknowledged: true });
  }
  const updated = await db.alertEvent.update({
    where: { id: parsed.data.id },
    data: { acknowledgedAt: new Date() },
  });
  return ok({ alert: serializeAlert(updated), alreadyAcknowledged: false });
}
