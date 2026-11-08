'use client';

import { useState, useSyncExternalStore } from 'react';
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  Cpu,
  ExternalLink,
  KeyRound,
  Plug,
  Terminal,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CodeBlock, CopyButton } from './snippets';
import {
  getPlaygroundKey,
  getPlaygroundKeyServerSnapshot,
  subscribePlaygroundKey,
} from './key-vault';
import { useModels } from '@/hooks/use-emor-queries';
import { useSettings } from '@/hooks/use-emor-queries';

// ─── Model chips ─────────────────────────────────────────────────────────────

function ModelChips() {
  const { data } = useModels();
  const { data: settingsData } = useSettings();
  const models = (data?.models ?? []).filter((m) => m.enabled);
  const defaultId = settingsData?.settings?.defaultModelId ?? models[0]?.modelId;
  if (models.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {models.slice(0, 6).map((m) => (
        <span
          key={m.modelId}
          className="inline-flex items-center gap-1 rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs"
        >
          {m.modelId}
          {m.modelId === defaultId ? (
            <span className="font-sans text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              default
            </span>
          ) : null}
        </span>
      ))}
      {models.length > 6 ? (
        <span className="text-xs text-muted-foreground">+{models.length - 6} more</span>
      ) : null}
    </div>
  );
}

// ─── Step list ───────────────────────────────────────────────────────────────

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full border bg-background font-mono text-xs font-semibold">
          {n}
        </span>
        {n < 9 ? <div className="mt-1 w-px flex-1 bg-border" /> : null}
      </div>
      <div className="min-w-0 flex-1 pb-4">
        <p className="mb-1.5 text-sm font-medium">{title}</p>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function KeyLine({ k }: { k: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
        {k}
      </code>
      <CopyButton value={k} label="API key" />
    </div>
  );
}

// ─── Integration guide cards ─────────────────────────────────────────────────

type GuideKey = 'zcode' | 'claude-code' | 'openclaw' | 'generic';

function IntegrationCard({
  id,
  icon: Icon,
  name,
  protocol,
  status,
  baseUrl,
  baseUrlNote,
  snippets,
  children,
  defaultOpen,
}: {
  id: GuideKey;
  icon: typeof Bot;
  name: string;
  protocol: string;
  status: 'verified' | 'compatible';
  baseUrl: string;
  baseUrlNote?: string;
  snippets: { title: string; code: string }[];
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  return (
    <Card id={`guide-${id}`} className="scroll-mt-24">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
              <Icon className="size-5" />
            </span>
            <div>
              <CardTitle className="text-base">{name}</CardTitle>
              <CardDescription className="font-mono text-xs">{protocol}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {status === 'verified' ? (
              <Badge
                variant="outline"
                className="gap-1 border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              >
                <CheckCircle2 className="size-3" /> Tested
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <Plug className="size-3" /> Compatible
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Base URL to enter
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="max-w-full overflow-x-auto rounded-md border bg-muted/60 px-3 py-1.5 font-mono text-sm">
              {baseUrl}
            </code>
            <CopyButton value={baseUrl} label="Base URL" />
          </div>
          {baseUrlNote ? (
            <p className="mt-1.5 text-xs text-muted-foreground">{baseUrlNote}</p>
          ) : null}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setOpen((v) => !v)}
          className="gap-1.5"
          aria-expanded={open}
        >
          <ChevronDown className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          {open ? 'Hide setup steps' : 'Show setup steps'}
        </Button>
        {open ? (
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            {children}
            {snippets.map((s) => (
              <CodeBlock key={s.title} title={s.title} code={s.code} />
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─── Integrations tab ────────────────────────────────────────────────────────

export function AgentGuides({ origin }: { origin: string }) {
  const playgroundKey = useSyncExternalStore(
    subscribePlaygroundKey,
    getPlaygroundKey,
    getPlaygroundKeyServerSnapshot
  );
  const key = playgroundKey || 'emr_YOUR_KEY';
  const base = origin || 'http://localhost:3000';

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* Hero */}
      <Card className="overflow-hidden border-violet-500/20 bg-gradient-to-br from-violet-500/10 via-transparent to-emerald-500/10">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <span className="flex size-9 items-center justify-center rounded-lg bg-violet-500/15 text-violet-600 dark:text-violet-400">
              <Plug className="size-5" />
            </span>
            <div>
              <CardTitle className="text-xl">Connect coding agents to EmorAI</CardTitle>
              <CardDescription>
                EmorAI speaks both the OpenAI and the Anthropic wire protocol — point any
                compatible agent at your gateway and start coding.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border bg-background/60 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Cpu className="size-3.5" /> OpenAI-compatible base URL
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                  {base}/api/v1
                </code>
                <CopyButton value={`${base}/api/v1`} label="OpenAI base URL" />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                Apps that append <code className="font-mono">/v1/…</code> themselves can also use{' '}
                <code className="font-mono">{base}</code>
              </p>
            </div>
            <div className="rounded-lg border bg-background/60 p-3">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Zap className="size-3.5" /> Anthropic-compatible base URL
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
                  {base}/api
                </code>
                <CopyButton value={`${base}/api`} label="Anthropic base URL" />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                The SDK appends <code className="font-mono">/v1/messages</code> automatically
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background/60 p-3">
            <div className="min-w-0">
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <KeyRound className="size-3.5" /> Your API key
              </p>
              <KeyLine k={key} />
              {playgroundKey ? (
                <p className="mt-1.5 text-xs text-emerald-600 dark:text-emerald-400">
                  Using the key saved in your Playground.
                </p>
              ) : (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  Save a key in the Playground tab to fill these guides automatically. Snippets use
                  a placeholder until then.
                </p>
              )}
            </div>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Available models (enter one as the model ID)
            </p>
            <ModelChips />
          </div>
        </CardContent>
      </Card>

      {/* Claude Code */}
      <IntegrationCard
        id="claude-code"
        icon={Terminal}
        name="Claude Code"
        protocol="Anthropic Messages API"
        status="verified"
        baseUrl={`${base}/api`}
        baseUrlNote="Set as ANTHROPIC_BASE_URL. Claude Code appends /v1/messages, /v1/messages/count_tokens automatically."
        snippets={[
          { title: 'shell — environment variables', code: claudeCodeEnvSnippet(base, key) },
          { title: 'json — ~/.claude/settings.json', code: claudeCodeSettingsSnippet(base, key) },
        ]}
      >
        <Step n={1} title="Create an EmorAI API key">
          <p>
            Generate a key in the Overview tab (or the Playground key vault). Keys are hashed
            server-side; the plaintext is shown once.
          </p>
        </Step>
        <Step n={2} title="Export the environment variables">
          <p>
            <code className="font-mono text-xs">ANTHROPIC_BASE_URL</code> points Claude Code at
            EmorAI; <code className="font-mono text-xs">ANTHROPIC_MODEL</code> selects an EmorAI
            model. Anthropic-format authentication (<code className="font-mono text-xs">x-api-key</code>)
            is supported natively.
          </p>
        </Step>
        <Step n={3} title="Run claude and start coding">
          <p>
            Streaming, system prompts, conversation history and tool calling round-trips are
            translated to the Anthropic wire protocol end-to-end.
          </p>
        </Step>
      </IntegrationCard>

      {/* ZCode */}
      <IntegrationCard
        id="zcode"
        icon={Bot}
        name="ZCode"
        protocol="OpenAI-compatible · Anthropic-compatible"
        status="compatible"
        baseUrl={`${base}/api/v1`}
        baseUrlNote="For the Anthropic format in ZCode, use the base URL without /v1: the client appends its own paths."
        snippets={[{ title: 'provider setup', code: zcodeSnippet(base, key) }]}
      >
        <Step n={1} title="Open Add Provider">
          <p>Choose a custom provider and pick the API format (OpenAI-compatible or Anthropic-compatible).</p>
        </Step>
        <Step n={2} title="Enter the Base URL and key">
          <p>
            OpenAI format: <code className="font-mono text-xs">{base}/api/v1</code> · Anthropic
            format: <code className="font-mono text-xs">{base}/api</code>
          </p>
        </Step>
        <Step n={3} title="Register a model manually">
          <p>
            Add an EmorAI model ID (e.g. <code className="font-mono text-xs">glm-5.3-flash</code>).
            Streaming is supported on both formats.
          </p>
        </Step>
      </IntegrationCard>

      {/* OpenClaw */}
      <IntegrationCard
        id="openclaw"
        icon={ExternalLink}
        name="OpenClaw / AutoClaw"
        protocol="OpenAI-compatible custom provider"
        status="compatible"
        baseUrl={`${base}/api/v1`}
        snippets={[{ title: 'provider setup', code: openClawSnippet(base, key) }]}
      >
        <Step n={1} title="Add a custom OpenAI-compatible provider">
          <p>Enter the Base URL and your EmorAI API key.</p>
        </Step>
        <Step n={2} title="Discover models">
          <p>
            Model discovery works out of the box:{' '}
            <code className="font-mono text-xs">GET {base}/api/v1/models</code> returns the live
            registry with capabilities.
          </p>
        </Step>
        <Step n={3} title="Code away">
          <p>SSE streaming and tool calling are fully supported through the OpenAI protocol.</p>
        </Step>
      </IntegrationCard>

      {/* Generic */}
      <IntegrationCard
        id="generic"
        icon={Plug}
        name="Other agents & apps"
        protocol="Any OpenAI- or Anthropic-compatible client"
        status="compatible"
        baseUrl={`${base}/api/v1`}
        baseUrlNote="Continue.dev, Aider, Cline, LibreChat, Open WebUI, LangChain, LlamaIndex…"
        snippets={[{ title: 'environment', code: genericSnippet(base, key) }]}
      >
        <Step n={1} title="Set the base URL + key in your tool">
          <p>
            OpenAI-style tools use <code className="font-mono text-xs">{base}/api/v1</code>;
            Anthropic-style tools use <code className="font-mono text-xs">{base}/api</code>.
          </p>
        </Step>
        <Step n={2} title="Pick a model">
          <p>
            Any model from <code className="font-mono text-xs">GET /api/v1/models</code>. Both
            protocols accept Bearer and x-api-key authentication.
          </p>
        </Step>
      </IntegrationCard>

      {/* Honest notes */}
      <Card className="border-amber-500/20 bg-amber-500/5">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Good to know (no surprises)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5 text-sm text-muted-foreground">
          <p>
            · The upstream gateway currently serves <code className="font-mono text-xs">glm-4-plus</code>{' '}
            for GLM model IDs on this plan — every response reports the model actually served (
            <code className="font-mono text-xs">emorai_served_model</code> / model field), and the
            Model registry shows it per model after a availability probe.
          </p>
          <p>
            · Requests are retried with backoff when the upstream rate-limits (429); repeated abuse
            still fails honestly — EmorAI never bypasses provider limits.
          </p>
          <p>
            · Unknown model IDs return a 404 with the available model list — nothing is silently
            rerouted. Admins can configure explicit, visible aliases in Settings → Models.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// Snippet builders (kept local so the component stays self-contained)
function claudeCodeEnvSnippet(base: string, key: string): string {
  return `# Claude Code — point it at EmorAI (Anthropic-compatible)
export ANTHROPIC_BASE_URL="${base}/api"
export ANTHROPIC_API_KEY="${key}"
export ANTHROPIC_MODEL="glm-5.3-flash"
# Optional: a lighter model for background tasks
export ANTHROPIC_SMALL_FAST_MODEL="glm-5.3-flash"

# Then just run:
claude`;
}

function claudeCodeSettingsSnippet(base: string, key: string): string {
  return `// ~/.claude/settings.json (alternative to env vars)
{
  "env": {
    "ANTHROPIC_BASE_URL": "${base}/api",
    "ANTHROPIC_API_KEY": "${key}",
    "ANTHROPIC_MODEL": "glm-5.3-flash"
  }
}`;
}

function zcodeSnippet(base: string, key: string): string {
  return `# ZCode — Add Provider (OpenAI-compatible)
#   API Base URL:  ${base}/api/v1
#   API Format:    OpenAI-compatible
#   API Key:       ${key}
#   Model ID:      glm-5.3-flash   (see Available models for the full list)

# Anthropic-format provider in ZCode works identically:
#   API Base URL:  ${base}/api
#   API Format:    Anthropic-compatible
#   Model ID:      glm-5.3-flash`;
}

function openClawSnippet(base: string, key: string): string {
  return `# OpenClaw / AutoClaw — custom OpenAI-compatible provider
# Provider settings:
#   Base URL:  ${base}/api/v1
#   API Key:   ${key}
#   Model:     glm-5.3-flash
#
# Model discovery: GET ${base}/api/v1/models
#   curl ${base}/api/v1/models -H "Authorization: Bearer ${key}"
#
# Streaming is supported end-to-end (SSE).`;
}

function genericSnippet(base: string, key: string): string {
  return `# Any OpenAI SDK / app — EmorAI as a drop-in provider
OPENAI_BASE_URL="${base}/api/v1"
OPENAI_API_KEY="${key}"
# Works with: Continue.dev, Aider, Cline, LibreChat, Open WebUI,
# LangChain, LlamaIndex, and every tool that accepts a custom base URL.`;
}
