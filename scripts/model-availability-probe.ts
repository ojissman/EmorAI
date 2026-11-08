/**
 * Spaced probe of candidate model IDs — records what the gateway actually serves.
 * Run: bun run scripts/model-availability-probe.ts
 */
import ZAI from 'z-ai-web-dev-sdk';

const CANDIDATES = [
  'glm-5.3-flash', 'glm-5.3', 'glm-4.7-flash', 'glm-4.5-flash',
  'glm-4.6v-flash', 'glm-4.5v-flash', 'glm-4.6v', 'glm-4-flash',
  'glm-4-plus', 'glm-4.6', 'glm-4.5-air', 'glm-4-Flash',
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probe(model: string) {
  const zai = await ZAI.create();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = (await zai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        thinking: { type: 'disabled' },
        max_tokens: 12,
      } as never)) as any;
      console.log(JSON.stringify({ model, ok: true, served: res?.model ?? null, content: String(res?.choices?.[0]?.message?.content ?? '').slice(0, 30) }));
      return;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('429') && attempt < 2) { await sleep(15000); continue; }
      console.log(JSON.stringify({ model, ok: false, error: msg.slice(0, 160) }));
      return;
    }
  }
}

async function main() {
  for (const m of CANDIDATES) { await probe(m); await sleep(11000); }
}
main();
