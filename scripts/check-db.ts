import { db } from '../src/lib/db';
async function main() {
  const counts = {
    providerAccounts: await db.providerAccount.count(),
    modelConfigs: await db.modelConfig.count(),
    routes: await db.modelRoute.count(),
    apiKeys: await db.apiKey.count(),
    routingDecisions: await db.routingDecision.count(),
    usageRecords: await db.usageRecord.count(),
    conversations: await db.conversation.count(),
    messages: await db.message.count(),
    artifacts: await db.artifact.count(),
  };
  console.log('=== DB counts ===');
  for (const [k, v] of Object.entries(counts)) console.log(k.padEnd(18), v);

  const keys = await db.apiKey.findMany({ select: { id: true, name: true, prefix: true, revokedAt: true, createdAt: true, lastUsedAt: true } });
  console.log('=== api keys ===');
  for (const k of keys) console.log(k.id, '|', k.name, '|', k.prefix, '|', k.revokedAt ? 'REVOKED' : 'active', '| created:', k.createdAt.toISOString(), '| lastUsed:', k.lastUsedAt?.toISOString() ?? 'never');

  const decisions = await db.routingDecision.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, modelId: true, finalStatus: true, errorText: true, attemptCount: true } });
  console.log('=== recent routing decisions ===');
  for (const d of decisions) console.log(d.createdAt.toISOString(), '|', d.modelId, '|', d.finalStatus, '| attempts:', d.attemptCount, '| err:', d.errorText?.slice(0, 100) ?? '-');

  const models = await db.modelConfig.findMany({ where: { category: 'emorai' }, select: { modelId: true, enabled: true } });
  console.log('=== emorai models ===');
  for (const m of models) console.log(m.modelId, m.enabled ? '(enabled)' : '(disabled)');

  const recentUsage = await db.usageRecord.findMany({ orderBy: { createdAt: 'desc' }, take: 6, select: { createdAt: true, source: true, success: true, apiKeyId: true, modelId: true, errorText: true } });
  console.log('=== recent usage ===');
  for (const u of recentUsage) console.log(u.createdAt.toISOString(), '|', u.source, '|', u.success ? 'OK' : 'FAIL', '| key:', u.apiKeyId ?? '-', '|', u.modelId, '| err:', u.errorText?.slice(0, 80) ?? '-');
}
main().catch((e) => { console.error(e); process.exit(1); });
