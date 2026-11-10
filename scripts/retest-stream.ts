/** Focused retest: OpenAI streaming + protocol logging. */
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
const BASE = 'http://localhost:3000';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const body = randomBytes(24).toString('hex');
  const plaintext = `emr_${body}`;
  const row = await db.apiKey.create({
    data: {
      name: 'retest-stream',
      keyHash: createHash('sha256').update(plaintext).digest('hex'),
      prefix: `emr_${body.slice(0, 6)}…`,
    },
  });

  try {
    await sleep(8000);
    const res = await fetch(`${BASE}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${plaintext}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Reply with exactly: OPENAI STREAM OK' }],
        stream: true,
        max_tokens: 60,
        temperature: 0,
      }),
    });
    const raw = await res.text();
    console.log('status:', res.status);
    const chunks: any[] = [];
    for (const block of raw.split('\n\n')) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      const payload = dataLine.slice(6);
      if (payload === '[DONE]') continue;
      try { chunks.push(JSON.parse(payload)); } catch { /* ignore */ }
    }
    const first = chunks.find((c) => c?.choices?.[0]?.delta?.role);
    const text = chunks.map((c) => c?.choices?.[0]?.delta?.content ?? '').join('');
    const sawDone = raw.includes('[DONE]');
    console.log('first role delta:', first?.choices?.[0]?.delta?.role);
    console.log('text:', JSON.stringify(text));
    console.log('saw [DONE]:', sawDone);
    console.log('PASS:', res.status === 200 && first?.choices?.[0]?.delta?.role === 'assistant' && sawDone && text.includes('OPENAI STREAM OK'));

    const records = await db.usageRecord.findMany({
      where: { apiKeyId: row.id, source: 'api' },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    console.log('protocols recorded:', records.map((r) => r.protocol));
  } finally {
    await db.apiKey.delete({ where: { id: row.id } }).catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
}
main();
