import { z } from 'zod';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { getAdapterByType, adapterContextForAccount } from '@/lib/ai/providers';
import { createModelConfig, listModels } from '@/lib/model-registry';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const adoptSchema = z.object({
  // discovered upstream models to publish as provider-category catalogue rows
  adopt: z
    .array(
      z.object({
        modelId: z.string().min(1).max(160),
        displayName: z.string().min(1).max(80).optional(),
        freeTier: z.boolean().default(false),
        capabilities: z
          .object({
            chat: z.boolean().default(true),
            reasoning: z.boolean().default(false),
            vision: z.boolean().default(false),
            files: z.boolean().default(false),
            webSearch: z.boolean().default(false),
            tools: z.boolean().default(false),
            json: z.boolean().default(false),
          })
          .default({ chat: true, reasoning: false, vision: false, files: false, webSearch: false, tools: false, json: false }),
        contextWindow: z.number().int().min(1024).max(2_000_000).nullish(),
      })
    )
    .max(100)
    .default([]),
});

/**
 * Discovers upstream models through the provider's listing API. Discovered
 * models are NOT published automatically — the admin explicitly adopts
 * selected ones (publication is the `adopt` list), per provider terms.
 *
 * Adoption is two-phase so every adopted model is EXECUTABLE immediately on
 * an authorized account:
 *   1. a provider-category ModelConfig is created with enabled:false —
 *      adoption is NOT publication (the admin flips it on in the catalogue;
 *      customers cannot resolve disabled models until then);
 *   2. a ModelRoute is auto-created on THIS account (idempotent — skipped
 *      when an identical route already exists) so the router can serve the
 *      model the moment it is published.
 */
export async function POST(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;
  const { id } = await params;
  const account = await db.providerAccount.findUnique({ where: { id } });
  if (!account) return fail(404, 'not_found', 'Provider account not found.');
  const adapter = getAdapterByType(account.providerType);
  if (!adapter) return fail(400, 'unknown_provider', `No adapter for "${account.providerType}".`);
  if (!adapter.supports('discovery')) {
    // Honest: this provider exposes no listing API (e.g. the Z.ai web-dev SDK).
    // Availability probing (Settings → Models → Discover) is the supported path.
    return fail(
      501,
      'discovery_unsupported',
      `Provider "${account.providerType}" does not expose a model-listing API on this installation. Use the availability probe in Settings → Models instead.`
    );
  }

  let body: unknown;
  let adopt: z.infer<typeof adoptSchema>['adopt'] = [];
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  const parsed = adoptSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid discovery request.', { details: parsed.error.flatten() });
  }
  adopt = parsed.data.adopt;

  let ctx;
  try {
    ctx = adapterContextForAccount(account);
  } catch (e) {
    await db.providerAccount.update({
      where: { id },
      data: { lastCheckedAt: new Date(), lastStatus: 'error', lastError: String((e as Error).message ?? e).slice(0, 300) },
    });
    return fail(500, 'credential_unreadable', String((e as Error).message ?? e).slice(0, 300));
  }

  try {
    const upstream = await adapter.listModels(ctx);
    await db.providerAccount.update({
      where: { id },
      data: { lastCheckedAt: new Date(), lastStatus: 'ok', lastError: null },
    });

    const existing = await listModels();
    const adopted: string[] = [];
    // execution routes created (or found already existing) for adopted models
    const routes: Array<{
      modelId: string;
      routeId: string;
      providerAccountId: string;
      upstreamModelId: string;
      created: boolean;
      enabled: boolean;
    }> = [];
    for (const pick of adopt) {
      const found = upstream.find((m) => m.modelId === pick.modelId);
      if (!found) {
        return fail(400, 'not_discovered', `Model "${pick.modelId}" was not in this account's discovery result.`);
      }
      // 1. catalogue row — created DISABLED (adoption ≠ publication); an
      //    already-catalogued model is left untouched
      if (!existing.some((m) => m.modelId === pick.modelId)) {
        const maxOrder = existing.reduce((max, m) => Math.max(max, m.sortOrder), 0);
        await createModelConfig({
          modelId: pick.modelId,
          displayName: pick.displayName ?? pick.modelId,
          description: `Discovered from ${account.name} (${account.providerType}). Capabilities are admin-verified — never inferred from the model name.`,
          provider: account.providerType === 'self-hosted' ? 'self-hosted' : account.providerType,
          category: 'provider',
          lifecycle: 'active',
          freeTier: pick.freeTier,
          enabled: false,
          capabilities: pick.capabilities,
          contextWindow: pick.contextWindow ?? found.contextWindow ?? null,
          sortOrder: maxOrder + 1,
        });
        adopted.push(pick.modelId);
      }
      // 2. execution route on THIS authorized account — idempotent (an
      //    identical model+account+upstream route is never duplicated).
      //    Capabilities carry exactly the subset the admin declared.
      const duplicateRoute = await db.modelRoute.findFirst({
        where: { publicModelId: pick.modelId, providerAccountId: account.id, upstreamModelId: pick.modelId },
      });
      if (duplicateRoute) {
        routes.push({
          modelId: pick.modelId,
          routeId: duplicateRoute.id,
          providerAccountId: account.id,
          upstreamModelId: duplicateRoute.upstreamModelId,
          created: false,
          enabled: duplicateRoute.enabled,
        });
      } else {
        const route = await db.modelRoute.create({
          data: {
            publicModelId: pick.modelId,
            providerAccountId: account.id,
            upstreamModelId: pick.modelId,
            capabilities: pick.capabilities,
            priority: 0,
            enabled: true,
          },
        });
        routes.push({
          modelId: pick.modelId,
          routeId: route.id,
          providerAccountId: account.id,
          upstreamModelId: route.upstreamModelId,
          created: true,
          enabled: route.enabled,
        });
      }
    }

    return ok({
      discovered: upstream.map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName ?? null,
        contextWindow: m.contextWindow ?? null,
        ownedBy: m.ownedBy ?? null,
        alreadyCatalogued: existing.some((e) => e.modelId === m.modelId),
      })),
      adopted,
      routes,
      note:
        adopt.length === 0
          ? 'Dry-run discovery: nothing was published. Pass an `adopt` list to catalogue selected models.'
          : 'Adopted models are created DISABLED — enable them in Settings → Models to publish. Their execution routes are live immediately (listed in `routes`).',
    });
  } catch (e) {
    await db.providerAccount.update({
      where: { id },
      data: { lastCheckedAt: new Date(), lastStatus: 'error', lastError: String((e as Error).message ?? e).slice(0, 300) },
    });
    return fail(502, 'discovery_failed', String((e as Error).message ?? e).slice(0, 400));
  }
}
