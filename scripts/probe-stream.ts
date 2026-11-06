/**
 * Dev utility: probes streaming format, thinking, and web search with spacing.
 * Run: bun scripts/probe-stream.ts
 */
import ZAI from 'z-ai-web-dev-sdk';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function probeStream() {
  const zai = await ZAI.create();
  const stream = (await zai.chat.completions.create({
    messages: [{ role: 'user', content: 'Count 1 to 3.' }],
    stream: true,
    thinking: { type: 'disabled' },
    max_tokens: 32,
  } as never)) as ReadableStream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.length > 3000) break;
  }
  const lines = raw.split('\n').filter((l) => l.trim());
  console.log(JSON.stringify({ probe: 'stream', ok: true, lines: lines.slice(0, 8).map((l) => l.slice(0, 300)), total: lines.length }, null, 1));
}

async function probeThinking() {
  const zai = await ZAI.create();
  const stream = (await zai.chat.completions.create({
    messages: [{ role: 'user', content: 'What is 17*23?' }],
    stream: true,
    thinking: { type: 'enabled' },
    max_tokens: 300,
  } as never)) as ReadableStream;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let raw = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    raw += decoder.decode(value, { stream: true });
    if (raw.length > 8000) break;
  }
  const keys = new Set<string>();
  for (const m of raw.matchAll(/"(\w+)"\s*:/g)) keys.add(m[1]);
  const hasReasoning = raw.includes('reasoning_content');
  console.log(JSON.stringify({ probe: 'thinking-stream', ok: true, hasReasoning, jsonKeys: [...keys].slice(0, 20), head: raw.slice(0, 600) }, null, 1));
}

async function probeSearch() {
  const zai = await ZAI.create();
  const res = await zai.functions.invoke('web_search', { query: 'Next.js App Router', num: 3 });
  console.log(JSON.stringify({ probe: 'web_search', ok: true, count: Array.isArray(res) ? res.length : null, first: Array.isArray(res) ? { name: res[0]?.name, url: res[0]?.url, snippet: res[0]?.snippet?.slice(0, 80) } : res }));
}

async function main() {
  try {
    await probeStream();
  } catch (e) {
    console.log(JSON.stringify({ probe: 'stream', ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  await sleep(15000);
  try {
    await probeThinking();
  } catch (e) {
    console.log(JSON.stringify({ probe: 'thinking', ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
  await sleep(15000);
  try {
    await probeSearch();
  } catch (e) {
    console.log(JSON.stringify({ probe: 'web_search', ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  }
}

main();
