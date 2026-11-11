// ─── Capability verification (real upstream probes) ───────────────────────────
// POST /api/models/[id]/verify-capabilities
// Body: { checks?: Array<'chat'|'streaming'|'vision'|'tools'|'json'|'reasoning'> }
// (default: chat + streaming). Admin-only — every check is a REAL, tiny upstream
// request executed THROUGH the intelligent router using the model's configured
// routes (or the legacy direct path for un-routed provider models).
//
// Probe design (minimal tokens, honest signals):
//   • chat      — 1-line non-streaming completion (completeChatRouted)
//   • streaming — tiny streamed completion (streamChatRouted), maxTokens 8
//   • vision    — 1×1 PNG image part through streamChatRouted with
//                 needs={vision:true} (the zai adapter's streaming path routes
//                 image parts to createVision); success = content delta arrives
//   • tools     — one trivial get_time tool with needs={tools:true}; success =
//                 request completes without a provider error (the tool does NOT
//                 have to be invoked — completion is the signal)
//   • json      — instructed to reply with a fixed JSON object; success = the
//                 completion parses as JSON. NOTE: the adapter wire contract
//                 (StreamChatOptions → buildBody) carries no response_format
//                 field, so the check is prompt-instructed parse verification —
//                 recorded honestly in the details, never claimed as an
//                 upstream response_format acceptance test.
//   • reasoning — NOT probe-verifiable (a reasoning trace depends on prompt and
//                 model; a reasoning-shaped answer is not evidence of the
//                 capability). Recorded as 'declared' — never invented.
//
// Honest recording rules (ModelConfig):
//   • capsVerifiedAt  = now
//   • capsVerification = { <check>: 'verified'|'failed'|'declared', probedAt,
//                          details: { per-check error/served-model evidence } }
//     — merged with any previous verification evidence (un-probed keys keep
//     their prior status; the evidence trail is never destroyed)
//   • a check that SUCCEEDED sets that capability true (verified).
//   • a check that FAILED records 'failed' + error text, but the public
//     boolean is flipped to false ONLY when the capability is currently
//     advertised AND no eligible route carries it (then the advertisement is
//     unservable) — and that flip raises an AlertEvent (category 'capability').
//     Provider-category (glm-*) models are never auto-flipped here; streaming
//     failures never auto-flip streamSupported (transient failures must not
//     disable a model). Successes are never invented.
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { ok, fail } from '@/lib/api/response';
import { requireAdmin } from '@/lib/api/admin-auth';
import { streamChatRouted, completeChatRouted, type RouteAttribution } from '@/lib/ai/router';
import { ProviderError } from '@/lib/ai/zai-adapter';
import {
  DEFAULT_CAPABILITIES,
  type ModelCapabilities,
  type ProviderContentPart,
  type ProviderMessage,
  type ProviderTool,
} from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

const CHECK_NAMES = ['chat', 'streaming', 'vision', 'tools', 'json', 'reasoning'] as const;
type CheckName = (typeof CHECK_NAMES)[number];
const DEFAULT_CHECKS: CheckName[] = ['chat', 'streaming'];

const bodySchema = z.object({
  checks: z.array(z.enum(CHECK_NAMES)).optional(),
});

// 1×1 RGB PNG (69 bytes) — structure and pixel round-trip verified; embedded as
// a data URL image part so the probe is a REAL vision request.
const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPo8NECAAJeAP9e93caAAAAAElFTkSuQmCC';

// One trivial tool — success is a completion without a provider error; the
// model does not have to invoke it.
const PROBE_TOOL: ProviderTool = {
  type: 'function',
  function: {
    name: 'get_time',
    description: 'Returns the current local time. Call this when the user asks for the time.',
    parameters: { type: 'object', properties: {} },
  },
};

const PROBE_TIMEOUT_MS = 60_000;

type CheckStatus = 'verified' | 'failed' | 'declared';

type CheckResult = {
  status: CheckStatus;
  // what the upstream reported actually serving (transparency evidence)
  servedModel: string | null;
  // upstream model configured on the route that executed the probe
  routeUpstream: string | null;
  routeId: string | null;
  routed: boolean | null;
  error: string | null;
  finishReason: string | null;
  detail: string | null;
  contentPreview: string | null;
  toolCalls: number | null;
  jsonParsed: boolean | null;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readCaps(raw: unknown): ModelCapabilities {
  return { ...DEFAULT_CAPABILITIES, ...(isPlainObject(raw) ? raw : {}) };
}

const rid = (check: string): string =>
  `caps-verify-${check}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function failedResult(errorText: string, attribution: RouteAttribution): CheckResult {
  return {
    status: 'failed',
    servedModel: null,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: errorText.slice(0, 300),
    finishReason: null,
    detail: null,
    contentPreview: null,
    toolCalls: null,
    jsonParsed: null,
  };
}

/** Runs one probe; a thrown error becomes an honest 'failed' with attribution. */
async function runProbe(
  attribution: RouteAttribution,
  fn: () => Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await fn();
  } catch (e) {
    const text = e instanceof ProviderError ? `${e.code}: ${e.message}` : String((e as Error)?.message ?? e);
    return failedResult(text, attribution);
  }
}

// ─── Individual probes (all through the router) ──────────────────────────────

async function probeChat(modelId: string, attribution: RouteAttribution): Promise<CheckResult> {
  const res = await completeChatRouted(modelId, {
    messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
    maxTokens: 16,
    timeoutMs: PROBE_TIMEOUT_MS,
    requestId: rid('chat'),
    attribution,
  });
  const nonEmpty = res.content.trim().length > 0;
  return {
    status: nonEmpty ? 'verified' : 'failed',
    servedModel: res.servedModel ?? null,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: nonEmpty ? null : 'completion returned empty content',
    finishReason: res.finishReason ?? null,
    detail: '1-line non-streaming completion through the router',
    contentPreview: res.content.slice(0, 80) || null,
    toolCalls: null,
    jsonParsed: null,
  };
}

async function probeStreaming(modelId: string, attribution: RouteAttribution): Promise<CheckResult> {
  let gotDelta = false;
  let servedModel: string | null = null;
  let finishReason: string | null = null;
  let preview = '';
  for await (const ev of streamChatRouted(
    modelId,
    {
      messages: [{ role: 'user', content: 'Reply with: OK' }],
      maxTokens: 8,
      timeoutMs: PROBE_TIMEOUT_MS,
      requestId: rid('streaming'),
      attribution,
    }
  )) {
    if (ev.type === 'served-model') servedModel = ev.model;
    else if (ev.type === 'delta') {
      gotDelta = true;
      preview += ev.content;
    } else if (ev.type === 'finish') finishReason = ev.reason;
  }
  return {
    status: gotDelta ? 'verified' : 'failed',
    servedModel,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: gotDelta ? null : 'stream completed without any content delta',
    finishReason,
    detail: 'tiny streamed request (maxTokens 8) through the router',
    contentPreview: preview.slice(0, 80) || null,
    toolCalls: null,
    jsonParsed: null,
  };
}

async function probeVision(modelId: string, attribution: RouteAttribution): Promise<CheckResult> {
  const parts: ProviderContentPart[] = [
    { type: 'text', text: 'Describe this image in one short word.' },
    { type: 'image_url', image_url: { url: TINY_PNG_DATA_URL } },
  ];
  const messages: ProviderMessage[] = [{ role: 'user', content: parts }];
  let gotDelta = false;
  let servedModel: string | null = null;
  let finishReason: string | null = null;
  let preview = '';
  for await (const ev of streamChatRouted(
    modelId,
    {
      messages,
      maxTokens: 16,
      timeoutMs: PROBE_TIMEOUT_MS,
      requestId: rid('vision'),
      attribution,
    },
    { vision: true, tools: false }
  )) {
    if (ev.type === 'served-model') servedModel = ev.model;
    else if (ev.type === 'delta') {
      gotDelta = true;
      preview += ev.content;
    } else if (ev.type === 'finish') finishReason = ev.reason;
  }
  return {
    status: gotDelta ? 'verified' : 'failed',
    servedModel,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: gotDelta ? null : 'vision request completed without any content delta',
    finishReason,
    detail: 'real 1×1 PNG image part, needs={vision:true}, through the router',
    contentPreview: preview.slice(0, 80) || null,
    toolCalls: null,
    jsonParsed: null,
  };
}

async function probeTools(modelId: string, attribution: RouteAttribution): Promise<CheckResult> {
  const res = await completeChatRouted(
    modelId,
    {
      messages: [{ role: 'user', content: 'What time is it right now? Use the get_time tool.' }],
      tools: [PROBE_TOOL],
      maxTokens: 16,
      timeoutMs: PROBE_TIMEOUT_MS,
      requestId: rid('tools'),
      attribution,
    },
    { vision: false, tools: true }
  );
  // Success = the request completed without a provider error. Whether the
  // model actually invoked the tool is NOT part of the signal.
  return {
    status: 'verified',
    servedModel: res.servedModel ?? null,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: null,
    finishReason: res.finishReason ?? null,
    detail: 'one trivial tool (get_time); completion without provider error is the signal — invocation not required',
    contentPreview: res.content.slice(0, 80) || null,
    toolCalls: res.toolCalls.length,
    jsonParsed: null,
  };
}

function tryParseJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    // accept a fenced JSON block (```json ... ```) — it still parses
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (m) {
      try {
        JSON.parse(m[1].trim());
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

async function probeJson(modelId: string, attribution: RouteAttribution): Promise<CheckResult> {
  const res = await completeChatRouted(modelId, {
    messages: [{ role: 'user', content: 'Reply with ONLY this JSON object and nothing else: {"ok":true}' }],
    maxTokens: 16,
    timeoutMs: PROBE_TIMEOUT_MS,
    requestId: rid('json'),
    attribution,
  });
  const parsed = tryParseJson(res.content);
  return {
    status: parsed ? 'verified' : 'failed',
    servedModel: res.servedModel ?? null,
    routeUpstream: attribution.upstreamModel ?? null,
    routeId: attribution.routeId ?? null,
    routed: attribution.routed ?? null,
    error: parsed ? null : 'completion did not parse as JSON',
    finishReason: res.finishReason ?? null,
    detail:
      'prompt-instructed JSON reply + parse check (the adapter wire contract carries no response_format field — upstream acceptance of response_format is NOT being claimed)',
    contentPreview: res.content.slice(0, 120) || null,
    toolCalls: null,
    jsonParsed: parsed,
  };
}

// ─── Route-carrier check (the conservative flip rule) ────────────────────────

/** How many enabled routes (enabled accounts) of this model carry `cap`? */
async function countRouteCarriers(modelId: string, modelCaps: ModelCapabilities, cap: keyof ModelCapabilities): Promise<number> {
  const routes = await db.modelRoute.findMany({
    where: { publicModelId: modelId, enabled: true },
    include: { providerAccount: { select: { enabled: true } } },
  });
  return routes.filter((r) => {
    if (!r.providerAccount.enabled) return false;
    // null route capabilities inherit the public model's declared set
    if (!isPlainObject(r.capabilities)) return Boolean(modelCaps[cap]);
    const merged = readCaps(r.capabilities);
    return Boolean(merged[cap]);
  }).length;
}

async function createCapabilityAlert(modelId: string, capability: string, errorText: string | null, probedAt: Date): Promise<void> {
  try {
    await db.alertEvent.create({
      data: {
        level: 'warning',
        category: 'capability',
        message: `Model "${modelId}" advertised capability "${capability}" but no eligible route can serve it — real probe failed; capability set to false.`,
        meta: { modelId, capability, probeError: errorText, probedAt: probedAt.toISOString() } as Prisma.InputJsonValue,
      },
    });
  } catch {
    // alerting must never break verification
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: Request, { params }: Params) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const { id } = await params;

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    // empty body → default checks
  }
  const parsedBody = bodySchema.safeParse(raw ?? {});
  if (!parsedBody.success) {
    const issue = parsedBody.error.issues[0];
    return fail(400, 'invalid_request', `Invalid request body: ${issue?.message ?? 'checks must be an array of capability check names'}`);
  }
  const requested = parsedBody.data.checks ?? [];
  const checks: CheckName[] = requested.length > 0 ? [...new Set(requested)] : DEFAULT_CHECKS;

  // resolve by DB id first (probe-route convention), then by public modelId
  const row =
    (await db.modelConfig.findUnique({ where: { id } })) ??
    (await db.modelConfig.findUnique({ where: { modelId: id } }));
  if (!row) return fail(404, 'not_found', 'Model not found.');

  const caps = readCaps(row.capabilities);
  const capsBefore: ModelCapabilities = { ...caps };
  const probedAt = new Date();

  const results: Record<string, CheckResult> = {};
  const verificationUpdates: Record<string, CheckStatus> = {};
  const detailsUpdates: Record<string, Record<string, string | number | boolean | null>> = {};

  const capabilityUpdates: Array<{ capability: string; from: boolean; to: boolean; reason: string }> = [];
  const alerts: Array<{ level: string; category: string; message: string }> = [];

  for (const check of checks) {
    if (check === 'reasoning') {
      results[check] = {
        status: 'declared',
        servedModel: null,
        routeUpstream: null,
        routeId: null,
        routed: null,
        error: null,
        finishReason: null,
        detail: 'reasoning is not probe-verifiable with a deterministic signal — recorded as declared',
        contentPreview: null,
        toolCalls: null,
        jsonParsed: null,
      };
      verificationUpdates[check] = 'declared';
      detailsUpdates[check] = {
        note: 'declared — reasoning traces depend on prompt and model; no tiny probe can honestly verify this capability',
      };
      continue;
    }

    const attribution: RouteAttribution = {};
    const result = await runProbe(attribution, () => {
      switch (check) {
        case 'chat':
          return probeChat(row.modelId, attribution);
        case 'streaming':
          return probeStreaming(row.modelId, attribution);
        case 'vision':
          return probeVision(row.modelId, attribution);
        case 'tools':
          return probeTools(row.modelId, attribution);
        default:
          return probeJson(row.modelId, attribution);
      }
    });

    results[check] = result;
    verificationUpdates[check] = result.status;
    detailsUpdates[check] = {
      status: result.status,
      servedModel: result.servedModel,
      routeUpstream: result.routeUpstream,
      routeId: result.routeId,
      routed: result.routed,
      error: result.error,
      finishReason: result.finishReason,
      contentPreview: result.contentPreview,
      toolCalls: result.toolCalls,
      jsonParsed: result.jsonParsed,
      detail: result.detail,
    };

    if (result.status === 'verified') {
      // a REAL success is the only thing that turns a capability on
      if (check === 'streaming') {
        if (!row.streamSupported) {
          capabilityUpdates.push({ capability: 'streamSupported', from: false, to: true, reason: 'verified by a real streamed probe' });
        }
      } else if (!caps[check]) {
        caps[check] = true;
        capabilityUpdates.push({ capability: check, from: false, to: true, reason: 'verified by a real probe' });
      }
    } else if (result.status === 'failed' && check !== 'streaming') {
      // Conservative flip rule: only when the capability is currently
      // advertised AND no eligible route carries it — and only for routed
      // (emorai) models; glm-* provider models and streaming are never
      // auto-flipped by a single failed probe.
      if (row.category === 'emorai' && caps[check]) {
        const carriers = await countRouteCarriers(row.modelId, capsBefore, check);
        if (carriers === 0) {
          caps[check] = false;
          capabilityUpdates.push({
            capability: check,
            from: true,
            to: false,
            reason: 'probe failed and no eligible route carries this capability',
          });
          const message = `Model "${row.modelId}" advertised capability "${check}" but no eligible route can serve it — capability set to false after a failed real probe.`;
          alerts.push({ level: 'warning', category: 'capability', message });
          await createCapabilityAlert(row.modelId, check, result.error, probedAt);
        }
      }
    }
  }

  // merge verification evidence (previous evidence for un-probed checks survives)
  const previous = isPlainObject(row.capsVerification) ? row.capsVerification : {};
  const previousDetails = isPlainObject(previous.details) ? previous.details : {};
  const capsVerification = {
    ...previous,
    ...verificationUpdates,
    probedAt: probedAt.toISOString(),
    details: { ...previousDetails, ...detailsUpdates },
  };

  const capsChanged = JSON.stringify(caps) !== JSON.stringify(capsBefore);
  const streamUpdate = capabilityUpdates.find((u) => u.capability === 'streamSupported');
  const updated = await db.modelConfig.update({
    where: { id: row.id },
    data: {
      capsVerifiedAt: probedAt,
      capsVerification: capsVerification as unknown as Prisma.InputJsonValue,
      ...(capsChanged ? { capabilities: caps as unknown as Prisma.InputJsonValue } : {}),
      ...(streamUpdate && streamUpdate.to === true ? { streamSupported: true } : {}),
    },
  });

  return ok({
    model: {
      modelId: updated.modelId,
      displayName: updated.displayName,
      category: updated.category,
      capabilities: updated.capabilities,
      streamSupported: updated.streamSupported,
      capsVerifiedAt: updated.capsVerifiedAt,
      capsVerification: updated.capsVerification,
    },
    checks,
    probedAt: probedAt.toISOString(),
    results,
    capabilityUpdates,
    alerts,
  });
}
