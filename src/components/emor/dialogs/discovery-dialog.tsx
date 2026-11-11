"use client";

// Provider discovery workflow (Phase 10, Priority 6) — the full admin flow:
// dry-run discovery → select models + verify metadata (freeTier/capabilities/
// contextWindow) → adopt (creates UNPUBLISHED ModelConfigs + execution
// routes) → test real execution through the model probe → hand off to the
// Models tab for publication and the Routing tab for execution eligibility.

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CircleAlert,
  Check,
  ExternalLink,
  Loader2,
  Route as RouteIcon,
  Radar,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api-client';
import { useModels } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';
import type { ModelCapabilities, ModelInfo } from '@/lib/types';
import type {
  AdoptionDraft,
  DiscoveredModel,
  DiscoveryResponse,
} from './provider-shared';
import { adoptionDraftFor, providerTypeLabel } from './provider-shared';

const CAPABILITY_LABELS: Array<{ key: keyof ModelCapabilities; label: string }> = [
  { key: 'chat', label: 'Chat' },
  { key: 'reasoning', label: 'Reasoning' },
  { key: 'vision', label: 'Vision' },
  { key: 'files', label: 'Files' },
  { key: 'webSearch', label: 'Web search' },
  { key: 'tools', label: 'Tools' },
  { key: 'json', label: 'JSON' },
];

type ProbeState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'ok'; latencyMs: number; served: string | null }
  | { status: 'error'; message: string };

type DiscoverError = { status: number; code: string; message: string };

/** One discovered-model row with its selection state and adoption draft. */
function DiscoveredModelRow({
  model,
  selected,
  onToggle,
  draft,
  onDraftChange,
}: {
  model: DiscoveredModel;
  selected: boolean;
  onToggle: (checked: boolean) => void;
  draft: AdoptionDraft;
  onDraftChange: (patch: Partial<AdoptionDraft>) => void;
}) {
  return (
    <div className={`rounded-xl border p-3 transition-colors ${selected ? 'border-primary/40 bg-primary/5' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="flex h-11 items-center">
          <Checkbox
            checked={selected}
            onCheckedChange={(v) => onToggle(v === true)}
            aria-label={`Select ${model.modelId} for adoption`}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium">{model.displayName ?? model.modelId}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{model.modelId}</code>
            {model.alreadyCatalogued && (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">
                In catalogue
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {model.contextWindow != null && <span title="Context window reported by the provider">{(model.contextWindow / 1000).toFixed(0)}k ctx</span>}
            {model.ownedBy && <span>owned by {model.ownedBy}</span>}
          </div>

          {selected && (
            <div className="mt-2.5 space-y-3 rounded-lg border bg-background/60 p-3">
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Admin-verified metadata — never inferred from the model name. The model enters the catalogue
                UNPUBLISHED (enabled off); publish it in the Models tab after adopting.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`adopt-name-${model.modelId}`} className="text-xs">
                    Display name
                  </Label>
                  <Input
                    id={`adopt-name-${model.modelId}`}
                    value={draft.displayName}
                    onChange={(e) => onDraftChange({ displayName: e.target.value })}
                    maxLength={80}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`adopt-ctx-${model.modelId}`} className="text-xs">
                    Context window (tokens)
                  </Label>
                  <Input
                    id={`adopt-ctx-${model.modelId}`}
                    inputMode="numeric"
                    value={draft.contextWindow}
                    onChange={(e) => onDraftChange({ contextWindow: e.target.value.replace(/\D/g, '') })}
                    placeholder={model.contextWindow != null ? String(model.contextWindow) : 'e.g. 128000'}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2">
                <span className="text-xs">Free tier / zero-cost</span>
                <Switch
                  checked={draft.freeTier}
                  onCheckedChange={(v) => onDraftChange({ freeTier: v })}
                  aria-label={`Mark ${model.modelId} as free tier`}
                />
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium">Capabilities</p>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {CAPABILITY_LABELS.map(({ key, label }) => (
                    <label key={key} className="flex min-h-9 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
                      <Checkbox
                        checked={draft.capabilities[key]}
                        onCheckedChange={(v) =>
                          onDraftChange({ capabilities: { ...draft.capabilities, [key]: v === true } })
                        }
                        aria-label={`${label} capability for ${model.modelId}`}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Live execution test result for one adopted model. */
function ProbeResult({ state }: { state: ProbeState }) {
  if (state.status === 'idle') return null;
  if (state.status === 'running') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="size-3 animate-spin" /> Sending a tiny completion through the router…
      </p>
    );
  }
  if (state.status === 'ok') {
    return (
      <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400" role="status">
        <Check className="size-3.5" />
        Served as “{state.served ?? '?'}” · responded in {state.latencyMs}ms
      </p>
    );
  }
  return (
    <p className="flex items-start gap-1.5 text-xs text-destructive" role="alert">
      <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
      {state.message}
    </p>
  );
}

export function DiscoveryDialog({
  account,
  open,
  onOpenChange,
}: {
  account: { id: string; name: string; providerType: string };
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const modelsQuery = useModels();
  const openDialog = useEmorStore((s) => s.openDialog);

  const [phase, setPhase] = useState<'intro' | 'loading' | 'error' | 'results' | 'adopted'>('intro');
  const [error, setError] = useState<DiscoverError | null>(null);
  const [discovered, setDiscovered] = useState<DiscoveredModel[]>([]);
  const [drafts, setDrafts] = useState<Record<string, AdoptionDraft>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [adoptResult, setAdoptResult] = useState<DiscoveryResponse | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  // Fresh workflow state every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setPhase('intro');
    setError(null);
    setDiscovered([]);
    setDrafts({});
    setSelected([]);
    setAdoptResult(null);
    setAdopting(false);
    setProbes({});
  }, [open, account.id]);

  const runDiscovery = async () => {
    setPhase('loading');
    setError(null);
    try {
      // Dry run first: adopt=[] publishes nothing, returns the listing only.
      const res = await api.post<DiscoveryResponse>(`/api/providers/${account.id}/discover`, { adopt: [] });
      setDiscovered(res.discovered);
      const nextDrafts: Record<string, AdoptionDraft> = {};
      for (const m of res.discovered) nextDrafts[m.modelId] = adoptionDraftFor(m);
      setDrafts(nextDrafts);
      setSelected([]);
      setPhase('results');
    } catch (e) {
      const err = e as ApiError;
      setError({ status: err.status, code: err.code, message: err.message });
      setPhase('error');
    }
  };

  const toggleModel = (modelId: string, checked: boolean) => {
    setSelected((list) => (checked ? [...list, modelId] : list.filter((id) => id !== modelId)));
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelected(checked ? discovered.map((m) => m.modelId) : []);
  };

  const updateDraft = (modelId: string, patch: Partial<AdoptionDraft>) => {
    setDrafts((prev) => ({ ...prev, [modelId]: { ...prev[modelId], ...patch } }));
  };

  const adoptSelected = async () => {
    if (selected.length === 0 || adopting) return;
    setAdopting(true);
    try {
      const adopt = selected.map((modelId) => {
        const draft = drafts[modelId];
        const ctx = Number(draft.contextWindow);
        return {
          modelId,
          displayName: draft.displayName.trim() || modelId,
          freeTier: draft.freeTier,
          capabilities: draft.capabilities,
          ...(Number.isFinite(ctx) && ctx >= 1024 ? { contextWindow: Math.trunc(ctx) } : {}),
        };
      });
      const res = await api.post<DiscoveryResponse>(`/api/providers/${account.id}/discover`, { adopt });
      setAdoptResult(res);
      setPhase('adopted');
      void qc.invalidateQueries({ queryKey: ['models'] });
      void qc.invalidateQueries({ queryKey: ['routes'] });
      void qc.invalidateQueries({ queryKey: ['providers'] });
      const created = res.routes.filter((r) => r.created).length;
      toast.success(
        `Adopted ${res.adopted.length} model${res.adopted.length === 1 ? '' : 's'} — ${created} new execution route${created === 1 ? '' : 's'} created.`,
      );
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setAdopting(false);
    }
  };

  const probe = async (modelId: string) => {
    const model: ModelInfo | undefined = (modelsQuery.data?.models ?? []).find((m) => m.modelId === modelId);
    if (!model) {
      setProbes((prev) => ({
        ...prev,
        [modelId]: { status: 'error', message: 'Model not in the registry yet — reopen this dialog to refresh.' },
      }));
      return;
    }
    setProbes((prev) => ({ ...prev, [modelId]: { status: 'running' } }));
    const startedAt = Date.now();
    try {
      const res = await api.post<{ model: ModelInfo }>(`/api/models/${model.id}/probe`);
      const latencyMs = Date.now() - startedAt;
      if (res.model.lastStatus === 'ok') {
        setProbes((prev) => ({
          ...prev,
          [modelId]: { status: 'ok', latencyMs, served: res.model.lastServedModel },
        }));
      } else {
        setProbes((prev) => ({
          ...prev,
          [modelId]: { status: 'error', message: res.model.lastError ?? 'The provider did not serve this model.' },
        }));
      }
      void qc.invalidateQueries({ queryKey: ['models'] });
    } catch (e) {
      setProbes((prev) => ({ ...prev, [modelId]: { status: 'error', message: String((e as Error).message) } }));
    }
  };

  const allSelected = discovered.length > 0 && selected.length === discovered.length;
  const someSelected = selected.length > 0 && !allSelected;

  const adoptedModels = useMemo(() => {
    const routes = adoptResult?.routes ?? [];
    return routes.map((route) => ({
      route,
      model: (modelsQuery.data?.models ?? []).find((m) => m.modelId === route.modelId),
    }));
  }, [adoptResult, modelsQuery.data]);

  const close = (v: boolean) => {
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <Radar className="size-4 text-primary" />
            Discover models on “{account.name}”
          </DialogTitle>
          <DialogDescription>
            {providerTypeLabel(account.providerType)} model listing, verified by you before anything is published.
          </DialogDescription>
        </DialogHeader>

        <div className="emor-scroll min-h-0 overflow-y-auto px-5 py-5" style={{ maxHeight: '58vh' }}>
          {phase === 'intro' && (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">
                Lists the models this upstream account actually offers. Nothing is adopted or published until you
                select models and confirm below — adoption creates them <strong>UNPUBLISHED</strong> (enabled off)
                with an execution route ready on this account.
              </p>
              <div className="rounded-xl border p-3.5 text-xs leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">How this works</p>
                <p className="mt-1">
                  1. Run a dry discovery (nothing changes).
                  <br />
                  2. Select models and verify their metadata — free tier, capabilities and context window.
                  <br />
                  3. Adopt: catalogue entries are created disabled plus live execution routes.
                  <br />
                  4. Test real execution, then publish in the Models tab.
                </p>
              </div>
              <Button onClick={() => void runDiscovery()} className="h-10 gap-2">
                <Radar className="size-4" />
                Run discovery
              </Button>
            </div>
          )}

          {phase === 'loading' && (
            <div className="space-y-3" aria-live="polite" aria-label="Discovering upstream models">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Querying the provider&apos;s model listing…
              </div>
              <Skeleton className="h-20 w-full rounded-xl" />
              <Skeleton className="h-20 w-full rounded-xl" />
            </div>
          )}

          {phase === 'error' && error && (
            <div className="space-y-4">
              {error.code === 'discovery_unsupported' ? (
                <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                    <CircleAlert className="size-4" />
                    Model listing not supported for {providerTypeLabel(account.providerType)}
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{error.message}</p>
                </div>
              ) : (
                <div className="rounded-xl border border-destructive/40 p-4">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
                    <CircleAlert className="size-4" /> Discovery failed
                  </p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{error.message}</p>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void runDiscovery()} className="h-10 gap-2">
                  <RefreshCw className="size-4" /> Retry discovery
                </Button>
                {error.code === 'discovery_unsupported' && (
                  <Button
                    variant="ghost"
                    onClick={() => openDialog('settings', 'models')}
                    className="h-10 gap-2"
                    aria-label="Open the Models tab for availability probing"
                  >
                    <ExternalLink className="size-4" /> Open the Models tab
                  </Button>
                )}
              </div>
            </div>
          )}

          {phase === 'results' && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                    onCheckedChange={(v) => toggleSelectAll(v === true)}
                    aria-label="Select all discovered models"
                  />
                  {selected.length}/{discovered.length} selected
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-9 gap-1.5 text-xs"
                  onClick={() => void runDiscovery()}
                  aria-label="Re-run discovery"
                >
                  <RefreshCw className="size-3" /> Re-run
                </Button>
              </div>

              <p className="rounded-lg border border-violet-500/20 bg-violet-500/10 p-2.5 text-xs leading-relaxed text-violet-600 dark:text-violet-400">
                Adopted models start UNPUBLISHED — customers cannot resolve them until you enable each model in the
                Models tab. Execution routes are created live immediately.
              </p>

              {discovered.length === 0 ? (
                <div className="rounded-xl border border-dashed p-6 text-center">
                  <Radar className="mx-auto size-6 text-muted-foreground" />
                  <p className="mt-2 text-sm font-medium">No models reported</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The provider&apos;s listing API returned an empty catalogue — nothing to adopt.
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {discovered.map((m) => (
                    <DiscoveredModelRow
                      key={m.modelId}
                      model={m}
                      selected={selected.includes(m.modelId)}
                      onToggle={(checked) => toggleModel(m.modelId, checked)}
                      draft={drafts[m.modelId] ?? adoptionDraftFor(m)}
                      onDraftChange={(patch) => updateDraft(m.modelId, patch)}
                    />
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                <p className="text-xs text-muted-foreground">
                  {selected.length === 0
                    ? 'Select at least one model to adopt it into the catalogue.'
                    : `${selected.length} model${selected.length === 1 ? '' : 's'} will be adopted UNPUBLISHED with execution routes on “${account.name}”.`}
                </p>
                <Button onClick={() => void adoptSelected()} disabled={selected.length === 0 || adopting} className="h-10 gap-2">
                  {adopting ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                  {adopting ? 'Adopting…' : `Adopt selected (${selected.length})`}
                </Button>
              </div>
            </div>
          )}

          {phase === 'adopted' && adoptResult && (
            <div className="space-y-4">
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
                <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
                  <Check className="size-4" /> Adoption complete
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{adoptResult.note}</p>
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Created catalogue entries & execution routes
                </p>
                <div className="space-y-2.5">
                  {adoptedModels.map(({ route, model }) => (
                    <div key={route.routeId} className="rounded-xl border p-3.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{model?.displayName ?? route.modelId}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                          {route.modelId}
                        </code>
                        <Badge
                          variant="outline"
                          className="text-[10px]"
                          title={route.created ? 'Route created by this adoption' : 'Identical route already existed — reused'}
                        >
                          {route.created ? 'New route' : 'Existing route'}
                        </Badge>
                        {route.enabled ? (
                          <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                            <span className="size-1.5 rounded-full bg-emerald-500" /> Route live
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">Route disabled</Badge>
                        )}
                        {!model && (
                          <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                            Not in catalogue
                          </Badge>
                        )}
                        {model && !model.enabled && (
                          <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                            Unpublished
                          </Badge>
                        )}
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[11px] text-muted-foreground">
                          Routes {route.modelId} → {route.upstreamModelId} on “{account.name}”. Configure priority,
                          concurrency and weights in the Routing tab.
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9 gap-1.5 text-xs"
                          onClick={() => void probe(route.modelId)}
                          disabled={probes[route.modelId]?.status === 'running'}
                          aria-label={`Test execution of ${route.modelId}`}
                        >
                          {probes[route.modelId]?.status === 'running' ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <Activity className="size-3" />
                          )}
                          Test execution
                        </Button>
                      </div>
                      <div className="mt-1.5">
                        <ProbeResult state={probes[route.modelId] ?? { status: 'idle' }} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap gap-2 border-t pt-4">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5"
                  onClick={() => openDialog('settings', 'models')}
                  aria-label="Open the Models tab to publish adopted models"
                >
                  <ExternalLink className="size-3.5" /> Publish in Models tab
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 gap-1.5"
                  onClick={() => openDialog('settings', 'routes')}
                  aria-label="Open the Routing tab to configure execution eligibility"
                >
                  <RouteIcon className="size-3.5" /> Configure in Routing tab
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-9 gap-1.5"
                  onClick={() => {
                    setAdoptResult(null);
                    setPhase('intro');
                  }}
                  aria-label="Run another discovery"
                >
                  <RefreshCw className="size-3.5" /> Start over
                </Button>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
