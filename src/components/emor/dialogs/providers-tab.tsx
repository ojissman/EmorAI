"use client";

import { useState } from 'react';
import {
  Check,
  CircleAlert,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Server,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
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
  useCreateProvider,
  useDeleteProvider,
  useProviders,
  useUpdateProvider,
  useValidateProvider,
} from '@/hooks/use-emor-queries';
import type { ProviderAccount, UpdateProviderInput } from '@/hooks/use-emor-queries';
import { providerTypeLabel, timeAgo } from './provider-shared';

/** Last validation outcome as a colored badge (ok / error / not checked). */
function AccountStatusBadge({ account }: { account: ProviderAccount }) {
  if (account.lastStatus === 'ok') {
    return (
      <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
        <span className="size-1.5 rounded-full bg-emerald-500" /> OK
      </Badge>
    );
  }
  if (account.lastStatus === 'error') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="gap-1 border-destructive/40 text-[10px] text-destructive">
            <CircleAlert className="size-2.5" /> Error
          </Badge>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{account.lastError ?? 'Last validation failed'}</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] text-muted-foreground">
      Not checked
    </Badge>
  );
}

function ProviderAccountCard({ account }: { account: ProviderAccount }) {
  const update = useUpdateProvider();
  const remove = useDeleteProvider();
  const validate = useValidateProvider();
  const isZai = account.providerType === 'zai';

  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: account.name,
    baseUrl: account.baseUrl ?? '',
    apiKey: '',
    priority: String(account.priority),
    maxConcurrency: String(account.maxConcurrency),
    monthlyBudget: account.monthlyBudget === null ? '' : String(account.monthlyBudget),
  });

  const resetDraft = () =>
    setDraft({
      name: account.name,
      baseUrl: account.baseUrl ?? '',
      apiKey: '',
      priority: String(account.priority),
      maxConcurrency: String(account.maxConcurrency),
      monthlyBudget: account.monthlyBudget === null ? '' : String(account.monthlyBudget),
    });

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await update.mutateAsync({ id: account.id, enabled });
      toast.success(`“${account.name}” ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const runValidate = async () => {
    try {
      const res = await validate.mutateAsync(account.id);
      if (res.validation.ok) {
        toast.success(
          `“${account.name}”: ${res.validation.message}${res.health.ok ? ` — health OK (${res.health.latencyMs} ms)` : ''}`,
        );
      } else {
        toast.error(`“${account.name}”: ${res.validation.detail ?? res.validation.message}`);
      }
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const saveEdits = async () => {
    const patch: UpdateProviderInput & { id: string } = { id: account.id };
    if (draft.name.trim() && draft.name.trim() !== account.name) patch.name = draft.name.trim();
    if (!isZai) {
      if (draft.baseUrl.trim() !== (account.baseUrl ?? '')) {
        const url = draft.baseUrl.trim();
        if (!url) {
          toast.error('This provider type requires a base URL.');
          return;
        }
        try {
          new URL(url);
        } catch {
          toast.error('Base URL must be a valid URL, e.g. https://api.example.com/v1');
          return;
        }
        patch.baseUrl = url;
      }
      if (draft.apiKey.trim()) patch.apiKey = draft.apiKey.trim();
    }
    const priority = Number(draft.priority);
    if (draft.priority !== '' && Number.isFinite(priority) && Math.trunc(priority) !== account.priority) {
      patch.priority = Math.trunc(priority);
    }
    const concurrency = Number(draft.maxConcurrency);
    if (draft.maxConcurrency !== '' && Number.isFinite(concurrency) && Math.trunc(concurrency) !== account.maxConcurrency) {
      patch.maxConcurrency = Math.trunc(concurrency);
    }
    if (draft.monthlyBudget.trim() === '') {
      if (account.monthlyBudget !== null) patch.monthlyBudget = null;
    } else {
      const budget = Number(draft.monthlyBudget);
      if (Number.isFinite(budget) && budget !== account.monthlyBudget) patch.monthlyBudget = budget;
    }
    if (Object.keys(patch).length <= 1) {
      // id only — nothing changed
      setEditing(false);
      return;
    }
    try {
      await update.mutateAsync(patch);
      toast.success('Account updated.');
      resetDraft();
      setEditing(false);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const clearStoredKey = async () => {
    try {
      await update.mutateAsync({ id: account.id, clearApiKey: true });
      toast.success('Stored credential cleared. The account can no longer authenticate until a new key is set.');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const doDelete = async () => {
    try {
      await remove.mutateAsync(account.id);
      toast.success(`“${account.name}” deleted.`);
    } catch (e) {
      // 409 in_use surfaces the blocking route count verbatim
      toast.error(String((e as Error).message));
    } finally {
      setDeleteOpen(false);
    }
  };

  return (
    <div className="rounded-xl border p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{account.name}</span>
        <Badge variant="outline" className="text-[10px]">{providerTypeLabel(account.providerType)}</Badge>
        <AccountStatusBadge account={account} />
        {!account.enabled && (
          <Badge variant="outline" className="text-[10px] text-muted-foreground">Disabled</Badge>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Switch
            checked={account.enabled}
            onCheckedChange={(v) => void toggleEnabled(v)}
            aria-label={`Enable ${account.name}`}
          />
        </div>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
        {account.baseUrl ? (
          <code className="rounded bg-muted px-1.5 py-0.5 text-[10px]">{account.baseUrl}</code>
        ) : (
          <span>Platform credentials (server environment)</span>
        )}
        {account.credentialMode === 'stored' ? (
          <span className="inline-flex items-center gap-1">
            <KeyRound className="size-3" />
            Stored key {account.credentialHint ?? '—'}
          </span>
        ) : null}
        {account.monthlyBudget !== null ? <span>Budget {account.monthlyBudget.toLocaleString()}/mo</span> : null}
      </div>

      {account.lastStatus === 'error' && account.lastError ? (
        <p className="mt-1.5 truncate text-xs text-destructive/90" title={account.lastError}>
          {account.lastError}
        </p>
      ) : null}

      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
        <span>Requests: {account.requestCount.toLocaleString()}</span>
        <span>Routes: {account.routeCount}</span>
        <span>Priority: {account.priority}</span>
        <span>Checked: {account.lastCheckedAt ? timeAgo(account.lastCheckedAt) : 'never'}</span>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void runValidate()}
          disabled={validate.isPending}
          title="Run a real (non-billable) credential check against the upstream provider"
        >
          {validate.isPending ? <Loader2 className="size-3 animate-spin" /> : <ShieldCheck className="size-3" />}
          Validate
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setEditing((v) => !v)}>
          <Pencil className="size-3" /> Edit
        </Button>
        {account.credentialMode === 'stored' && account.credentialHint ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={() => void clearStoredKey()}
            disabled={update.isPending}
            title="Remove the encrypted credential from this account"
          >
            <KeyRound className="size-3" /> Clear key
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 gap-1 text-xs text-destructive hover:text-destructive"
          onClick={() => setDeleteOpen(true)}
        >
          <Trash2 className="size-3" /> Delete
        </Button>
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-xl border bg-muted/30 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={`acc-name-${account.id}`}>Name</Label>
              <Input
                id={`acc-name-${account.id}`}
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                maxLength={80}
              />
            </div>
            {!isZai && (
              <div className="space-y-1.5">
                <Label htmlFor={`acc-url-${account.id}`}>Base URL</Label>
                <Input
                  id={`acc-url-${account.id}`}
                  value={draft.baseUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                />
              </div>
            )}
            {!isZai && (
              <div className="space-y-1.5">
                <Label htmlFor={`acc-key-${account.id}`}>API key (rotate)</Label>
                <Input
                  id={`acc-key-${account.id}`}
                  type="password"
                  autoComplete="new-password"
                  value={draft.apiKey}
                  onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                  placeholder="Leave blank to keep the current key"
                />
                <p className="text-[10px] text-muted-foreground">Encrypted at rest; never displayed again after saving.</p>
              </div>
            )}
            <div className="space-y-1.5">
              <Label htmlFor={`acc-prio-${account.id}`}>Priority (lower wins)</Label>
              <Input
                id={`acc-prio-${account.id}`}
                inputMode="numeric"
                value={draft.priority}
                onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`acc-conc-${account.id}`}>Max concurrency (0 = unlimited)</Label>
              <Input
                id={`acc-conc-${account.id}`}
                inputMode="numeric"
                value={draft.maxConcurrency}
                onChange={(e) => setDraft((d) => ({ ...d, maxConcurrency: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`acc-budget-${account.id}`}>Monthly budget (optional)</Label>
              <Input
                id={`acc-budget-${account.id}`}
                inputMode="decimal"
                value={draft.monthlyBudget}
                onChange={(e) => setDraft((d) => ({ ...d, monthlyBudget: e.target.value.replace(/[^0-9.]/g, '') }))}
                placeholder="No budget"
              />
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                resetDraft();
                setEditing(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={() => void saveEdits()} disabled={update.isPending} className="gap-1.5">
              {update.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Save changes
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{account.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The account and its encrypted credential are removed permanently. Accounts referenced by routes cannot be deleted — re-point or remove those routes first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void doDelete()}>
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type AddForm = {
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  priority: string;
  monthlyBudget: string;
};

const EMPTY_ADD_FORM: AddForm = { name: '', providerType: '', baseUrl: '', apiKey: '', priority: '0', monthlyBudget: '' };

export function ProvidersTab() {
  const { data, isLoading, error, refetch } = useProviders();
  const create = useCreateProvider();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<AddForm>(EMPTY_ADD_FORM);

  const accounts = data?.accounts ?? [];
  const providerTypes = data?.providerTypes ?? [];
  // The encryption flag is a global server property reported per account; when
  // no accounts exist yet it is unknown and creation attempts surface the
  // server's refusal message verbatim.
  const encryptionAvailable = accounts.length === 0 || accounts.every((a) => a.encryptionAvailable);
  const selectedType = form.providerType;
  const needsStored = selectedType !== 'zai';

  const addAccount = async () => {
    if (!form.name.trim()) {
      toast.error('Give the account a name first.');
      return;
    }
    if (!form.providerType) {
      toast.error('Choose a provider type.');
      return;
    }
    if (form.providerType !== 'zai') {
      if (!form.baseUrl.trim()) {
        toast.error('This provider type requires a base URL.');
        return;
      }
      try {
        new URL(form.baseUrl.trim());
      } catch {
        toast.error('Base URL must be a valid URL, e.g. https://api.example.com/v1');
        return;
      }
      if (form.apiKey.trim().length < 8) {
        toast.error('This provider type requires an API key (at least 8 characters).');
        return;
      }
      if (!encryptionAvailable) {
        toast.error('Set EMORAI_MASTER_KEY in the environment to store credentials.');
        return;
      }
    }
    try {
      await create.mutateAsync({
        name: form.name.trim(),
        providerType: form.providerType,
        ...(form.providerType !== 'zai' ? { baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() } : {}),
        credentialMode: form.providerType === 'zai' ? 'platform' : 'stored',
        enabled: true,
        priority: Number(form.priority) || 0,
        maxConcurrency: 0,
        ...(form.monthlyBudget.trim() ? { monthlyBudget: Number(form.monthlyBudget) } : {}),
      });
      toast.success(`Provider account “${form.name.trim()}” added.`);
      setForm(EMPTY_ADD_FORM);
      setAdding(false);
    } catch (e) {
      // includes the 500 encryption_unavailable refusal with its clear message
      toast.error(String((e as Error).message));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Provider accounts</p>
          <p className="text-xs text-muted-foreground">
            Upstream accounts the router can send EmorAI model traffic to. Credentials are encrypted at rest and never returned to the browser.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setAdding((v) => !v)}>
          <Plus className="size-3.5" /> Add provider
        </Button>
      </div>

      {!encryptionAvailable && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5">
          <p className="flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
            <CircleAlert className="size-4" /> Credential storage is disabled
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Set EMORAI_MASTER_KEY in the environment to store credentials. Until then only platform-credential accounts (Z.ai) can be added.
          </p>
        </div>
      )}

      {adding && (
        <div className="space-y-3 rounded-xl border bg-muted/30 p-3.5">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prov-name">Account name</Label>
              <Input
                id="prov-name"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Team OpenAI relay"
                maxLength={80}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prov-type">Provider type</Label>
              <Select
                value={form.providerType}
                onValueChange={(v) => setForm((f) => ({ ...f, providerType: v }))}
              >
                <SelectTrigger id="prov-type" className="w-full">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {providerTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {providerTypeLabel(t)}
                      {t === 'zai' ? ' — platform credentials' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {providerTypes.length === 0 && !isLoading && (
                <p className="text-[10px] text-muted-foreground">No provider adapters are registered on this installation.</p>
              )}
            </div>
          </div>
          {form.providerType !== '' && form.providerType !== 'zai' && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="prov-url">Base URL</Label>
                <Input
                  id="prov-url"
                  value={form.baseUrl}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="https://api.example.com/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="prov-key">API key</Label>
                <Input
                  id="prov-key"
                  type="password"
                  autoComplete="new-password"
                  value={form.apiKey}
                  onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  placeholder="Stored encrypted — shown once here, never displayed again"
                />
              </div>
            </>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="prov-prio">Priority (lower wins)</Label>
              <Input
                id="prov-prio"
                inputMode="numeric"
                value={form.priority}
                onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value.replace(/\D/g, '') }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prov-budget">Monthly budget (optional)</Label>
              <Input
                id="prov-budget"
                inputMode="decimal"
                value={form.monthlyBudget}
                onChange={(e) => setForm((f) => ({ ...f, monthlyBudget: e.target.value.replace(/[^0-9.]/g, '') }))}
                placeholder="No budget"
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {form.providerType === 'zai'
                ? 'Z.ai accounts use platform credentials managed on the server — no key is stored.'
                : 'The key is encrypted with EMORAI_MASTER_KEY before it is written to the database.'}
            </p>
            <Button
              size="sm"
              onClick={() => void addAccount()}
              disabled={create.isPending || (needsStored && !encryptionAvailable)}
              className="gap-1.5"
              title={
                needsStored && !encryptionAvailable
                  ? 'Set EMORAI_MASTER_KEY in the environment to store credentials'
                  : undefined
              }
            >
              {create.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
              Add account
            </Button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2.5" aria-label="Loading provider accounts">
          <Skeleton className="h-28 w-full rounded-xl" />
          <Skeleton className="h-28 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-destructive/40 p-4 text-center">
          <p className="text-sm font-medium text-destructive">Failed to load provider accounts</p>
          <p className="mt-1 text-xs text-muted-foreground">{String((error as Error).message)}</p>
          <Button variant="outline" size="sm" className="mt-3 gap-1.5" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !error && accounts.length === 0 && (
        <div className="rounded-xl border border-dashed p-6 text-center">
          <Server className="mx-auto size-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium">No provider accounts yet</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Add an upstream account (OpenAI-compatible, Anthropic-compatible, self-hosted, or the built-in Z.ai gateway)
            and then map EmorAI models to it in the Routing tab. EmorAI family models need at least one route before
            they can serve requests; provider-catalogue models are served directly.
          </p>
        </div>
      )}

      <div className="space-y-2.5">
        {accounts.map((account) => (
          <ProviderAccountCard key={account.id} account={account} />
        ))}
      </div>
    </div>
  );
}
