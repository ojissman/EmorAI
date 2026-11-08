// Inspect recent gateway request logs (failed requests first, then tail).
// Usage: bun scripts/inspect-logs.ts
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

const failed = await db.usageRecord.findMany({
  where: { success: false },
  orderBy: { createdAt: 'desc' },
  take: 25,
  select: {
    createdAt: true,
    source: true,
    protocol: true,
    endpoint: true,
    statusCode: true,
    requestId: true,
    modelId: true,
    errorText: true,
  },
});

console.log(`\n=== FAILED REQUESTS (${failed.length}) ===`);
for (const r of failed) {
  console.log(
    `[${r.createdAt.toISOString()}] ${r.source}/${r.protocol ?? '-'} ${r.endpoint} -> ${r.statusCode} model=${r.modelId} req=${r.requestId}`
  );
  console.log(`    error: ${r.errorText?.slice(0, 400) ?? '(none)'}`);
}

const tail = await db.usageRecord.findMany({
  orderBy: { createdAt: 'desc' },
  take: 15,
  select: { createdAt: true, protocol: true, endpoint: true, statusCode: true, modelId: true, success: true, errorText: true },
});
console.log(`\n=== LAST 15 REQUESTS (any status) ===`);
for (const r of tail) {
  console.log(
    `[${r.createdAt.toISOString()}] ${r.protocol ?? '-'} ${r.endpoint} -> ${r.statusCode} ${r.success ? 'OK' : 'FAIL'} model=${r.modelId}${r.success ? '' : ` err=${(r.errorText ?? '').slice(0, 200)}`}`
  );
}

await db.$disconnect();
