/**
 * Dev utility: probes Z.ai endpoint for model availability, streaming format, and tools.
 * Run: bun scripts/probe.ts
 */
import ZAI from 'z-ai-web-dev-sdk';

const CANDIDATES = [
  undefined,
  'GLM-5.3',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-4.7-flash',
  'glm-4.5-flash',
  'glm-4.6v-flash',
  'glm-4.5v-flash',
  'glm-4.6v',
  'glm-4-flash',
];

async function probeModel(model?: string) {
  const zai = await ZAI.create();
  const body: Record<string, unknown> = {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    thinking: { type: 'disabled' },
    max_tokens: 16,
  };
  if (model) body.model = model;
  try {
    const res = await zai.chat.completions.create(body as never);
    console.log(
      JSON.stringify({
        probe: 'chat',
        requested: model ?? '(default)',
        ok: true,
        servedModel: res?.model ?? null,
        content: String(res?.choices?.[0]?.message?.content ?? '').slice(0, 60),
        usage: res?.usage ?? null,
      })
    );
  } catch (e) {
    console.log(
      JSON.stringify({
        probe: 'chat',
        requested: model ?? '(default)',
        ok: false,
        error: String((e as Error)?.message ?? e).slice(0, 260),
      })
    );
  }
}

async function probeStream() {
  const zai = await ZAI.create();
  try {
    const stream = (await zai.chat.completions.create({
      messages: [{ role: 'user', content: 'Count 1 to 3.' }],
      stream: true,
      thinking: { type: 'disabled' },
      max_tokens: 32,
    } as never)) as ReadableStream;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    let chunks = 0;
    let sawDone = false;
    const samples: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      chunks++;
      if (raw.length > 4000) break;
    }
    for (const line of raw.split('\n').slice(0, 14)) {
      if (line.trim()) samples.push(line.slice(0, 220));
      if (line.includes('[DONE]')) sawDone = true;
    }
    console.log(JSON.stringify({ probe: 'stream', ok: true, chunks, sawDone, samples }, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ probe: 'stream', ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
}

async function probeThinking() {
  const zai = await ZAI.create();
  try {
    const stream = (await zai.chat.completions.create({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'What is 17*23? Think briefly.' }],
      stream: true,
      thinking: { type: 'enabled' },
      max_tokens: 200,
    } as never)) as ReadableStream;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.length > 6000) break;
    }
    const keys = new Set<string>();
    for (const m of raw.matchAll(/"(\w+)"\s*:/g)) keys.add(m[1]);
    console.log(JSON.stringify({ probe: 'thinking-stream', ok: true, jsonKeys: [...keys].slice(0, 20), head: raw.slice(0, 500) }));
  } catch (e) {
    console.log(JSON.stringify({ probe: 'thinking-stream', ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
}

async function probeSearch() {
  const zai = await ZAI.create();
  try {
    const res = await zai.functions.invoke('web_search', { query: 'OpenAI API docs', num: 3 });
    console.log(JSON.stringify({ probe: 'web_search', ok: true, count: Array.isArray(res) ? res.length : null, first: Array.isArray(res) ? res[0]?.name : res }));
  } catch (e) {
    console.log(JSON.stringify({ probe: 'web_search', ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
}

async function main() {
  for (const m of CANDIDATES) await probeModel(m);
  await probeStream();
  await probeThinking();
  await probeSearch();
}

main();
