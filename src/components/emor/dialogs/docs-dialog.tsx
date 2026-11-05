"use client";

import { BookOpen, Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useEmorStore } from '@/stores/emor-store';
import { Markdown } from '../chat/markdown';

function CopyBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // ignore
    }
  };
  return (
    <div className="emor-codeblock">
      <div className="emor-codeblock-header">
        <span>{lang}</span>
        <button className="inline-flex items-center gap-1 rounded px-2 py-0.5 hover:bg-accent" onClick={() => void copy()}>
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto px-4 py-3 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const CURL_EXAMPLE = `curl -N http://localhost:3000/api/v1/chat/completions \\
  -H "Authorization: Bearer emr_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3-flash",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user", "content": "Explain SSE streaming in one paragraph."}
    ],
    "stream": true,
    "temperature": 0.7,
    "max_tokens": 1024
  }'`;

const JS_EXAMPLE = `// Node.js 18+ (also works in browsers)
const BASE = "http://localhost:3000"; // your EmorAI host
const KEY = "emr_YOUR_KEY";

async function chat(messages, { stream = true } = {}) {
  const res = await fetch(BASE + "/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": \`Bearer \${KEY}\`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "glm-5.3-flash", messages, stream }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error?.message ?? \`HTTP \${res.status}\`);
  }

  if (!stream) {
    const data = await res.json();
    return data.choices[0].message.content;
  }

  // Stream SSE chunks (OpenAI-compatible format)
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const chunk = JSON.parse(payload);
        if (chunk.error) throw new Error(chunk.error.message);
        full += chunk.choices?.[0]?.delta?.content ?? "";
      } catch { /* partial frame */ }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\\n") + 1);
  }
  return full;
}

chat([{ role: "user", content: "Hello EmorAI!" }]).then(console.log);`;

const PY_EXAMPLE = `import json
import requests  # pip install requests

BASE = "http://localhost:3000"   # your EmorAI host
KEY = "emr_YOUR_KEY"

def chat(messages, stream=True):
    res = requests.post(
        f"{BASE}/api/v1/chat/completions",
        headers={"Authorization": f"Bearer {KEY}"},
        json={
            "model": "glm-5.3-flash",
            "messages": messages,
            "stream": stream,
            "temperature": 0.7,
        },
        stream=stream,
        timeout=300,
    )
    res.raise_for_status()

    if not stream:
        return res.json()["choices"][0]["message"]["content"]

    full = ""
    for line in res.iter_lines(decode_unicode=True):
        if not line or not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        chunk = json.loads(payload)
        if "error" in chunk:
            raise RuntimeError(chunk["error"]["message"])
        full += chunk["choices"][0]["delta"].get("content", "")
    return full

print(chat([{"role": "user", "content": "Hello EmorAI!"}]))`;

export function DocsDialog() {
  const dialog = useEmorStore((s) => s.dialog);
  const closeDialog = useEmorStore((s) => s.closeDialog);
  const openDialog = useEmorStore((s) => s.openDialog);

  return (
    <Dialog open={dialog === 'docs'} onOpenChange={(v) => (!v ? closeDialog() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-primary" /> EmorAI Developer API
          </DialogTitle>
          <DialogDescription>
            An OpenAI-compatible API over your own models. Authenticate with EmorAI API keys — create one in{' '}
            <button className="text-primary underline underline-offset-2" onClick={() => openDialog('keys')}>
              API keys
            </button>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="emor-scroll overflow-y-auto px-5 py-4" style={{ maxHeight: '62vh' }}>
          <Tabs defaultValue="overview">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="overview" className="text-xs">Overview</TabsTrigger>
              <TabsTrigger value="chat" className="text-xs">Chat</TabsTrigger>
              <TabsTrigger value="models" className="text-xs">Models</TabsTrigger>
              <TabsTrigger value="usage" className="text-xs">Usage</TabsTrigger>
              <TabsTrigger value="errors" className="text-xs">Errors</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="mt-4 space-y-4">
              <Markdown
                content={`**Base URL:** \`\${your-EmorAI-host}\` — all endpoints live under \`/api/v1\`.

**Authentication** — send your key in the \`Authorization\` header:

\`\`\`
Authorization: Bearer emr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
\`\`\`

Keys are generated in the dashboard (**More → API keys**). Rate limits apply per key (default **60 requests/minute**, configurable in Settings → General). Exceeding the limit returns \`429\` with a \`retry_after_sec\` hint.

| Endpoint | Method | Purpose |
| --- | --- | --- |
| \`/api/v1/chat/completions\` | POST | Chat with streaming or blocking responses |
| \`/api/v1/models\` | GET | List enabled models + capabilities |
| \`/api/v1/usage\` | GET | Token/request usage for this key |

**Privacy note:** provider credentials (Z.ai) live server-side only and are never exposed through the API.`}
              />
              <CopyBlock lang="curl" code={CURL_EXAMPLE} />
            </TabsContent>

            <TabsContent value="chat" className="mt-4 space-y-4">
              <div className="rounded-xl border p-3.5 text-sm">
                <div className="flex items-center gap-2">
                  <Badge>POST</Badge>
                  <code className="text-xs">/api/v1/chat/completions</code>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  OpenAI-compatible chat completions. Set <code>&quot;stream&quot;: true</code> for SSE chunks in the standard
                  <code> chat.completion.chunk</code> format terminated by <code>[DONE]</code>.
                </p>
              </div>
              <Markdown
                content={`**Request body**

| Field | Type | Notes |
| --- | --- | --- |
| \`model\` | string | Required. A model ID from \`/api/v1/models\` |
| \`messages\` | array | Required. \`system\` / \`user\` / \`assistant\` roles |
| \`stream\` | boolean | Default \`false\` |
| \`temperature\` | number | 0–2, falls back to instance default |
| \`max_tokens\` | integer | Output cap, falls back to instance default |

Messages may use string content, or OpenAI-style parts (\`text\` / \`image_url\`) — image parts require a vision-capable model (e.g. \`glm-4.6v-flash\`), otherwise the request fails with \`vision_not_supported\`.`}
              />
              <CopyBlock lang="javascript" code={JS_EXAMPLE} />
              <CopyBlock lang="python" code={PY_EXAMPLE} />
            </TabsContent>

            <TabsContent value="models" className="mt-4 space-y-4">
              <div className="rounded-xl border p-3.5 text-sm">
                <div className="flex items-center gap-2">
                  <Badge>GET</Badge>
                  <code className="text-xs">/api/v1/models</code>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">Lists every enabled model with capabilities, free-tier flag and last probe status.</p>
              </div>
              <CopyBlock
                lang="response"
                code={`{
  "object": "list",
  "data": [
    {
      "id": "glm-5.3-flash",
      "object": "model",
      "owned_by": "zai",
      "display_name": "GLM-5.3 Flash",
      "description": "Fast, zero-cost tier model…",
      "capabilities": { "chat": true, "reasoning": true, "vision": false, … },
      "free_tier": true,
      "last_status": "ok",
      "last_served_model": "glm-4-plus"
    }
  ]
}`}
              />
              <p className="text-xs text-muted-foreground">
                Some gateways alias model IDs — check <code>last_served_model</code> to see the model the provider actually reported serving.
              </p>
            </TabsContent>

            <TabsContent value="usage" className="mt-4 space-y-4">
              <div className="rounded-xl border p-3.5 text-sm">
                <div className="flex items-center gap-2">
                  <Badge>GET</Badge>
                  <code className="text-xs">/api/v1/usage?days=30</code>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Token and request totals for the presenting key, plus a per-model breakdown and recent records.
                </p>
              </div>
              <CopyBlock
                lang="response"
                code={`{
  "object": "usage_report",
  "api_key": { "name": "Mobile app" },
  "window_days": 30,
  "totals": { "requests": 142, "failed": 1, "prompt_tokens": 58210, "completion_tokens": 30112, "total_tokens": 88322 },
  "by_model": [{ "modelId": "glm-5.3-flash", "requests": 142, "totalTokens": 88322 }],
  "recent": [ … up to 50 records … ]
}`}
              />
            </TabsContent>

            <TabsContent value="errors" className="mt-4 space-y-4">
              <Markdown
                content={`Errors use the OpenAI envelope \`{"error": {"message", "type", "code"}}\`.

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | missing_api_key / invalid_api_key / key_revoked | Authenticate with a valid, active key |
| 400 | invalid_request / vision_not_supported | Fix the payload or use a vision model |
| 404 | model_not_found | The model ID is not in this registry |
| 409 | model_disabled | Administrator disabled the model |
| 429 | rate_limited | Slow down; see \`retry_after_sec\` |
| 502 | provider_error / provider_auth | Upstream (Z.ai) failure or server credential issue |

Streaming failures are emitted as a final SSE chunk containing an \`error\` object before \`[DONE]\`.`}
              />
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
