/**
 * EmorAI unified model family seed — Generation 1.
 *
 * Creates (idempotently, never overwriting admin edits):
 *   • the platform-managed Z.ai ProviderAccount
 *   • EmorAI model generations emor-5.3 / emor-5.2 / emor-5.1 (category A)
 *   • their intelligent-routing ModelRoutes to verified upstream GLM models
 *
 * Honesty rules applied:
 *   • capabilities are copied from the upstream registry rows (probe-backed),
 *     never invented; the public model's set is the union of its routes' sets
 *   • context window = MIN across routes (a failover route must honor it)
 *   • pricing is left UNCONFIGURED (null) — admin sets real values later;
 *     the platform never fabricates prices
 *   • descriptions state Gen-1 reality: authorized upstream inference routes,
 *     not EmorAI-trained models
 *
 * Run: bun run scripts/seed-emor-family.ts
 */
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

type Caps = {
  chat: boolean;
  reasoning: boolean;
  vision: boolean;
  files: boolean;
  webSearch: boolean;
  tools: boolean;
  json: boolean;
};

const BASE_CAPS: Caps = {
  chat: true,
  reasoning: false,
  vision: false,
  files: false,
  webSearch: true,
  tools: false,
  json: false,
};

type EmorSeed = {
  modelId: string;
  displayName: string;
  generation: string;
  description: string;
  sortOrder: number;
  routes: Array<{
    upstreamModelId: string;
    priority: number;
    capabilities: Caps;
    contextWindow: number;
    maxOutputTokens: number;
  }>;
};

// Route capability sets mirror the seeded registry rows for the same upstream
// models (model-registry.ts DEFAULT_MODELS) — the honest, verified subsets.
const FLASH_FULL: Caps = { ...BASE_CAPS, reasoning: true, tools: true, json: true };
const TOOLS_ONLY: Caps = { ...BASE_CAPS, tools: true, json: true };
const PLAIN_CHAT: Caps = { ...BASE_CAPS };

const EMOR_FAMILY: EmorSeed[] = [
  {
    modelId: 'emor-5.3',
    displayName: 'Emor-5.3',
    generation: '5.3',
    description:
      'EmorAI flagship generation: unified general-purpose model for conversation, reasoning, coding, analysis and tool use. Generation 1 — served through EmorAI intelligent routing over authorized upstream inference routes (Z.ai GLM infrastructure); not an EmorAI-trained model.',
    sortOrder: 1,
    routes: [
      { upstreamModelId: 'glm-5.3', priority: 0, capabilities: FLASH_FULL, contextWindow: 200_000, maxOutputTokens: 32_768 },
      { upstreamModelId: 'glm-5.3-flash', priority: 10, capabilities: FLASH_FULL, contextWindow: 128_000, maxOutputTokens: 16_384 },
    ],
  },
  {
    modelId: 'emor-5.2',
    displayName: 'Emor-5.2',
    generation: '5.2',
    description:
      'EmorAI balanced generation: everyday reasoning, drafting and coding-agent workloads at higher throughput. Generation 1 — served through EmorAI intelligent routing over authorized upstream routes; not an EmorAI-trained model.',
    sortOrder: 2,
    routes: [
      { upstreamModelId: 'glm-4.7-flash', priority: 0, capabilities: TOOLS_ONLY, contextWindow: 128_000, maxOutputTokens: 16_384 },
    ],
  },
  {
    modelId: 'emor-5.1',
    displayName: 'Emor-5.1',
    generation: '5.1',
    description:
      'EmorAI high-volume generation: fast, lightweight chat for latency-sensitive workloads. Generation 1 — served through EmorAI intelligent routing over authorized upstream routes; not an EmorAI-trained model.',
    sortOrder: 3,
    routes: [
      { upstreamModelId: 'glm-4.5-flash', priority: 0, capabilities: PLAIN_CHAT, contextWindow: 128_000, maxOutputTokens: 8_192 },
    ],
  },
];

function unionCaps(sets: Caps[]): Caps {
  return {
    chat: sets.some((s) => s.chat),
    reasoning: sets.some((s) => s.reasoning),
    vision: sets.some((s) => s.vision),
    files: sets.some((s) => s.files),
    webSearch: sets.some((s) => s.webSearch),
    tools: sets.some((s) => s.tools),
    json: sets.some((s) => s.json),
  };
}

async function main(): Promise<void> {
  // 1) platform-managed Z.ai provider account
  let account = await db.providerAccount.findFirst({ where: { providerType: 'zai', credentialMode: 'platform' } });
  if (!account) {
    account = await db.providerAccount.create({
      data: {
        name: 'Z.ai (platform-managed)',
        providerType: 'zai',
        credentialMode: 'platform',
        baseUrl: null,
        apiKeyEnc: null,
        enabled: true,
        priority: 0,
      },
    });
    console.log(`✓ created provider account ${account.id} (zai, platform credentials)`);
  } else {
    console.log(`• zai platform account exists (${account.id})`);
  }

  for (const seed of EMOR_FAMILY) {
    const routes = seed.routes;
    const caps = unionCaps(routes.map((r) => r.capabilities));
    const contextWindow = Math.min(...routes.map((r) => r.contextWindow));
    const maxOutputTokens = Math.min(...routes.map((r) => r.maxOutputTokens));

    // 2) public EmorAI model generation
    let model = await db.modelConfig.findUnique({ where: { modelId: seed.modelId } });
    if (!model) {
      model = await db.modelConfig.create({
        data: {
          modelId: seed.modelId,
          displayName: seed.displayName,
          description: seed.description,
          provider: 'zai',
          category: 'emorai',
          lifecycle: 'active',
          generation: seed.generation,
          capabilities: caps,
          freeTier: true,
          enabled: true,
          sortOrder: seed.sortOrder,
          contextWindow,
          maxOutputTokens,
          aliases: [],
          streamSupported: true,
        },
      });
      console.log(`✓ created ${seed.modelId} (category emorai, ${routes.length} route(s))`);
    } else {
      console.log(`• ${seed.modelId} exists (left untouched)`);
    }

    // 3) routing table
    for (const r of routes) {
      const existing = await db.modelRoute.findFirst({
        where: { publicModelId: seed.modelId, providerAccountId: account.id, upstreamModelId: r.upstreamModelId },
      });
      if (!existing) {
        await db.modelRoute.create({
          data: {
            publicModelId: seed.modelId,
            providerAccountId: account.id,
            upstreamModelId: r.upstreamModelId,
            priority: r.priority,
            enabled: true,
            capabilities: r.capabilities,
            maxConcurrency: 0,
            timeoutMs: 120_000,
            weight: r.priority === 0 ? 1.0 : 1.25,
            healthStatus: 'unknown',
          },
        });
        console.log(`  ✓ route ${seed.modelId} → ${r.upstreamModelId} (priority ${r.priority})`);
      } else {
        console.log(`  • route ${seed.modelId} → ${r.upstreamModelId} exists`);
      }
    }
  }

  const counts = {
    models: await db.modelConfig.count(),
    emorModels: await db.modelConfig.count({ where: { category: 'emorai' } }),
    accounts: await db.providerAccount.count(),
    routes: await db.modelRoute.count(),
  };
  console.log(`\nRegistry: ${counts.models} models (${counts.emorModels} EmorAI), ${counts.accounts} provider accounts, ${counts.routes} routes.`);
}

main()
  .catch((e) => {
    console.error('seed failed:', e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
