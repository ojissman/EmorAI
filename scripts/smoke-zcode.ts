// Smoke test: the exact ZCode-failing request shape against the live gateway.
// ZCode sent messages[1].role = "system" (Anthropic format) and was rejected
// with `messages.1.role — Invalid option: expected one of "user"|"assistant"`.
// Usage: bun scripts/smoke-zcode.ts
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.GATEWAY_BASE ?? 'http://localhost:3000';
const db = new PrismaClient();

const body = randomBytes(24).toString('hex');
const plaintext = `emr_${body}`;
await db.apiKey.create({
  data: {
    name: 'smoke-zcode',
    keyHash: createHash('sha256').update(plaintext, 'utf8').digest('hex'),
    prefix: `emr_${body.slice(0, 6)}…`,
  },
});

try {
  // 1. count_tokens with the liberal shape (no provider call)
  const ct = await fetch(`${BASE}/api/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'x-api-key': plaintext, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: '<environment>cwd: /tmp</environment>' },
      ],
    }),
  });
  console.log(`count_tokens: ${ct.status} ${(await ct.text()).slice(0, 120)}`);

  // 2. THE regression: system-role message inside messages[] (non-stream)
  const r = await fetch(`${BASE}/api/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': plaintext, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 80,
      system: 'You are a helpful coding agent. Reply with exactly the requested text.',
      messages: [
        { role: 'user', content: 'Reply with exactly: ZCODE SMOKE OK' },
        { role: 'system', content: 'Environment: linux, cwd: /tmp, agent: ZCode' },
      ],
    }),
  });
  const text = await r.text();
  console.log(`messages (system-role leak): ${r.status} ${text.slice(0, 300)}`);

  // 3. OpenAI-style tool leak inside Anthropic format
  await new Promise((res) => setTimeout(res, 9000));
  const r2 = await fetch(`${BASE}/api/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': plaintext, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 200,
      messages: [
        { role: 'user', content: 'What is the weather in Paris?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '18C and cloudy' },
      ],
      tools: [{ name: 'get_weather', description: 'Get weather', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    }),
  });
  console.log(`messages (tool leak): ${r2.status} ${(await r2.text()).slice(0, 300)}`);

  // 4. Validation-failure logging check: garbage role still 400s but now LOGGED
  const r3 = await fetch(`${BASE}/api/v1/messages`, {
    method: 'POST',
    headers: { 'x-api-key': plaintext, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      max_tokens: 20,
      messages: [{ role: 5, content: 'hi' }], // role not a string → schema 400
    }),
  });
  console.log(`messages (bad role type): ${r3.status} (expect 400, now logged)`);
  await new Promise((res) => setTimeout(res, 1500));
  const logs = await db.usageRecord.findMany({
    where: { apiKey: { prefix: `emr_${body.slice(0, 6)}…` }, success: false },
    orderBy: { createdAt: 'desc' },
    take: 3,
  });
  for (const l of logs) console.log(`  logged: ${l.statusCode} ${l.errorText?.slice(0, 180)}`);
} finally {
  const key = await db.apiKey.findFirst({ where: { prefix: `emr_${body.slice(0, 6)}…` } });
  if (key) {
    await db.usageRecord.deleteMany({ where: { apiKeyId: key.id } });
    await db.apiKey.delete({ where: { id: key.id } });
  }
  await db.$disconnect();
}
