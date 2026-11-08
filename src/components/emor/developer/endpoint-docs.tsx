'use client';

import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  CodeBlock,
  EndpointPath,
  HttpMethod,
  MethodBadge,
  curlAnthropicMessages,
  curlChatCompletions,
  curlCountTokens,
  curlImages,
  curlModels,
  curlSpeech,
  curlUsage,
  curlVideoCreate,
  curlVideoPoll,
} from './snippets';

// ─── Doc types ────────────────────────────────────────────────────────────────

type FieldDoc = {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
};

type EndpointDoc = {
  method: HttpMethod;
  path: string;
  title: string;
  desc: string;
  body?: FieldDoc[];
  response: string;
  curl: (baseUrl: string) => string;
  extra?: React.ReactNode;
};

// ─── Endpoint definitions (verified against src/app/api/v1/*) ─────────────────

const ERROR_EXAMPLE = `{
  "error": {
    "message": "API key \\"my-key\\" has been revoked.",
    "type": "authentication_error",
    "code": "key_revoked"
  }
}`;

const CHAT_RESPONSE = `{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1717000000,
  "model": "glm-5.3-flash",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "…" },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 21,
    "completion_tokens": 42,
    "total_tokens": 63
  }
}`;

const MODELS_RESPONSE = `{
  "object": "list",
  "data": [
    {
      "id": "glm-5.3-flash",
      "object": "model",
      "created": 1717000000,
      "owned_by": "zai",
      "display_name": "GLM-5.3 Flash",
      "description": "…",
      "capabilities": { "vision": false, "tools": true },
      "free_tier": true,
      "last_status": "healthy"
    }
  ]
}`;

const USAGE_RESPONSE = `{
  "object": "usage_report",
  "api_key": { "name": "my-python-app" },
  "window_days": 7,
  "totals": {
    "requests": 128,
    "failed": 2,
    "prompt_tokens": 15420,
    "completion_tokens": 23110,
    "total_tokens": 38530
  },
  "by_model": [{ "model_id": "glm-5.3-flash", "requests": 120, "total_tokens": 36000 }],
  "recent": [
    {
      "id": "…",
      "model_id": "glm-5.3-flash",
      "served_model": "glm-5.3-flash",
      "prompt_tokens": 120,
      "completion_tokens": 180,
      "total_tokens": 300,
      "success": true,
      "created": "2025-01-01T12:00:00.000Z"
    }
  ]
}`;

const IMAGES_RESPONSE = `{
  "created": 1717000000,
  "data": [{ "b64_json": "<base64 PNG bytes>" }]
}`;

const VIDEO_CREATE_RESPONSE = `{
  "id": "video-task-…",
  "request_id": null,
  "model": "zai-video",
  "task_status": "PROCESSING"
}`;

const VIDEO_POLL_RESPONSE = `{
  "id": "video-task-…",
  "task_status": "SUCCESS",
  "video_result": [{ "url": "https://…/video.mp4" }]
}`;

const ANTHROPIC_MESSAGES_RESPONSE = `{
  "id": "msg-…",
  "type": "message",
  "role": "assistant",
  "model": "glm-5.3-flash",
  "content": [
    { "type": "text", "text": "…" },
    { "type": "tool_use", "id": "toolu-…", "name": "get_weather", "input": { "city": "Paris" } }
  ],
  "stop_reason": "end_turn",        // end_turn | tool_use | max_tokens
  "stop_sequence": null,
  "usage": { "input_tokens": 27, "output_tokens": 42 },
  "emorai_served_model": "glm-4-plus"
}`;

const ANTHROPIC_STREAM_SAMPLE = `event: message_start
data: {"type":"message_start","message":{"id":"msg-…","role":"assistant",…}}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}

event: message_stop
data: {"type":"message_stop"}`;

const COUNT_TOKENS_RESPONSE = `{ "input_tokens": 14 }`;

const ENDPOINTS: EndpointDoc[] = [
  {
    method: 'POST',
    path: '/api/v1/chat/completions',
    title: 'Chat completions',
    desc: 'OpenAI-compatible chat. Returns a full completion object, or an SSE chunk stream when "stream" is true (terminates with data: [DONE]).',
    body: [
      { name: 'model', type: 'string', required: true, desc: 'Model ID from GET /api/v1/models.' },
      {
        name: 'messages',
        type: 'array',
        required: true,
        desc: 'system | user | assistant | tool messages. Content is a string or an array of {type: "text" | "image_url"} parts (image parts need a vision-capable model). Assistant turns may carry tool_calls; tool responses use role "tool" + tool_call_id — full agent round-trips are supported.',
      },
      { name: 'stream', type: 'boolean', desc: 'Stream SSE chunks. Default false.' },
      { name: 'temperature', type: 'number', desc: '0 – 2. Defaults to the installation setting.' },
      { name: 'max_tokens', type: 'integer', desc: 'Clamped to the model’s max output tokens.' },
      { name: 'top_p', type: 'number', desc: '0 – 1 nucleus sampling.' },
      { name: 'stop', type: 'string | string[]', desc: 'Up to 16 stop sequences.' },
      {
        name: 'tools',
        type: 'array',
        desc: 'OpenAI function tools [{type:"function", function:{name, description, parameters}}]. finish_reason "tool_calls" + message.tool_calls stream back; needs a tools-capable model.',
      },
      { name: 'tool_choice', type: 'string | object', desc: '"auto" | "none" | "required" | {type:"function", function:{name}}.' },
      { name: 'stream_options', type: 'object', desc: '{include_usage: true} appends a final usage chunk.' },
    ],
    response: CHAT_RESPONSE,
    curl: (base) => curlChatCompletions(base, '$EMOR_API_KEY', true),
  },
  {
    method: 'GET',
    path: '/api/v1/models',
    title: 'List models',
    desc: 'OpenAI-compatible model listing for this installation, including capabilities and health. Also mounted at /v1/models.',
    response: MODELS_RESPONSE,
    curl: (base) => curlModels(base, '$EMOR_API_KEY'),
  },
  {
    method: 'POST',
    path: '/api/v1/messages',
    title: 'Anthropic Messages (Claude Code compatible)',
    desc: 'Full Anthropic Messages API protocol translation: content blocks, system prompts, tool_use / tool_result round-trips and streaming SSE events. Also mounted at /v1/messages — Claude Code works with ANTHROPIC_BASE_URL={origin}/api.',
    body: [
      { name: 'model', type: 'string', required: true, desc: 'EmorAI model ID (e.g. glm-5.3-flash).' },
      {
        name: 'messages',
        type: 'array',
        required: true,
        desc: 'user/assistant turns. Content is a string or block array: text, image (base64 or url), tool_use, tool_result. First message must be role "user".',
      },
      { name: 'max_tokens', type: 'integer', desc: 'Defaults to the model limit. Clamped to the registry max output.' },
      { name: 'system', type: 'string | blocks', desc: 'System prompt (string or [{type:"text",text}] array).' },
      { name: 'stream', type: 'boolean', desc: 'Emit the Anthropic SSE event sequence. Default false.' },
      {
        name: 'tools',
        type: 'array',
        desc: '[{ name, description, input_schema }] — translated to provider function calling; tool_use blocks stream back as input_json_delta.',
      },
      { name: 'tool_choice', type: 'object', desc: '{type:"auto"|"any"|"tool", name?}.' },
      { name: 'temperature / top_p / top_k', type: 'number', desc: 'Sampling controls, forwarded upstream.' },
      { name: 'stop_sequences', type: 'string[]', desc: 'Up to 16 stop sequences.' },
    ],
    response: ANTHROPIC_MESSAGES_RESPONSE,
    curl: (base) => curlAnthropicMessages(base, '$EMOR_API_KEY', false),
    extra: (
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Streaming event sequence
        </p>
        <CodeBlock title="sse" code={ANTHROPIC_STREAM_SAMPLE} />
      </div>
    ),
  },
  {
    method: 'POST',
    path: '/api/v1/messages/count_tokens',
    title: 'Count tokens (Anthropic)',
    desc: 'Token estimation for a Messages payload — Claude Code calls this before dispatching large requests.',
    body: [
      { name: 'model', type: 'string', required: true, desc: 'EmorAI model ID.' },
      { name: 'messages', type: 'array', required: true, desc: 'Same message shape as /v1/messages.' },
      { name: 'system / tools', type: '—', desc: 'Included in the estimate when present.' },
    ],
    response: COUNT_TOKENS_RESPONSE,
    curl: (base) => curlCountTokens(base, '$EMOR_API_KEY'),
  },
  {
    method: 'GET',
    path: '/api/v1/usage?days=7',
    title: 'Usage report',
    desc: 'Per-key usage report. days (1 – 365, default 30) scopes the window; up to 300 records are aggregated, 50 returned in "recent".',
    body: [
      { name: 'days', type: 'query integer', desc: 'Window size in days. Default 30, max 365.' },
    ],
    response: USAGE_RESPONSE,
    curl: (base) => curlUsage(base, '$EMOR_API_KEY'),
  },
  {
    method: 'POST',
    path: '/api/v1/images/generations',
    title: 'Image generations',
    desc: 'OpenAI-compatible image generation. Images are returned base64-encoded.',
    body: [
      { name: 'prompt', type: 'string', required: true, desc: '3 – 4000 characters.' },
      {
        name: 'size',
        type: 'string',
        desc: '1024x1024 (default), 768x1344, 864x1152, 1344x768, 1152x864, 1440x720, 720x1440.',
      },
      { name: 'n', type: 'integer', desc: '1 – 4 images. Default 1.' },
      { name: 'model', type: 'string', desc: 'Optional model override (recorded in usage).' },
    ],
    response: IMAGES_RESPONSE,
    curl: (base) => curlImages(base, '$EMOR_API_KEY'),
  },
  {
    method: 'POST',
    path: '/api/v1/audio/speech',
    title: 'Text to speech',
    desc: 'OpenAI-compatible speech synthesis. Responds with binary audio (audio/mpeg), not JSON.',
    body: [
      { name: 'input', type: 'string', required: true, desc: '1 – 8000 characters of text.' },
      {
        name: 'voice',
        type: 'string',
        desc: 'tongtong (default), xiaochen, chuichui, xiaoxiao, doudou.',
      },
      { name: 'speed', type: 'number', desc: '0.5 – 2. Default 1.' },
    ],
    response: `200 OK
Content-Type: audio/mpeg
<body: binary audio stream>`,
    curl: (base) => curlSpeech(base, '$EMOR_API_KEY'),
  },
  {
    method: 'POST',
    path: '/api/v1/videos/generations',
    title: 'Video generations (submit task)',
    desc: 'Async video generation. Returns a task id immediately; poll GET /api/v1/videos/generations/{task_id} until task_status is SUCCESS.',
    body: [
      { name: 'prompt', type: 'string', required: true, desc: '3 – 4000 characters.' },
      { name: 'quality', type: 'string', desc: '"speed" (default) or "quality".' },
      { name: 'with_audio', type: 'boolean', desc: 'Generate an audio track. Default false.' },
      { name: 'duration', type: 'integer', desc: '5 – 10 seconds.' },
    ],
    response: VIDEO_CREATE_RESPONSE,
    curl: (base) => curlVideoCreate(base, '$EMOR_API_KEY'),
  },
  {
    method: 'GET',
    path: '/api/v1/videos/generations/{task_id}',
    title: 'Video task status',
    desc: 'Poll a video task. task_status is PROCESSING, SUCCESS or FAIL; video_result appears only on success.',
    response: VIDEO_POLL_RESPONSE,
    curl: (base) => curlVideoPoll(base, '$EMOR_API_KEY'),
  },
];

// ─── Sub-sections ─────────────────────────────────────────────────────────────

function AuthCard() {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
          Authentication
        </CardTitle>
        <CardDescription>
          Every gateway request needs an EmorAI key — Bearer (OpenAI-style) or x-api-key
          (Anthropic-style). Both work on every endpoint.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <CodeBlock
          title="headers"
          code={'Authorization: Bearer emr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n# or (Anthropic clients):\nx-api-key: emr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'}
        />
        <p className="text-sm text-muted-foreground">
          Two mounts, one gateway: <code className="font-mono text-xs">/api/v1/*</code> (canonical)
          and <code className="font-mono text-xs">/v1/*</code> (for clients that append /v1
          themselves). CORS is open on all gateway routes — Bearer keys, no cookies.
        </p>
        <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
          <li>
            Keys are stored hashed — the plaintext is shown exactly once at creation time.
          </li>
          <li>
            Revoked or deleted keys fail immediately with{' '}
            <code className="font-mono text-xs">401 key_revoked</code>.
          </li>
          <li>
            Each key is rate-limited per minute (installation setting, default 60 req/min). Exceeding
            it returns <code className="font-mono text-xs">429 rate_limited</code> with a{' '}
            <code className="font-mono text-xs">Retry-After</code> header.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

function ErrorCard() {
  const codes: { status: string; code: string; meaning: string }[] = [
    { status: '401', code: 'missing_api_key', meaning: 'No Authorization / x-api-key header was sent.' },
    { status: '401', code: 'invalid_api_key', meaning: 'Key is malformed or unknown.' },
    { status: '401', code: 'key_revoked', meaning: 'Key was revoked or deleted.' },
    { status: '403', code: 'insufficient_scope', meaning: 'Key lacks the scope for this call (chat/tools/vision/media).' },
    { status: '403', code: 'model_not_allowed', meaning: 'Model is not on the key’s allowed-models list.' },
    { status: '429', code: 'rate_limited', meaning: 'Per-key rate limit exceeded; retry later.' },
    { status: '429', code: 'monthly_request_limit_exceeded', meaning: 'Monthly request budget for this key is used up.' },
    { status: '429', code: 'monthly_token_limit_exceeded', meaning: 'Monthly token budget for this key is used up.' },
    { status: '404', code: 'model_not_found', meaning: 'Unknown model id — the error lists available models.' },
    { status: '409', code: 'model_disabled', meaning: 'Model exists but is disabled by the admin.' },
    { status: '400', code: 'tools_not_supported / vision_not_supported', meaning: 'Capability gate: the selected model lacks tools/vision.' },
  ];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="size-4 text-red-600 dark:text-red-400" />
          Errors
        </CardTitle>
        <CardDescription>
          All failures return a consistent JSON envelope with a non-2xx status.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CodeBlock title="error envelope" code={ERROR_EXAMPLE} />
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>code</TableHead>
                <TableHead>Meaning</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.map((c) => (
                <TableRow key={c.code}>
                  <TableCell className="font-mono text-xs">{c.status}</TableCell>
                  <TableCell>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                      {c.code}
                    </code>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{c.meaning}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <p className="text-sm text-muted-foreground">
          Provider-side failures surface as{' '}
          <code className="font-mono text-xs">502</code> with{' '}
          <code className="font-mono text-xs">type: &quot;provider_error&quot;</code>; malformed
          payloads as <code className="font-mono text-xs">400 invalid_request</code>.
        </p>
      </CardContent>
    </Card>
  );
}

function EndpointCard({ doc, origin }: { doc: EndpointDoc; origin: string }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <MethodBadge method={doc.method} />
          <EndpointPath path={doc.path} />
          <span className="text-sm font-medium">{doc.title}</span>
        </div>
        <CardDescription>{doc.desc}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {doc.body && doc.body.length > 0 ? (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Field</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="w-1/2">Description</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {doc.body.map((f) => (
                  <TableRow key={f.name}>
                    <TableCell className="whitespace-nowrap font-mono text-xs">
                      {f.name}
                      {f.required ? (
                        <span className="ml-1 text-red-600 dark:text-red-400">*</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                      {f.type}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{f.desc}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Response
          </p>
          <CodeBlock title="json" code={doc.response} />
        </div>
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Example
          </p>
          <CodeBlock title="curl" code={doc.curl(origin || 'http://localhost:3000')} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Exported API Reference tab ───────────────────────────────────────────────

export function EndpointDocs({ origin }: { origin: string }) {
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <AuthCard />
      <div className="space-y-4">
        {ENDPOINTS.map((doc) => (
          <EndpointCard key={`${doc.method} ${doc.path}`} doc={doc} origin={origin} />
        ))}
      </div>
      <ErrorCard />
    </div>
  );
}
