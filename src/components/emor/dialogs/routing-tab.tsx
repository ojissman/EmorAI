"use client";

import { useState } from 'react';
import { CircleAlert, HeartPulse, Loader2, Plus, Route as RouteIcon, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
  useCreateRoute,
  useDeleteRoute,
  useModels,
  useProviders,
  useRoutes,
  useUpdateRoute,
} from '@/hooks/use-emor-queries';
import type { ModelRouteRow } from '@/hooks/use-emor-queries';
import type { ModelInfo } from '@/lib/types';
import { providerTypeLabel, timeAgo } from './provider-shared';

function HealthBadge({ status }: { status: string }) {
  if (status === 'healthy') {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" /> Healthy
      </Badge>
    );
  }
  if (status === 'degraded') {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" /> Degraded
      </Badge>
    );
  }
  if (status === 'down') {
    return (
      <Badge variant="outline" className="gap-1 border-destructive/40 text-[10px] text-destructive">
        <CircleAlert className="size-2.5" /> Down
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      Unknown
    </Badge>
  );
}

function RouteRow({ route }: { route: ModelRouteRow }) {
  const update = useUpdateRoute();
  const remove = useDeleteRoute();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [priorityDraft, setPriorityDraft] = useState(String(route.priority));
  const [priorityDirty, setPriorityDirty] = useState(false);

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await update.mutateAsync({ id: route.id, enabled });
      toast.success(`Route ${enabled ? 'enabled' : 'disabled'}: ${route.publicModelId} → ${route.upstreamModelId}.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const commitPriority = async () => {
    if (!priorityDirty) return;
    const n = Number(priorityDraft);
    if (priorityDraft === '' || !Number.isFinite(n) || n < 0 || n > 1000 || Math.trunc(n) === route.priority) {
      setPriorityDraft(String(route.priority));
      setPriorityDirty(false);
      return;
    }
    try {
      await update.mutateAsync({ id: route.id, priority: Math.trunc(n) });
      setPriorityDirty(false);
      toast.success('Route priority updated.');
    } catch (e) {
      setPriorityDraft(String(route.priority));
      setPriorityDirty(false);
      toast.error(String((e as Error).message));
    }
  };

  const resetHealth = async () => {
    try {
      await update.mutateAsync({ id: route.id, resetHealth: true });
      toast.success('Route health reset — status is unknown until the next real execution.');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(route.id);
      toast.success(`Route removed: ${route.publicModelId} → ${route.upstreamModelId}.`);
    } catch (e) {
      // 409 last_route surfaces the guard's message verbatim
      toast.error(String((e as Error).message));
    } finally {
      setDeleteOpen(false);
    }
  };

  return (
    <div className="rounded-xl border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono">{route.upstreamModelId}</code>
        <Badge variant="outline" className="text-[10px]">
          {providerTypeLabel(route.providerAccount.providerType)}
        </Badge>
        <span className="text-xs text-muted-foreground">{route.providerAccount.name}</span>
        {!route.providerAccount.enabled && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">Account disabled</Badge>
        )}
        {route.providerAccount.lastStatus === 'error' && (
          <Badge variant="outline" className="border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-400">
            Failing validation
          </Badge>
        )}
        <HealthBadge status={route.healthStatus} />
        <div className="ml-auto flex items-center gap-2">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Route priority (lower wins within the model)">
            P
            <Input
              value={priorityDraft}
              inputMode="numeric"
              onChange={(e) => {
                setPriorityDraft(e.target.value.replace(/\D/g, ''));
                setPriorityDirty(true);
              }}
              onBlur={() => void commitPriority()}
              onKeyDown={(e) => e.key === 'Enter' && void commitPriority()}
              aria-label={`Priority for route ${route.publicModelId} → ${route.upstreamModelId}`}
              className="h-7 w-14 px-1.5 text-xs"
            />
          </span>
          <Switch
            checked={route.enabled}
            onCheckedChange={(v) => void toggleEnabled(v)}
            aria-label={`Enable route ${route.publicModelId} → ${route.upstreamModelId}`}
          />
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Served: {route.lastServedAt ? timeAgo(route.lastServedAt) : 'never'}</span>
        <span>Timeout: {(route.timeoutMs / 1000).toFixed(0)}s</span>
        <span>Weight: {route.weight}</span>
        {route.lastError ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button className="inline-flex items-center gap-1 text-destructive/90" aria-label="Show last route error">
                <CircleAlert className="size-3" /> Last error
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{route.lastError}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void resetHealth()}
          disabled={update.isPending}
          title="Reset health status and clear the last error"
        >
          <HeartPulse className="size-3" /> Reset health
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 text-xs text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3" /> Delete
        </Button>
      </div>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove route {route.publicModelId} → {route.upstreamModelId}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The router stops using this path immediately. A model must keep at least one route — the server rejects
              deleting the last one for a model.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void doDelete()}>
              Remove route
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RouteGroup({ publicModelId, routes, model }: { publicModelId: string; routes: ModelRouteRow[]; model?: ModelInfo }) {
  return (
    <section className="space-y-2" aria-label={`Routes for ${publicModelId}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{model?.displayName ?? publicModelId}</span>
        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{publicModelId}</code>
        {model?.generation ? <span className="text-[10px] text-muted-foreground">gen {model.generation}</span> : null}
        {!model && <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">Model missing</Badge>}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {routes.length} route{routes.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="space-y-2">
        {routes.map((r) => (
          <RouteRow key={r.id} route={r} />
        ))}
      </div>
    </section>
  );
}

export function RoutesTab() {
  const routesQuery = useRoutes();
  const modelsQuery = useModels();
  const providersQuery = useProviders();
  const create = useCreateRoute();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    publicModelId: '',
    providerAccountId: '',
    upstreamModelId: '',
    priority: '0',
    enabled: true,
  });

  const routes = routesQuery.data?.routes ?? [];
  const models = modelsQuery.data?.models ?? [];
  const emoraiModels = models.filter((m) => m.category === 'emorai');
  const enabledAccounts = (providersQuery.data?.accounts ?? []).filter((a) => a.enabled);

  // Registry-sized lists (tens of rows) — plain computation is cheaper than memoization
  const modelById = new Map(models.map((m) => [m.modelId, m] as const));
  const groups: Array<[string, ModelRouteRow[]]> = [];
  const groupIndex = new Map<string, number>();
  for (const r of routes) {
    const idx = groupIndex.get(r.publicModelId);
    if (idx === undefined) {
      groupIndex.set(r.publicModelId, groups.length);
      groups.push([r.publicModelId, [r]]);
    } else {
      groups[idx][1].push(r);
    }
  }

  const addRoute = async () => {
    if (!form.publicModelId) {
      toast.error('Choose the EmorAI model this route serves.');
      return;
    }
    if (!form.providerAccountId) {
      toast.error('Choose a provider account to route through.');
      return;
    }
    if (!form.upstreamModelId.trim()) {
      toast.error('Enter the upstream model ID the provider should execute.');
      return;
    }
    try {
      const res = await create.mutateAsync({
        publicModelId: form.publicModelId,
        providerAccountId: form.providerAccountId,
        upstreamModelId: form.upstreamModelId.trim(),
        priority: Number(form.priority) || 0,
        enabled: form.enabled,
      });
      toast.success(`Route added: ${form.publicModelId} → ${form.upstreamModelId.trim()}.`);
      const preview = res.preview;
      if (preview) {
        if (preview.routed && preview.candidates.length > 0) {
          const first = preview.candidates[0];
          toast.info(
            `Router preview: ${preview.candidates.length} eligible route${preview.candidates.length === 1 ? '' : 's'} — first: ${first.upstreamModel} @ ${first.providerType} (${first.account}).`,
          );
        } else if (preview.rejected.length > 0) {
          toast.info(`Router preview: no eligible route yet — ${preview.rejected[0].reason}.`);
        } else {
          toast.info('Router preview: no eligible route for this model yet.');
        }
      }
      setForm({ publicModelId: '', providerAccountId: '', upstreamModelId: '', priority: '0', enabled: true });
      setAdding(false);
    } catch (e) {
      // unknown_model / unknown_account / not_routable / duplicate_route messages verbatim
      toast.error(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Model routing</p>
          <p className="text-xs text-muted-foreground">
            Each EmorAI model routes to an upstream model on a provider account. The router picks the best eligible
            route per request — eligibility is computed from real status, never guessed.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-3.5" /> Add route
        </Button>
      </div>

      {adding && (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="route-model">EmorAI model (public ID)</Label>
              <Select value={form.publicModelId} onValueChange={(v) => setForm((f) => ({ ...f, publicModelId: v }))}>
                <SelectTrigger id="route-model" className="w-full">
                  <SelectValue placeholder="Choose a model" />
                </SelectTrigger>
                <SelectContent>
                  {emoraiModels.map((m) => (
                    <SelectItem key={m.id} value={m.modelId}>
                      {m.displayName} · {m.modelId}
                      {m.enabled ? '' : ' · disabled'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {emoraiModels.length === 0 && !modelsQuery.isLoading && (
                <p className="text-[10px] text-muted-foreground">
                  No EmorAI family models in the registry yet — add one in the Models tab first. Provider-catalogue
                  models are served directly and cannot have routes.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-account">Provider account</Label>
              <Select
                value={form.providerAccountId}
                onValueChange={(v) => setForm((f) => ({ ...f, providerAccountId: v }))}
              >
                <SelectTrigger id="route-account" className="w-full">
                  <SelectValue placeholder="Choose an account" />
                </SelectTrigger>
                <SelectContent>
                  {enabledAccounts.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} · {providerTypeLabel(a.providerType)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {enabledAccounts.length === 0 && !providersQuery.isLoading && (
                <p className="text-[10px] text-muted-foreground">
                  No enabled provider accounts — add or enable one in the Providers tab first.
                </p>
              )}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="route-upstream">Upstream model ID</Label>
              <Input
                id="route-upstream"
                value={form.upstreamModelId}
                onChange={(e) => setForm((f) => ({ ...f, upstreamModelId: e.target.value }))}
                placeholder="e.g. glm-4.7-airx"
                maxLength={160}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="route-prio">Priority (lower wins within the model)</Label>
              <Input
                id="route-prio"
                inputMode="numeric"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                aria-label="Enable route immediately"
              />
              Enable immediately
            </label>
            <Button
              size="sm"
              onClick={() => void addRoute()}
              disabled={create.isPending || emoraiModels.length === 0 || enabledAccounts.length === 0}
              className="gap-1.5"
            >
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add route
            </Button>
          </div>
        </div>
      )}

      {routesQuery.isLoading && (
        <div className="space-y-2.5" aria-label="Loading routes">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}

      {routesQuery.error && (
        <div className="rounded-xl border border-destructive/40 p-4 text-center">
          <p className="text-sm font-medium text-destructive">Failed to load routes</p>
          <p className="mt-1 text-xs text-muted-foreground">{String((routesQuery.error as Error).message)}</p>
          <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => void routesQuery.refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!routesQuery.isLoading && !routesQuery.error && groups.length === 0 && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <RouteIcon className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No routes configured</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            EmorAI family models need at least one route before they can serve requests — create a provider account in
            the Providers tab, then add a route here. Provider-catalogue models are served directly without routes.
          </p>
        </div>
      )}

      <div className="space-y-5">
        {groups.map(([publicModelId, groupRoutes]) => (
          <RouteGroup
            key={publicModelId}
            publicModelId={publicModelId}
            routes={groupRoutes}
            model={modelById.get(publicModelId)}
          />
        ))}
      </div>
    </div>
  );
}
