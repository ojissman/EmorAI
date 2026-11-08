// SSE (Server-Sent Events) helpers shared by the dashboard chat engine and
// the OpenAI-compatible developer API.

export function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export function sseDone(): string {
  return 'data: [DONE]\n\n';
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Parses an upstream provider SSE byte stream into OpenAI-compatible chunk
 * objects. Handles partial frames across chunk boundaries.
 */
export async function* parseUpstreamSSE(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<{ data: Record<string, unknown>; raw: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          yield { data: parsed, raw: payload };
        } catch {
          // Malformed frame — skip rather than kill the stream.
        }
      }
    }
    // Flush any trailing complete frame.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== '[DONE]') {
        try {
          yield { data: JSON.parse(payload) as Record<string, unknown>, raw: payload };
        } catch {
          // ignore
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // stream already closed
    }
  }
}
