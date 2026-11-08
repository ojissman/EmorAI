import ZAI from 'z-ai-web-dev-sdk';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn: () => Promise<void>, label: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (msg.includes('429') && attempt < 3) {
        console.log(JSON.stringify({ label, retry: attempt + 1 }));
        await sleep(15000);
        continue;
      }
      console.log(JSON.stringify({ label, ok: false, error: msg.slice(0, 300) }));
      return;
    }
  }
}

async function main() {
  const zai = await ZAI.create();

  // 1. Non-streaming tools
  await withRetry(async () => {
    const res = (await zai.chat.completions.create({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'What is the weather in Paris? You MUST call the get_weather tool.' }],
      thinking: { type: 'disabled' },
      max_tokens: 300,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
      tool_choice: 'auto',
    } as never)) as any;
    console.log(JSON.stringify({
      probe: 'tools-nonstream',
      ok: true,
      servedModel: res?.model,
      finishReason: res?.choices?.[0]?.finish_reason,
      message: res?.choices?.[0]?.message,
    }, null, 1));
  }, 'tools-nonstream');

  await sleep(12000);

  // 2. Streaming tools
  await withRetry(async () => {
    const stream = (await zai.chat.completions.create({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'Check the weather in Tokyo with your tool.' }],
      stream: true,
      thinking: { type: 'disabled' },
      max_tokens: 300,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
    } as never)) as ReadableStream<Uint8Array>;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let raw = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      if (raw.length > 12000) break;
    }
    console.log(JSON.stringify({
      probe: 'tools-stream',
      ok: true,
      lines: raw.split('\n').filter((l) => l.trim()).map((l) => l.slice(0, 400)).slice(0, 20),
    }, null, 1));
  }, 'tools-stream');

  await sleep(12000);

  // 3. Assistant message with tool_calls in history (tool round-trip)
  await withRetry(async () => {
    const res = (await zai.chat.completions.create({
      model: 'glm-5.3-flash',
      messages: [
        { role: 'user', content: 'What is the weather in Paris?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
        { role: 'tool', content: '{"temperature": 18, "condition": "cloudy"}', tool_call_id: 'call_1' },
      ],
      thinking: { type: 'disabled' },
      max_tokens: 200,
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get current weather for a city',
            parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
          },
        },
      ],
    } as never)) as any;
    console.log(JSON.stringify({
      probe: 'tool-roundtrip',
      ok: true,
      servedModel: res?.model,
      finishReason: res?.choices?.[0]?.finish_reason,
      content: String(res?.choices?.[0]?.message?.content ?? '').slice(0, 200),
    }, null, 1));
  }, 'tool-roundtrip');
}

main();
