'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

// ─── Method / status badges ───────────────────────────────────────────────────

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

const METHOD_STYLES: Record<HttpMethod, string> = {
  GET: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
  POST: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
  PATCH: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
  DELETE: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
};

export function MethodBadge({ method }: { method: HttpMethod }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-md border px-2 font-mono text-xs font-semibold tracking-wide',
        METHOD_STYLES[method]
      )}
    >
      {method}
    </span>
  );
}

// ─── Copy button ──────────────────────────────────────────────────────────────

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(label ? `${label} copied` : 'Copied to clipboard');
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not access the clipboard');
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      aria-label={copied ? 'Copied' : `Copy${label ? ` ${label}` : ''}`}
      className={cn('h-7 gap-1.5 px-2 text-xs', className)}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

// ─── Code block ───────────────────────────────────────────────────────────────

export function CodeBlock({
  code,
  title,
  className,
  preClassName,
}: {
  code: string;
  title?: string;
  className?: string;
  preClassName?: string;
}) {
  return (
    <div className={cn('overflow-hidden rounded-lg border bg-muted/40', className)}>
      <div className="flex items-center justify-between gap-2 border-b bg-muted/60 px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{title ?? 'shell'}</span>
        <CopyButton value={code} />
      </div>
      <pre
        className={cn(
          'overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground',
          preClassName
        )}
      >
        {code}
      </pre>
    </div>
  );
}

// ─── Snippet builders (use the real base URL + key) ──────────────────────────

export function curlChatCompletions(baseUrl: string, key: string, stream: boolean): string {
  return `curl ${baseUrl}/api/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3-flash",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "Write a haiku about APIs." }
    ],
    "stream": ${stream}
  }'`;
}

export function curlModels(baseUrl: string, key: string): string {
  return `curl ${baseUrl}/api/v1/models \\
  -H "Authorization: Bearer ${key}"`;
}

export function curlUsage(baseUrl: string, key: string): string {
  return `curl "${baseUrl}/api/v1/usage?days=7" \\
  -H "Authorization: Bearer ${key}"`;
}

export function curlImages(baseUrl: string, key: string): string {
  return `curl ${baseUrl}/api/v1/images/generations \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "A cozy cabin in a snowy forest at dusk",
    "size": "1024x1024",
    "n": 1
  }'`;
}

export function curlSpeech(baseUrl: string, key: string): string {
  return `curl ${baseUrl}/api/v1/audio/speech \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -o speech.mp3 \\
  -d '{
    "input": "Welcome to EmorAI.",
    "voice": "tongtong",
    "speed": 1
  }'`;
}

export function curlVideoCreate(baseUrl: string, key: string): string {
  return `curl ${baseUrl}/api/v1/videos/generations \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "prompt": "Clouds rolling over mountain peaks at sunrise",
    "quality": "speed",
    "with_audio": false,
    "duration": 5
  }'`;
}

export function curlVideoPoll(baseUrl: string, key: string, taskId = 'TASK_ID'): string {
  return `curl "${baseUrl}/api/v1/videos/generations/${taskId}" \\
  -H "Authorization: Bearer ${key}"`;
}

export function jsChatCompletions(baseUrl: string, key: string): string {
  return `const res = await fetch("${baseUrl}/api/v1/chat/completions", {
  method: "POST",
  headers: {
    Authorization: "Bearer ${key}",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "glm-5.3-flash",
    messages: [{ role: "user", content: "Write a haiku about APIs." }],
    stream: true,
  }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  for (const frame of decoder.decode(value).split("\\n\\n")) {
    if (!frame.startsWith("data: ")) continue;
    const data = frame.slice(6);
    if (data === "[DONE]") break;
    const chunk = JSON.parse(data);
    console.log(chunk.choices[0]?.delta?.content ?? "");
  }
}`;
}

export function jsModels(baseUrl: string, key: string): string {
  return `const res = await fetch("${baseUrl}/api/v1/models", {
  headers: { Authorization: "Bearer ${key}" },
});
const { data } = await res.json();
console.log(data.map((m) => m.id));`;
}

export function pyChatCompletions(baseUrl: string, key: string): string {
  return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/api/v1",
    api_key="${key}",
)

stream = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "Write a haiku about APIs."}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="")`;
}

export function pyModels(baseUrl: string, key: string): string {
  return `from openai import OpenAI

client = OpenAI(
    base_url="${baseUrl}/api/v1",
    api_key="${key}",
)

for model in client.models.list().data:
    print(model.id)`;
}

// ─── Anthropic-protocol snippets ──────────────────────────────────────────────

export function curlAnthropicMessages(baseUrl: string, key: string, stream: boolean): string {
  return `curl ${baseUrl}/api/v1/messages \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3-flash",
    "max_tokens": 1024,
    "system": "You are a helpful assistant.",
    "messages": [
      { "role": "user", "content": "Write a haiku about APIs." }
    ],
    "stream": ${stream}
  }'`;
}

export function curlCountTokens(baseUrl: string, key: string): string {
  return `curl ${baseUrl}/api/v1/messages/count_tokens \\
  -H "x-api-key: ${key}" \\
  -H "anthropic-version: 2023-06-01" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{ "role": "user", "content": "Hello Claude Code!" }]
  }'`;
}

export function pyAnthropicMessages(baseUrl: string, key: string): string {
  return `from anthropic import Anthropic

client = Anthropic(
    base_url="${baseUrl}/api",
    api_key="${key}",
)

stream = client.messages.create(
    model="glm-5.3-flash",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Write a haiku about APIs."}],
    stream=True,
)
for event in stream:
    if event.type == "content_block_delta" and event.delta.type == "text_delta":
        print(event.delta.text, end="")`;
}

// ─── Agent integration snippets ──────────────────────────────────────────────

export function claudeCodeEnv(baseUrl: string, key: string): string {
  return `# Claude Code — point it at EmorAI (Anthropic-compatible)
export ANTHROPIC_BASE_URL="${baseUrl}/api"
export ANTHROPIC_API_KEY="${key}"
export ANTHROPIC_MODEL="glm-5.3-flash"
# Optional: a lighter model for background tasks
export ANTHROPIC_SMALL_FAST_MODEL="glm-5.3-flash"

# Then just run:
claude`;
}

export function claudeCodeSettingsJson(baseUrl: string, key: string): string {
  return `# ~/.claude/settings.json (alternative to env vars)
{
  "env": {
    "ANTHROPIC_BASE_URL": "${baseUrl}/api",
    "ANTHROPIC_API_KEY": "${key}",
    "ANTHROPIC_MODEL": "glm-5.3-flash"
  }
}`;
}

export function zcodeProviderConfig(baseUrl: string, key: string): string {
  return `# ZCode — Add Provider (OpenAI-compatible)
#   API Base URL:  ${baseUrl}/api/v1
#   API Format:    OpenAI-compatible
#   API Key:       ${key}
#   Model ID:      glm-5.3-flash   (see "Available models" for the full list)

# Anthropic-format provider in ZCode works identically:
#   API Base URL:  ${baseUrl}/api
#   API Format:    Anthropic-compatible
#   Model ID:      glm-5.3-flash`;
}

export function openClawConfig(baseUrl: string, key: string): string {
  return `# OpenClaw / AutoClaw — custom OpenAI-compatible provider
# Provider settings:
#   Base URL:  ${baseUrl}/api/v1
#   API Key:   ${key}
#   Model:     glm-5.3-flash
#
# Model discovery: GET ${baseUrl}/api/v1/models
#   curl ${baseUrl}/api/v1/models -H "Authorization: Bearer ${key}"
#
# Streaming is supported end-to-end (SSE).`;
}

export function genericOpenAiSdk(baseUrl: string, key: string): string {
  return `# Any OpenAI SDK / app — EmorAI as a drop-in provider
OPENAI_BASE_URL="${baseUrl}/api/v1"
OPENAI_API_KEY="${key}"
# Works with: Continue.dev, Aider, Cline, LibreChat, Open WebUI,
# LangChain, LlamaIndex, and every tool that accepts a custom base URL.`;
}

// ─── Language-tabbed snippet panel ────────────────────────────────────────────

export function LangSnippetTabs({
  snippets,
}: {
  snippets: { curl: string; javascript: string; python: string };
}) {
  return (
    <Tabs defaultValue="curl" className="w-full">
      <TabsList className="h-8">
        <TabsTrigger value="curl" className="h-6 px-3 text-xs">
          cURL
        </TabsTrigger>
        <TabsTrigger value="javascript" className="h-6 px-3 text-xs">
          JavaScript
        </TabsTrigger>
        <TabsTrigger value="python" className="h-6 px-3 text-xs">
          Python
        </TabsTrigger>
      </TabsList>
      <TabsContent value="curl" className="mt-2">
        <CodeBlock code={snippets.curl} title="curl" />
      </TabsContent>
      <TabsContent value="javascript" className="mt-2">
        <CodeBlock code={snippets.javascript} title="javascript" />
      </TabsContent>
      <TabsContent value="python" className="mt-2">
        <CodeBlock code={snippets.python} title="python" />
      </TabsContent>
    </Tabs>
  );
}

// ─── Misc shared bits ─────────────────────────────────────────────────────────

export function EndpointPath({ path }: { path: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{path}</code>;
}

export function OkBadge({
  children,
  tone = 'emerald',
}: {
  children: string;
  tone?: 'emerald' | 'red' | 'muted';
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 text-xs',
        tone === 'emerald' &&
          'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
        tone === 'red' && 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400',
        tone === 'muted' && 'text-muted-foreground'
      )}
    >
      {children}
    </Badge>
  );
}
