import { db } from '../src/lib/db';
async function main() {
  const accounts = await db.providerAccount.findMany({
    select: { id: true, name: true, providerType: true, credentialMode: true, apiKeyEnc: true, baseUrl: true, enabled: true, lastStatus: true, lastError: true, requestCount: true, createdAt: true, updatedAt: true },
  });
  console.log('=== provider accounts ===');
  for (const a of accounts) console.log(
    a.id, '|', a.name, '|', a.providerType, '|', a.credentialMode, '|',
    'enc:', a.apiKeyEnc ? `present(${a.apiKeyEnc.slice(0, 20)}…)` : 'NONE', '|',
    'baseUrl:', a.baseUrl ?? '-', '|', a.enabled ? 'enabled' : 'DISABLED', '|',
    'lastStatus:', a.lastStatus ?? '-', '| reqCount:', a.requestCount, '| err:', a.lastError?.slice(0, 80) ?? '-'
  );
  const routes = await db.modelRoute.findMany({
    select: { id: true, publicModelId: true, upstreamModelId: true, providerAccountId: true, priority: true, enabled: true, healthStatus: true, lastError: true },
  });
  console.log('=== routes ===');
  for (const r of routes) console.log(
    r.publicModelId, '→', r.upstreamModelId, '| acct:', r.providerAccountId, '| pri:', r.priority, '|', r.enabled ? 'on' : 'off', '| health:', r.healthStatus, '| err:', r.lastError?.slice(0, 60) ?? '-'
  );
}
main().catch((e) => { console.error(e); process.exit(1); });
