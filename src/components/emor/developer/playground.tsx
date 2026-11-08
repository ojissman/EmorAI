'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AudioLines,
  KeyRound,
  Loader2,
  Lock,
  MessageSquare,
  Play,
  RefreshCw,
  Square,
  Terminal,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CopyButton, MethodBadge } from './snippets';
import {
  clearPlaygroundKey,
  getPlaygroundKey,
  getPlaygroundKeyServerSnapshot,
  storePlaygroundKey,
  subscribePlaygroundKey,
} from './key-vault';
import { cn } from '@/lib/utils';

// ─── Endpoint configuration ───────────────────────────────────────────────────

type EndpointKind = 'chat' | 'anthropic' | 'json' | 'audio' | 'video';

type PlaygroundEndpoint = {
  id: string;
  label: string;
  method: 'GET' | 'POST';
  path: string;
  kind: EndpointKind;
  defaultBody: string | null;
};

const PLAYGROUND_ENDPOINTS: PlaygroundEndpoint[] = [
  {
    id: 'chat',
    label: 'Chat completions',
    method: 'POST',
    path: '/api/v1/chat/completions',
    kind: 'chat',
    defaultBody: JSON.stringify(
      {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Write a haiku about APIs.' },
        ],
      },
      null,
      2
    ),
  },
  {
    id: 'anthropic-messages',
    label: 'Anthropic messages',
    method: 'POST',
    path: '/api/v1/messages',
    kind: 'anthropic',
    defaultBody: JSON.stringify(
      {
        model: 'glm-5.3-flash',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Write a haiku about APIs.' }],
      },
      null,
      2
    ),
  },
  {
    id: 'count-tokens',
    label: 'Anthropic count_tokens',
    method: 'POST',
    path: '/api/v1/messages/count_tokens',
    kind: 'json',
    defaultBody: JSON.stringify(
      {
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'Estimate my tokens.' }],
      },
      null,
      2
    ),
  },
  {
    id: 'models',
    label: 'List models',
    method: 'GET',
    path: '/api/v1/models',
    kind: 'json',
    defaultBody: null,
  },
  {
    id: 'images',
    label: 'Image generations',
    method: 'POST',
    path: '/api/v1/images/generations',
    kind: 'json',
    defaultBody: JSON.stringify(
      {
        prompt: 'A cozy cabin in a snowy forest at dusk, warm light in the windows',
        size: '1024x1024',
        n: 1,
      },
      null,
      2
    ),
  },
  {
    id: 'speech',
    label: 'Text to speech',
    method: 'POST',
    path: '/api/v1/audio/speech',
    kind: 'audio',
    defaultBody: JSON.stringify(
      { input: 'Welcome to EmorAI — your personal AI platform.', voice: 'tongtong', speed: 1 },
      null,
      2
    ),
  },
  {
    id: 'videos',
    label: 'Video generations',
    method: 'POST',
    path: '/api/v1/videos/generations',
    kind: 'video',
    defaultBody: JSON.stringify(
      {
        prompt: 'A timelapse of clouds rolling over mountain peaks at sunrise',
        quality: 'speed',
        with_audio: false,
        duration: 5,
      },
      null,
      2
    ),
  },
  {
    id: 'usage',
    label: 'Usage (last 7 days)',
    method: 'GET',
    path: '/api/v1/usage?days=7',
    kind: 'json',
    defaultBody: null,
  },
];

// ─── unknown → data guards (no any) ──────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

function extractChunk(v: unknown): { content: string | null; finish: string | null; error: string | null } {
  const out: { content: string | null; finish: string | null; error: string | null } = {
    content: null,
    finish: null,
    error: null,
  };
  if (!isRecord(v)) return out;
  if (isRecord(v.error) && typeof v.error.message === 'string') out.error = v.error.message;
  if (Array.isArray(v.choices)) {
    const first: unknown = v.choices[0];
    if (isRecord(first)) {
      if (typeof first.finish_reason === 'string') out.finish = first.finish_reason;
      if (isRecord(first.delta) && typeof first.delta.content === 'string') {
        out.content = first.delta.content;
      }
    }
  }
  return out;
}

function extractAnthropicChunk(v: unknown): { content: string | null; finish: string | null; error: string | null } {
  const out: { content: string | null; finish: string | null; error: string | null } = {
    content: null,
    finish: null,
    error: null,
  };
  if (!isRecord(v)) return out;
  if (v.type === 'error' && isRecord(v.error) && typeof v.error.message === 'string') {
    out.error = v.error.message;
    return out;
  }
  if (v.type === 'content_block_delta' && isRecord(v.delta) && typeof v.delta.text === 'string') {
    out.content = v.delta.text;
  }
  if (v.type === 'message_delta' && isRecord(v.delta) && typeof v.delta.stop_reason === 'string') {
    out.finish = v.delta.stop_reason;
  }
  return out;
}

function extractVideoUrl(v: unknown): string | null {
  if (!isRecord(v) || !Array.isArray(v.video_result)) return null;
  for (const item of v.video_result) {
    if (isRecord(item) && typeof item.url === 'string') return item.url;
  }
  return null;
}

function extractTaskId(v: unknown): string | null {
  if (!isRecord(v) || typeof v.id !== 'string') return null;
  const status = typeof v.task_status === 'string' ? v.task_status : '';
  return status.toUpperCase() === 'PROCESSING' || status.toUpperCase() === 'SUCCESS' ? v.id : null;
}

// ─── Response view model ──────────────────────────────────────────────────────

type ResponseView =
  | { kind: 'json'; status: number; ok: boolean; latencyMs: number; body: unknown }
  | { kind: 'audio'; status: number; latencyMs: number; url: string; mime: string; bytes: number }
  | {
      kind: 'stream';
      status: number;
      latencyMs: number;
      text: string;
      finish: string | null;
      err: string | null;
    }
  | { kind: 'request-error'; message: string };

// ─── Key vault ────────────────────────────────────────────────────────────────

function KeyVault({
  savedKey,
  onSave,
  onClear,
}: {
  savedKey: string;
  onSave: (key: string) => void;
  onClear: () => void;
}) {
  const [input, setInput] = useState('');
  const preview = savedKey
    ? savedKey.length > 8
      ? `${savedKey.slice(0, 4)}••••${savedKey.slice(-4)}`
      : 'saved'
    : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" />
          Playground key
        </CardTitle>
        <CardDescription>
          Keys are hashed server-side, so the playground keeps yours in this browser&apos;s
          localStorage. It only ever travels in the Authorization header to your own EmorAI server.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex max-w-md gap-2">
          <Input
            type="password"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onSave(input);
            }}
            placeholder="emr_…"
            aria-label="API key for the playground"
            autoComplete="off"
          />
          <Button onClick={() => onSave(input)} className="gap-1.5">
            <Lock className="size-4" />
            Save locally
          </Button>
        </div>
        <div className="flex items-center gap-2 text-sm">
          {savedKey ? (
            <>
              <Badge
                variant="outline"
                className="border-emerald-500/20 bg-emerald-500/10 font-mono text-emerald-600 dark:text-emerald-400"
              >
                {preview}
              </Badge>
              <span className="text-muted-foreground">saved in localStorage</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground"
                onClick={onClear}
              >
                <Trash2 className="size-3.5" /> Remove
              </Button>
            </>
          ) : (
            <span className="text-muted-foreground">
              No key saved yet — create one in the Overview tab, then paste it here.
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Response rendering ───────────────────────────────────────────────────────

function StatusBadge({ status, ok }: { status: number; ok: boolean }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono',
        ok
          ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
          : 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
      )}
    >
      {status} {ok ? 'OK' : 'ERROR'}
    </Badge>
  );
}

function LatencyBadge({ ms }: { ms: number }) {
  return (
    <Badge variant="outline" className="font-mono text-muted-foreground">
      {Math.round(ms)} ms
    </Badge>
  );
}

function ResponsePanel({
  response,
  streaming,
}: {
  response: ResponseView | null;
  streaming: boolean;
}) {
  if (!response) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-16 text-center">
        <Terminal className="size-8 text-muted-foreground/50" />
        <p className="text-sm text-muted-foreground">
          Send a request to see the response here.
        </p>
      </div>
    );
  }

  if (response.kind === 'request-error') {
    return (
      <Alert variant="destructive">
        <AlertDescription className="font-mono text-xs">{response.message}</AlertDescription>
      </Alert>
    );
  }

  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <StatusBadge status={response.status} ok={response.kind !== 'json' || response.ok} />
      <LatencyBadge ms={response.latencyMs} />
      {response.kind === 'stream' ? (
        <Badge variant="outline" className="font-mono text-muted-foreground">
          text/event-stream
        </Badge>
      ) : null}
      {response.kind === 'audio' ? (
        <Badge variant="outline" className="font-mono text-muted-foreground">
          {response.mime} · {(response.bytes / 1024).toFixed(1)} KB
        </Badge>
      ) : null}
    </div>
  );

  if (response.kind === 'audio') {
    return (
      <div className="space-y-3">
        {header}
        <audio controls src={response.url} className="w-full" />
        <a
          href={response.url}
          download={`emorai-speech${response.mime.includes('wav') ? '.wav' : '.mp3'}`}
          className="inline-flex items-center gap-1.5 text-sm text-violet-600 underline-offset-4 hover:underline dark:text-violet-400"
        >
          <AudioLines className="size-4" /> Download audio
        </a>
      </div>
    );
  }

  if (response.kind === 'stream') {
    return (
      <div className="space-y-3">
        {header}
        <pre
          className={cn(
            'max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed',
            streaming && 'border-violet-500/30'
          )}
        >
          {response.text || 'Waiting for tokens…'}
        </pre>
        {response.err ? (
          <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 font-mono text-xs text-red-600 dark:text-red-400">
            {response.err}
          </p>
        ) : null}
        {!streaming ? (
          <Badge
            variant="outline"
            className={cn(
              'font-mono',
              response.err
                ? 'border-red-500/20 bg-red-500/10 text-red-600 dark:text-red-400'
                : 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            )}
          >
            stream finished{response.finish ? ` · finish_reason: ${response.finish}` : ''}
          </Badge>
        ) : null}
      </div>
    );
  }

  // json
  return (
    <div className="space-y-3">
      {header}
      <pre
        className={cn(
          'max-h-[420px] overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs leading-relaxed',
          response.ok
            ? 'border-border bg-muted/40'
            : 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
        )}
      >
        {pretty(response.body)}
      </pre>
    </div>
  );
}

// ─── Main playground ──────────────────────────────────────────────────────────

export function Playground({ origin }: { origin: string }) {
  // Hydration-safe localStorage key vault (updates live when saved/cleared).
  const savedKey = useSyncExternalStore(
    subscribePlaygroundKey,
    getPlaygroundKey,
    getPlaygroundKeyServerSnapshot
  );
  const [endpointId, setEndpointId] = useState<string>(PLAYGROUND_ENDPOINTS[0].id);
  const [bodyText, setBodyText] = useState<string>(PLAYGROUND_ENDPOINTS[0].defaultBody ?? '');
  const [stream, setStream] = useState(false);
  const [sending, setSending] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [response, setResponse] = useState<ResponseView | null>(null);
  const [videoTaskId, setVideoTaskId] = useState<string | null>(null);
  const [pollView, setPollView] = useState<{ ok: boolean; status: number; latencyMs: number; body: unknown } | null>(null);
  const [polling, setPolling] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const endpoint = useMemo(
    () => PLAYGROUND_ENDPOINTS.find((e) => e.id === endpointId) ?? PLAYGROUND_ENDPOINTS[0],
    [endpointId]
  );

  useEffect(() => {
    return () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  function saveKey(raw: string) {
    const key = raw.trim();
    if (!key) {
      toast.error('Paste a key first (they look like emr_…)');
      return;
    }
    storePlaygroundKey(key);
    toast.success('Key saved locally — it never leaves this browser except as an auth header');
  }

  function clearKey() {
    clearPlaygroundKey();
    toast.success('Local key removed');
  }

  function selectEndpoint(id: string) {
    setEndpointId(id);
    const next = PLAYGROUND_ENDPOINTS.find((e) => e.id === id);
    setBodyText(next?.defaultBody ?? '');
    setResponse(null);
    setPollView(null);
    setVideoTaskId(null);
  }

  function buildCurl(): string {
    const base = origin || 'http://localhost:3000';
    const url = `${base}${endpoint.path}`;
    const auth =
      endpoint.kind === 'anthropic'
        ? `  -H "x-api-key: ${savedKey || 'emr_YOUR_KEY'}" \\\n  -H "anthropic-version: 2023-06-01"`
        : `  -H "Authorization: Bearer ${savedKey || 'emr_YOUR_KEY'}"`;
    if (endpoint.method === 'GET') {
      return `curl "${url}" \\\n${auth}`;
    }
    let body = bodyText;
    if (endpoint.kind === 'chat' || endpoint.kind === 'anthropic') {
      try {
        const parsed: unknown = JSON.parse(bodyText || '{}');
        body = JSON.stringify({ ...(isRecord(parsed) ? parsed : {}), stream }, null, 2);
      } catch {
        // keep raw body text
      }
    }
    const escaped = body.replace(/'/g, `'\\''`);
    return `curl ${url} \\\n${auth} \\\n  -H "Content-Type: application/json" \\\n  -d '${escaped}'`;
  }

  async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  async function runStream(key: string, bodyObj: Record<string, unknown>, signal: AbortSignal) {
    const t0 = performance.now();
    let text = '';
    let finish: string | null = null;
    let err: string | null = null;
    let status = 0;
    try {
      const res = await fetch(endpoint.path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        signal,
      });
      status = res.status;
      if (!res.ok || !res.body) {
        const body = await readBody(res);
        setResponse({ kind: 'json', status, ok: false, latencyMs: performance.now() - t0, body });
        return;
      }
      setStreaming(true);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6);
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as unknown;
              const chunk = endpoint.kind === 'anthropic' ? extractAnthropicChunk(parsed) : extractChunk(parsed);
              if (chunk.content) text += chunk.content;
              if (chunk.finish) finish = chunk.finish;
              if (chunk.error) err = chunk.error;
            } catch {
              // skip malformed frame
            }
          }
        }
        setResponse({
          kind: 'stream',
          status,
          latencyMs: performance.now() - t0,
          text,
          finish,
          err,
        });
      }
      setResponse({
        kind: 'stream',
        status,
        latencyMs: performance.now() - t0,
        text,
        finish,
        err,
      });
      toast.success('Stream finished');
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        setResponse({
          kind: 'stream',
          status,
          latencyMs: performance.now() - t0,
          text: text || '(aborted)',
          finish: 'aborted',
          err,
        });
        return;
      }
      setResponse({
        kind: 'request-error',
        message: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      toast.error('Request failed before receiving a response');
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  async function send() {
    if (!savedKey) {
      toast.error('Save a playground key first');
      return;
    }
    let bodyObj: Record<string, unknown> = {};
    if (endpoint.method === 'POST') {
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (!isRecord(parsed)) throw new Error('Body must be a JSON object');
        bodyObj = parsed;
      } catch (e) {
        toast.error(
          e instanceof Error && e.message === 'Body must be a JSON object'
            ? 'Body must be a valid JSON object'
            : 'Body is not valid JSON — fix it before sending'
        );
        return;
      }
    }
    if (endpoint.kind === 'chat' || endpoint.kind === 'anthropic') bodyObj = { ...bodyObj, stream };

    if ((endpoint.kind === 'chat' || endpoint.kind === 'anthropic') && stream) {
      const controller = new AbortController();
      abortRef.current = controller;
      setSending(true);
      setPollView(null);
      await runStream(savedKey, bodyObj, controller.signal);
      setSending(false);
      return;
    }

    setSending(true);
    setPollView(null);
    const t0 = performance.now();
    try {
      const res = await fetch(endpoint.path, {
        method: endpoint.method,
        headers: {
          Authorization: `Bearer ${savedKey}`,
          ...(endpoint.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(endpoint.method === 'POST' ? { body: JSON.stringify(bodyObj) } : {}),
      });
      const latencyMs = performance.now() - t0;

      if (endpoint.kind === 'audio') {
        const mime = res.headers.get('content-type') ?? 'audio/mpeg';
        if (res.ok && mime.startsWith('audio/')) {
          const blob = await res.blob();
          if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
          const url = URL.createObjectURL(blob);
          audioUrlRef.current = url;
          setResponse({ kind: 'audio', status: res.status, latencyMs, url, mime, bytes: blob.size });
          toast.success(`Audio ready (${(blob.size / 1024).toFixed(1)} KB)`);
        } else {
          const body = await readBody(res);
          setResponse({ kind: 'json', status: res.status, ok: false, latencyMs, body });
        }
        return;
      }

      const body = await readBody(res);
      setResponse({ kind: 'json', status: res.status, ok: res.ok, latencyMs, body });
      if (res.ok && endpoint.kind === 'video') {
        setVideoTaskId(extractTaskId(body));
        setPollView(null);
        toast.success(`Task submitted: ${extractTaskId(body) ?? 'unknown id'}`);
      } else if (res.status === 401 || res.status === 429 || res.status === 409) {
        toast.error(`Request failed with ${res.status}`);
      }
    } catch (e) {
      setResponse({
        kind: 'request-error',
        message: `Network error: ${e instanceof Error ? e.message : String(e)}`,
      });
      toast.error('Request failed before receiving a response');
    } finally {
      setSending(false);
    }
  }

  async function pollTask() {
    if (!videoTaskId || !savedKey) return;
    setPolling(true);
    const t0 = performance.now();
    try {
      const res = await fetch(
        `/api/v1/videos/generations/${encodeURIComponent(videoTaskId)}`,
        { headers: { Authorization: `Bearer ${savedKey}` } }
      );
      const body = await readBody(res);
      setPollView({
        ok: res.ok,
        status: res.status,
        latencyMs: performance.now() - t0,
        body,
      });
      if (res.ok) {
        const status = isRecord(body) && typeof body.task_status === 'string' ? body.task_status : '';
        if (status === 'SUCCESS') toast.success('Video task succeeded');
        else toast.message(`Task status: ${status || 'unknown'}`);
      } else {
        toast.error(`Poll failed with ${res.status}`);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Poll request failed');
    } finally {
      setPolling(false);
    }
  }

  function stopStream() {
    abortRef.current?.abort();
  }

  const busy = sending || streaming;

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <KeyVault savedKey={savedKey} onSave={saveKey} onClear={clearKey} />

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Request column */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="size-4 text-muted-foreground" />
                Request
              </CardTitle>
              <CardDescription>
                Requests go straight from your browser to your own EmorAI server.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="pg-endpoint">Endpoint</Label>
                <Select value={endpointId} onValueChange={selectEndpoint}>
                  <SelectTrigger id="pg-endpoint" className="w-full">
                    <SelectValue placeholder="Choose an endpoint" />
                  </SelectTrigger>
                  <SelectContent>
                    {PLAYGROUND_ENDPOINTS.map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        <span className="flex items-center gap-2">
                          {e.kind === 'chat' || e.kind === 'anthropic' ? (
                            <MessageSquare className="size-3.5 text-muted-foreground" />
                          ) : e.kind === 'audio' ? (
                            <AudioLines className="size-3.5 text-muted-foreground" />
                          ) : e.kind === 'video' ? (
                            <VideoIcon className="size-3.5 text-muted-foreground" />
                          ) : null}
                          <MethodBadge method={e.method} />
                          <span className="font-mono text-xs">{e.path}</span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {endpoint.kind === 'chat' || endpoint.kind === 'anthropic' ? (
                <div className="flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
                  <Switch
                    id="pg-stream"
                    checked={stream}
                    onCheckedChange={setStream}
                    aria-label="Stream response via SSE"
                  />
                  <Label htmlFor="pg-stream" className="cursor-pointer text-sm">
                    Stream (SSE)
                  </Label>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {stream ? 'tokens arrive live' : 'single JSON response'}
                  </span>
                </div>
              ) : null}

              {endpoint.method === 'POST' ? (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="pg-body">Request body (JSON)</Label>
                    <CopyButton value={buildCurl()} label="cURL" />
                  </div>
                  <Textarea
                    id="pg-body"
                    value={bodyText}
                    onChange={(e) => setBodyText(e.target.value)}
                    spellCheck={false}
                    rows={endpoint.kind === 'chat' || endpoint.kind === 'anthropic' ? 9 : 7}
                    className="resize-y font-mono text-xs"
                  />
                </div>
              ) : (
                <p className="rounded-lg border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                  <MethodBadge method="GET" /> request — no request body.{' '}
                  {endpoint.kind === 'json' && endpoint.path.includes('usage')
                    ? 'Reports usage for the presenting key over the last 7 days.'
                    : 'Lists every enabled model on this installation.'}
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void send()} disabled={busy} className="gap-1.5">
                  {sending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Play className="size-4" />
                  )}
                  {sending && !streaming ? 'Sending…' : 'Send'}
                </Button>
                {streaming ? (
                  <Button
                    variant="outline"
                    onClick={stopStream}
                    className="gap-1.5 text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                  >
                    <Square className="size-4" /> Stop
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {endpoint.kind === 'video' && videoTaskId ? (
            <Card className="border-violet-500/20">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Video task</CardTitle>
                <CardDescription>
                  Generation is async — poll until <code className="font-mono text-xs">SUCCESS</code>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                    {videoTaskId}
                  </code>
                  <CopyButton value={videoTaskId} label="Task id" />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void pollTask()}
                    disabled={polling}
                    className="gap-1.5"
                  >
                    {polling ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3.5" />
                    )}
                    Poll status
                  </Button>
                </div>
                {pollView ? (
                  <div className="space-y-2">
                    <StatusBadge status={pollView.status} ok={pollView.ok} />
                    <LatencyBadge ms={pollView.latencyMs} />
                    <pre
                      className={cn(
                        'max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border p-3 font-mono text-xs',
                        pollView.ok
                          ? 'border-border bg-muted/40'
                          : 'border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400'
                      )}
                    >
                      {pretty(pollView.body)}
                    </pre>
                    {pollView.ok && extractVideoUrl(pollView.body) ? (
                      <a
                        href={extractVideoUrl(pollView.body) ?? '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-sm text-violet-600 underline-offset-4 hover:underline dark:text-violet-400"
                      >
                        <VideoIcon className="size-4" /> Open generated video
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        {/* Response column */}
        <Card className="self-start">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Response</CardTitle>
            <CardDescription>
              Status, measured latency and the (pretty-printed) body.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsePanel response={response} streaming={streaming} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
