"use client";

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import {
  Activity,
  Check,
  CircleAlert,
  Database,
  Download,
  Eye,
  FileUp,
  Loader2,
  Lock,
  MonitorSmartphone,
  Moon,
  Plus,
  Radar,
  RefreshCw,
  Server,
  Sparkles,
  Sun,
  Trash2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Slider } from '@/components/ui/slider';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
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
import { api } from '@/lib/api-client';
import { useModels, useSettings, useSettingsMutation } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';
import type { AppSettings, ModelCapabilities, ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

function GeneralForm({
  settings,
  models,
  settingsMutation,
}: {
  settings: AppSettings;
  models: ModelInfo[];
  settingsMutation: ReturnType<typeof useSettingsMutation>;
}) {
  const [draft, setDraft] = useState({
    systemInstructions: settings.systemInstructions,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    contextMessageLimit: settings.contextMessageLimit,
  });
  const [dirty, setDirty] = useState(false);

  const update = (patch: Partial<typeof draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    try {
      await settingsMutation.mutateAsync(draft);
      toast.success('Settings saved');
      setDirty(false);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const enabledModels = models.filter((m) => m.enabled);

  return (
    <div className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="default-model">Default model for new chats</Label>
          <Select
            value={settings.defaultModelId}
            onValueChange={(v) =>
              void settingsMutation.mutateAsync({ defaultModelId: v }).then(() => toast.success('Default model updated'))
            }
          >
            <SelectTrigger id="default-model" className="w-full">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {enabledModels.map((m) => (
                <SelectItem key={m.id} value={m.modelId}>
                  {m.displayName} {m.freeTier ? '· Free' : '· Plan'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">Free-tier models are prioritised. EmorAI never silently switches to a paid model.</p>
        </div>

      <div className="space-y-2">
        <Label htmlFor="system-instructions">Custom system instructions</Label>
        <Textarea
          id="system-instructions"
          value={draft.systemInstructions}
          onChange={(e) => update({ systemInstructions: e.target.value })}
          placeholder="e.g. You are my coding mentor. Prefer concise answers with TypeScript examples."
          className="min-h-28 resize-y"
        />
        <p className="text-xs text-muted-foreground">Applied to every conversation, on top of the EmorAI base behavior.</p>
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Temperature</Label>
            <span className="text-xs text-muted-foreground">{draft.temperature.toFixed(1)}</span>
          </div>
          <Slider
            value={[draft.temperature]}
            min={0}
            max={2}
            step={0.1}
            onValueChange={([v]) => update({ temperature: v })}
            aria-label="Temperature"
          />
          <p className="text-xs text-muted-foreground">Lower = focused, higher = creative.</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="max-tokens">Maximum output tokens</Label>
          <Input
            id="max-tokens"
            type="number"
            min={64}
            max={32768}
            value={draft.maxTokens}
            onChange={(e) => update({ maxTokens: Number(e.target.value) || 4096 })}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="context-limit">Context window (messages)</Label>
          <Input
            id="context-limit"
            type="number"
            min={2}
            max={200}
            value={draft.contextMessageLimit}
            onChange={(e) => update({ contextMessageLimit: Number(e.target.value) || 24 })}
          />
          <p className="text-xs text-muted-foreground">How many recent messages are sent as context.</p>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Stream responses</p>
              <p className="text-xs text-muted-foreground">Show tokens as they are generated.</p>
            </div>
            <Switch
              checked={settings.streamEnabled}
              onCheckedChange={(v) => void settingsMutation.mutateAsync({ streamEnabled: v })}
              aria-label="Stream responses"
            />
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <p className="text-sm font-medium">Auto-generate titles</p>
              <p className="text-xs text-muted-foreground">Name conversations after the first exchange.</p>
            </div>
            <Switch
              checked={settings.titleGeneration}
              onCheckedChange={(v) => void settingsMutation.mutateAsync({ titleGeneration: v })}
              aria-label="Auto-generate titles"
            />
          </div>
        </div>
      </div>

      {dirty && (
        <div className="flex justify-end">
          <Button onClick={save} disabled={settingsMutation.isPending} className="gap-1.5">
            {settingsMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save changes
          </Button>
        </div>
      )}
    </div>
  );
}

function GeneralTab() {
  const { data } = useSettings();
  const { data: modelsData } = useModels();
  const settingsMutation = useSettingsMutation();
  if (!data) {
    return (
      <div className="py-8 text-center">
        <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <GeneralForm settings={data.settings} models={modelsData?.models ?? []} settingsMutation={settingsMutation} />;
}

function AppearanceTab() {
  const { theme, setTheme } = useTheme();
  const options = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'System', icon: MonitorSmartphone },
  ];
  return (
    <div className="space-y-4">
      <div>
        <Label>Theme</Label>
        <p className="mb-3 text-xs text-muted-foreground">EmorAI ships with a premium dark theme by default.</p>
        <div className="grid grid-cols-3 gap-2.5">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => setTheme(o.value)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-xl border p-4 text-sm transition-colors hover:bg-accent/50',
                theme === o.value && 'border-primary bg-primary/5 text-primary'
              )}
              aria-pressed={theme === o.value}
            >
              <o.icon className="size-5" />
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ModelRow({ model }: { model: ModelInfo }) {
  const qc = useQueryClient();
  const [probing, setProbing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await api.patch(`/api/models/${model.id}`, { enabled });
      void qc.invalidateQueries({ queryKey: ['models'] });
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const probe = async () => {
    setProbing(true);
    try {
      const res = await api.post<{ model: ModelInfo }>(`/api/models/${model.id}/probe`);
      void qc.invalidateQueries({ queryKey: ['models'] });
      if (res.model.lastStatus === 'ok') {
        toast.success(`${model.displayName}: reachable. Gateway reported serving "${res.model.lastServedModel ?? 'unknown'}".`);
      } else {
        toast.error(`${model.displayName}: ${res.model.lastError ?? 'unreachable'}`);
      }
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setProbing(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/api/models/${model.id}`);
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast.success(`${model.displayName} removed from the registry`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const caps: ModelCapabilities = model.capabilities;
  const capList = [
    caps.reasoning && 'Reasoning',
    caps.vision && 'Vision',
    caps.files && 'Files',
    caps.tools && 'Tools',
    caps.json && 'JSON',
  ].filter(Boolean) as string[];

  const [editingAliases, setEditingAliases] = useState(false);
  const [aliasDraft, setAliasDraft] = useState((model.aliases ?? []).join(', '));

  const saveAliases = async () => {
    const aliases = aliasDraft
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    try {
      await api.patch(`/api/models/${model.id}`, { aliases });
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast.success(aliases.length ? `Aliases saved: ${aliases.join(', ')}` : 'Aliases cleared');
      setEditingAliases(false);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  return (
    <div className="rounded-xl border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{model.displayName}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{model.modelId}</code>
        {model.freeTier ? (
          <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <Zap className="size-2.5" /> Free tier
          </Badge>
        ) : (
          <Badge variant="outline" className="text-[10px]">Requires plan</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Switch checked={model.enabled} onCheckedChange={(v) => void toggleEnabled(v)} aria-label={`Enable ${model.displayName}`} />
        </div>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{model.description}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {capList.map((c) => (
          <span key={c} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">{c}</span>
        ))}
        {model.contextWindow ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="Context window">
            {(model.contextWindow / 1000).toFixed(0)}k ctx
          </span>
        ) : null}
        {model.maxOutputTokens ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground" title="Max output tokens">
            {(model.maxOutputTokens / 1024).toFixed(0)}k out
          </span>
        ) : null}
        {(model.aliases ?? []).map((a) => (
          <span key={a} className="rounded-full border border-violet-500/20 bg-violet-500/10 px-2 py-0.5 text-[10px] text-violet-600 dark:text-violet-400" title={`Alias of ${model.modelId}`}>
            ≡ {a}
          </span>
        ))}
      </div>
      {editingAliases ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            value={aliasDraft}
            onChange={(e) => setAliasDraft(e.target.value)}
            placeholder="e.g. claude-sonnet-4-5, gpt-4o (comma-separated IDs that resolve to this model)"
            className="h-8 flex-1 text-xs"
            aria-label="Model aliases"
          />
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void saveAliases()}>
            Save
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setEditingAliases(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => void probe()} disabled={probing}>
          {probing ? <Loader2 className="size-3 animate-spin" /> : <Activity className="size-3" />}
          Test availability
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => setEditingAliases((v) => !v)}
          title="Aliases let external agents request their native model IDs (e.g. claude-sonnet-4-5) and resolve here — visible everywhere, never silent"
        >
          ≡ Aliases
        </Button>
        {model.lastCheckedAt && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            {model.lastStatus === 'ok' ? (
              <Check className="size-3 text-emerald-500" />
            ) : (
              <CircleAlert className="size-3 text-destructive" />
            )}
            {model.lastStatus === 'ok'
              ? `Served as “${model.lastServedModel ?? '?'}”`
              : 'Last test failed'}
            {model.lastStatus === 'error' && model.lastError ? ` — ${model.lastError.slice(0, 80)}` : ''}
          </span>
        )}
        <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => setDeleteOpen(true)}>
          <Trash2 className="size-3" /> Remove
        </Button>
      </div>
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {model.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              The model ID will be removed from the registry. Existing conversations that used it will need a model re-selected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void remove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ModelsTab() {
  const { data } = useModels();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [form, setForm] = useState({ modelId: '', displayName: '', description: '', freeTier: false, aliases: '', contextWindow: '', maxOutputTokens: '' });
  const models = data?.models ?? [];

  const discover = async () => {
    setDiscovering(true);
    toast.info('Probing every model in the registry (spaced to respect upstream rate limits)…');
    try {
      await api.post('/api/models/discover');
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast.success('Availability discovery complete — check the “Served as” notes.');
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setDiscovering(false);
    }
  };

  const addModel = async () => {
    if (!form.modelId.trim() || !form.displayName.trim()) {
      toast.error('Model ID and display name are required.');
      return;
    }
    try {
      await api.post('/api/models', {
        modelId: form.modelId.trim().toLowerCase(),
        displayName: form.displayName.trim(),
        description: form.description.trim() || 'Custom model added by the administrator.',
        provider: 'zai',
        freeTier: form.freeTier,
        enabled: true,
        aliases: form.aliases
          .split(',')
          .map((a) => a.trim())
          .filter(Boolean),
        ...(form.contextWindow ? { contextWindow: Number(form.contextWindow) } : {}),
        ...(form.maxOutputTokens ? { maxOutputTokens: Number(form.maxOutputTokens) } : {}),
      });
      void qc.invalidateQueries({ queryKey: ['models'] });
      toast.success(`Model “${form.displayName}” added`);
      setForm({ modelId: '', displayName: '', description: '', freeTier: false, aliases: '', contextWindow: '', maxOutputTokens: '' });
      setAdding(false);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Model registry</p>
          <p className="text-xs text-muted-foreground">
            Availability depends on your provider plan. Use “Test availability” to verify what the gateway actually serves — results are shown per model and never guessed.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void discover()}
            disabled={discovering}
            title="Probe every registry model with a tiny completion and record what the gateway actually serves"
          >
            {discovering ? <Loader2 className="size-3.5 animate-spin" /> : <Radar className="size-3.5" />}
            {discovering ? 'Discovering…' : 'Discover availability'}
          </Button>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding((v) => !v)}>
            <Plus className="size-3.5" /> Add model
          </Button>
        </div>
      </div>

      {adding && (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="model-id">Model ID (provider)</Label>
              <Input id="model-id" value={form.modelId} onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))} placeholder="e.g. glm-4.7-airx" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model-name">Display name</Label>
              <Input id="model-name" value={form.displayName} onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))} placeholder="e.g. GLM-4.7 AirX" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model-desc">Description</Label>
            <Input id="model-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="What is this model good at?" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="model-aliases">Aliases (optional)</Label>
            <Input id="model-aliases" value={form.aliases} onChange={(e) => setForm((f) => ({ ...f, aliases: e.target.value }))} placeholder="e.g. claude-sonnet-4-5, gpt-4o — IDs agents may request that resolve here" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="model-ctx">Context window (tokens, optional)</Label>
              <Input id="model-ctx" inputMode="numeric" value={form.contextWindow} onChange={(e) => setForm((f) => ({ ...f, contextWindow: e.target.value.replace(/\D/g, '') }))} placeholder="e.g. 128000" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="model-max">Max output tokens (optional)</Label>
              <Input id="model-max" inputMode="numeric" value={form.maxOutputTokens} onChange={(e) => setForm((f) => ({ ...f, maxOutputTokens: e.target.value.replace(/\D/g, '') }))} placeholder="e.g. 16384" />
            </div>
          </div>
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={form.freeTier} onCheckedChange={(v) => setForm((f) => ({ ...f, freeTier: v }))} aria-label="Free tier" />
              Zero-cost / free tier
            </label>
            <Button size="sm" onClick={() => void addModel()}>Add to registry</Button>
          </div>
        </div>
      )}

      <div className="space-y-2.5">
        {models.map((m) => (
          <ModelRow key={m.id} model={m} />
        ))}
      </div>
    </div>
  );
}

function ProviderTab() {
  const { data } = useSettings();
  const { data: modelsData } = useModels();
  const errorCount = (modelsData?.models ?? []).filter((m) => m.lastStatus === 'error').length;
  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Server className="size-4 text-primary" />
          <p className="text-sm font-medium">Z.ai GLM gateway</p>
          <Badge variant="secondary" className="ml-auto gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
            <span className="size-1.5 rounded-full bg-emerald-500" /> Configured server-side
          </Badge>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Provider credentials are resolved on the server from the <code className="rounded bg-muted px-1 py-0.5">.z-ai-config</code> file
          (or the gateway&apos;s own environment). They are never sent to the browser and never appear in client-side code or storage.
        </p>
        <ul className="mt-3 space-y-1.5 text-xs text-muted-foreground">
          <li>• Requests are made exclusively through server-side API routes.</li>
          <li>• Rate limits and provider errors are surfaced verbatim — no silent model switching.</li>
          <li>• Add or disable model IDs in the Models tab; the gateway may route some IDs to different backing models.</li>
        </ul>
      </div>

      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Lock className="size-4 text-primary" />
          <p className="text-sm font-medium">Security posture</p>
        </div>
        <ul className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <li>• EmorAI API keys are stored as SHA-256 hashes; plaintext is shown once at creation.</li>
          <li>• Developer API authentication uses Bearer tokens — provider credentials are never involved.</li>
          <li>• Cross-origin mutating requests to the dashboard API are rejected; per-key rate limits apply to /api/v1.</li>
          <li>• This is a single-owner installation: treat generated keys as trusted access to your provider quota.</li>
        </ul>
      </div>

      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <p className="text-sm font-medium">Defaults in effect</p>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
          <span>Temperature: {data?.settings.temperature ?? '—'}</span>
          <span>Max tokens: {data?.settings.maxTokens ?? '—'}</span>
          <span>API rate limit: {data?.settings.apiRateLimitPerMin ?? '—'}/min</span>
          <span>
            Model errors: {errorCount > 0 ? <span className="text-destructive">{errorCount}</span> : '0'}
          </span>
        </div>
      </div>
    </div>
  );
}

function DataTab() {
  const qc = useQueryClient();
  const [clearOpen, setClearOpen] = useState(false);
  const [importing, setImporting] = useState(false);

  const exportData = () => {
    // Download via direct navigation triggers the attachment disposition.
    const a = document.createElement('a');
    a.href = '/api/export';
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast.success('Export started — check your downloads.');
  };

  const importData = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const payload = JSON.parse(text) as unknown;
      const res = await api.post<{ imported: number }>('/api/import', payload);
      void qc.invalidateQueries();
      toast.success(`Imported ${res.imported} conversation${res.imported === 1 ? '' : 's'}.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setImporting(false);
    }
  };

  const clearHistory = async () => {
    try {
      const res = await api.get<{ conversations: { id: string }[] }>('/api/conversations?q=');
      for (const c of res.conversations) {
        await api.del(`/api/conversations/${c.id}`);
      }
      void qc.invalidateQueries();
      toast.success('Chat history cleared.');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Download className="size-4 text-primary" />
          <p className="text-sm font-medium">Export conversations</p>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Download every conversation and message as a portable JSON file.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={exportData}>
          Export JSON
        </Button>
      </div>

      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <FileUp className="size-4 text-primary" />
          <p className="text-sm font-medium">Import conversations</p>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Restore from an EmorAI export file. Existing data is preserved.</p>
        <div className="mt-3">
          <input
            type="file"
            accept="application/json,.json"
            id="import-file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importData(f);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" disabled={importing} onClick={() => document.getElementById('import-file')?.click()} className="gap-1.5">
            {importing ? <Loader2 className="size-3.5 animate-spin" /> : <FileUp className="size-3.5" />}
            Choose file…
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-destructive/40 p-4">
        <div className="flex items-center gap-2">
          <Trash2 className="size-4 text-destructive" />
          <p className="text-sm font-medium">Clear chat history</p>
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">Permanently deletes all conversations and messages. API keys, models and settings are kept.</p>
        <Button variant="destructive" size="sm" className="mt-3" onClick={() => setClearOpen(true)}>
          Clear all conversations
        </Button>
      </div>

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all chat history?</AlertDialogTitle>
            <AlertDialogDescription>
              Every conversation and message will be permanently deleted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void clearHistory()}>
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function SettingsDialog() {
  const dialog = useEmorStore((s) => s.dialog);
  const dialogTab = useEmorStore((s) => s.dialogTab);
  const closeDialog = useEmorStore((s) => s.closeDialog);
  const open = dialog === 'settings';
  const tab = dialogTab ?? 'general';

  return (
    <Dialog open={open} onOpenChange={(v) => (!v ? closeDialog() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your EmorAI installation.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={tab} value={tab} onValueChange={(v) => useEmorStore.getState().openDialog('settings', v)} className="flex min-h-0 flex-col">
          <TabsList className="mx-5 mt-4 grid w-auto grid-cols-5">
            <TabsTrigger value="general" className="text-xs">General</TabsTrigger>
            <TabsTrigger value="appearance" className="gap-1 text-xs"><Eye className="size-3" />Look</TabsTrigger>
            <TabsTrigger value="models" className="text-xs">Models</TabsTrigger>
            <TabsTrigger value="provider" className="gap-1 text-xs"><Server className="size-3" />Provider</TabsTrigger>
            <TabsTrigger value="data" className="gap-1 text-xs"><Database className="size-3" />Data</TabsTrigger>
          </TabsList>
          <div className="emor-scroll min-h-0 flex-1 overflow-y-auto px-5 py-5" style={{ maxHeight: '60vh' }}>
            <TabsContent value="general" className="mt-0"><GeneralTab /></TabsContent>
            <TabsContent value="appearance" className="mt-0"><AppearanceTab /></TabsContent>
            <TabsContent value="models" className="mt-0"><ModelsTab /></TabsContent>
            <TabsContent value="provider" className="mt-0"><ProviderTab /></TabsContent>
            <TabsContent value="data" className="mt-0"><DataTab /></TabsContent>
          </div>
        </Tabs>
        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={closeDialog}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
