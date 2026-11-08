'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  AudioLines,
  Ban,
  BookOpen,
  CheckCircle2,
  Image as ImageIcon,
  KeyRound,
  Loader2,
  Play,
  Plus,
  Radio,
  Sparkles,
  Trash2,
  Video,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { useApiKeys } from '@/hooks/use-emor-queries';
import type { SerializedApiKey } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { KeysTable } from './key-manager';
import { Separator } from '@/components/ui/separator';
import {
  CodeBlock,
  CopyButton,
  LangSnippetTabs,
  curlChatCompletions,
  curlModels,
  jsChatCompletions,
  jsModels,
  pyChatCompletions,
  pyModels,
} from './snippets';

// ─── Hero ─────────────────────────────────────────────────────────────────────

function HeroCard({ origin }: { origin: string }) {
  return (
    <Card className="overflow-hidden border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-transparent to-violet-500/10">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <span className="flex size-9 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <Sparkles className="size-5" />
          </span>
          <div>
            <CardTitle className="text-xl">Build with EmorAI</CardTitle>
            <CardDescription>
              A universal AI provider: OpenAI-compatible and Anthropic-compatible in one gateway.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            OpenAI-compatible base URL
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full overflow-x-auto rounded-md border bg-muted/60 px-3 py-1.5 font-mono text-sm">
              {origin ? `${origin}/api/v1` : '/api/v1'}
            </code>
            {origin ? <CopyButton value={`${origin}/api/v1`} label="OpenAI base URL" /> : null}
          </div>
        </div>
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Anthropic-compatible base URL
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full overflow-x-auto rounded-md border bg-muted/60 px-3 py-1.5 font-mono text-sm">
              {origin ? `${origin}/api` : '/api'}
            </code>
            {origin ? <CopyButton value={`${origin}/api`} label="Anthropic base URL" /> : null}
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          Drop either into the matching SDK (<code className="font-mono text-xs">base_url</code> /
          <code className="font-mono text-xs">ANTHROPIC_BASE_URL</code>) and go — streaming, tools
          and model discovery work on both protocols. Full setup guides in the{' '}
          <span className="font-medium text-foreground">Integrations</span> tab.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Quickstart ───────────────────────────────────────────────────────────────

type CreatedKey = { name: string; plaintext: string; prefix: string };

function Quickstart({ origin }: { origin: string }) {
  const qc = useQueryClient();
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedKey | null>(null);

  async function createKey() {
    const name = keyName.trim() || 'Quickstart key';
    setCreating(true);
    try {
      const res = await api.post<{ key: SerializedApiKey; plaintext: string }>('/api/keys', {
        name,
      });
      setCreated({ name: res.key.name, plaintext: res.plaintext, prefix: res.key.prefix });
      setKeyName('');
      toast.success(`API key “${res.key.name}” created`);
      void qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create key');
    } finally {
      setCreating(false);
    }
  }

  const steps = [
    {
      icon: KeyRound,
      title: 'Create a key',
      body: (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Keys are shown once at creation and stored hashed server-side. Optional scopes, rate
            limits and allowed models can be set per key.
          </p>
          <div className="flex max-w-sm gap-2">
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !creating) void createKey();
              }}
              placeholder="Key name (e.g. my-python-app)"
              maxLength={60}
              aria-label="New API key name"
            />
            <Button onClick={() => void createKey()} disabled={creating} className="gap-1.5">
              {creating ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Plus className="size-4" />
              )}
              Create key
            </Button>
          </div>
          {created ? (
            <Alert className="border-emerald-500/30 bg-emerald-500/5">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
              <AlertTitle>
                {created.name} · <code className="font-mono text-xs">{created.prefix}…</code>
              </AlertTitle>
              <AlertDescription>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                    {created.plaintext}
                  </code>
                  <CopyButton value={created.plaintext} label="Plaintext key" />
                </div>
                <p className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-400">
                  Copy it now — this plaintext is never shown again.
                </p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
      ),
    },
    {
      icon: Play,
      title: 'Call an endpoint',
      body: (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Send your key as a Bearer token to any <code className="font-mono text-xs">/api/v1</code>{' '}
            route.
          </p>
          <CodeBlock
            code={curlChatCompletions(origin || 'http://localhost:3000', 'emr_xxxxxxxx', false)}
            title="curl"
            className="max-w-2xl"
          />
        </div>
      ),
    },
    {
      icon: Radio,
      title: 'Stream results',
      body: (
        <p className="text-sm text-muted-foreground">
          Set{' '}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">&quot;stream&quot;: true</code>{' '}
          to receive OpenAI-style SSE chunks (<code className="font-mono text-xs">data: …</code> until{' '}
          <code className="font-mono text-xs">[DONE]</code>). Try it live in the{' '}
          <span className="font-medium text-foreground">Playground</span> tab.
        </p>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Quickstart</CardTitle>
        <CardDescription>Three steps to your first API call.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {steps.map((step, i) => (
          <div key={step.title} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full border bg-background">
                <step.icon className="size-4" />
              </span>
              {i < steps.length - 1 ? <div className="mt-1 w-px flex-1 bg-border" /> : null}
            </div>
            <div className="min-w-0 flex-1 pb-1">
              <p className="mb-1.5 font-medium">
                <span className="mr-1.5 text-muted-foreground">{i + 1}.</span>
                {step.title}
              </p>
              {step.body}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Snippets panel ───────────────────────────────────────────────────────────

function SnippetsPanel({ origin }: { origin: string }) {
  const base = origin || 'http://localhost:3000';
  const k = 'emr_YOUR_KEY';
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle>Code snippets</CardTitle>
        <CardDescription>
          Streaming chat + model listing, ready to paste. Swap in your own key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            POST /api/v1/chat/completions
            <span className="text-xs font-normal text-muted-foreground">(streaming)</span>
          </p>
          <LangSnippetTabs
            snippets={{
              curl: curlChatCompletions(base, k, true),
              javascript: jsChatCompletions(base, k),
              python: pyChatCompletions(base, k),
            }}
          />
        </div>
        <Separator />
        <div>
          <p className="mb-2 flex items-center gap-2 text-sm font-medium">
            GET /api/v1/models
          </p>
          <LangSnippetTabs
            snippets={{
              curl: curlModels(base, k),
              javascript: jsModels(base, k),
              python: pyModels(base, k),
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Keys table ───────────────────────────────────────────────────────────────

// ─── More-capabilities hint card ──────────────────────────────────────────────

function MoreEndpointsCard({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const items = [
    { icon: ImageIcon, label: 'Images', path: '/api/v1/images/generations' },
    { icon: AudioLines, label: 'Speech', path: '/api/v1/audio/speech' },
    { icon: Video, label: 'Video', path: '/api/v1/videos/generations' },
  ];
  return (
    <Card className="border-violet-500/20 bg-violet-500/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="size-4 text-violet-600 dark:text-violet-400" />
          Beyond chat
        </CardTitle>
        <CardDescription>
          The gateway also covers images, speech and video generation — with async task polling
          for videos.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            onClick={() => onNavigate('reference')}
            className="group flex items-center gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-violet-500/40 hover:bg-violet-500/10"
          >
            <item.icon className="size-4 text-muted-foreground group-hover:text-violet-600 dark:group-hover:text-violet-400" />
            <span>
              {item.label}
              <span className="ml-2 hidden font-mono text-xs text-muted-foreground sm:inline">
                {item.path}
              </span>
            </span>
            <ArrowRight className="size-3.5 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5" />
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

// ─── Exported Overview tab ────────────────────────────────────────────────────

export function OverviewPanel({
  origin,
  onNavigate,
}: {
  origin: string;
  onNavigate: (tab: string) => void;
}) {
  return (
    <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
      <div className="space-y-4">
        <HeroCard origin={origin} />
        <MoreEndpointsCard onNavigate={onNavigate} />
        <KeysTable />
      </div>
      <div className="space-y-4">
        <Quickstart origin={origin} />
        <SnippetsPanel origin={origin} />
      </div>
    </div>
  );
}
