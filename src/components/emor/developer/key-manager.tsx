'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  CheckCircle2,
  KeyRound,
  Loader2,
  Lock,
  Settings2,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { useApiKeys } from '@/hooks/use-emor-queries';
import type { SerializedApiKey } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { cn } from '@/lib/utils';

// ─── Constants ───────────────────────────────────────────────────────────────

const ALL_SCOPES = ['chat', 'tools', 'vision', 'media', 'models', 'usage'] as const;
type Scope = (typeof ALL_SCOPES)[number];

const SCOPE_HELP: Record<Scope, string> = {
  chat: 'Chat completions (both protocols)',
  tools: 'Tool / function calling',
  vision: 'Image inputs',
  media: 'Images, speech and video generation',
  models: 'Model listing',
  usage: 'Per-key usage reports',
};

// ─── Key editor dialog ───────────────────────────────────────────────────────

type KeyDraft = {
  scopes: Set<Scope>;
  rateLimit: string;
  monthlyRequests: string;
  monthlyTokens: string;
  allowedModels: string;
};

function draftOf(key: SerializedApiKey): KeyDraft {
  return {
    scopes: new Set((key.scopes ?? [...ALL_SCOPES]) as Scope[]),
    rateLimit: key.rateLimitPerMin != null ? String(key.rateLimitPerMin) : '',
    monthlyRequests: key.monthlyRequestLimit != null ? String(key.monthlyRequestLimit) : '',
    monthlyTokens: key.monthlyTokenLimit != null ? String(key.monthlyTokenLimit) : '',
    allowedModels: (key.allowedModels ?? []).join(', '),
  };
}

function KeySettingsDialog({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: SerializedApiKey | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<KeyDraft | null>(null);
  const [saving, setSaving] = useState(false);

  // Reset the draft whenever a different key opens
  if (apiKey && draft === null) {
    setDraft(draftOf(apiKey));
  }
  if (!open && draft !== null) {
    setDraft(null);
  }
  if (!apiKey || !draft) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg" />
      </Dialog>
    );
  }

  const toggleScope = (s: Scope) => {
    const next = new Set(draft.scopes);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    setDraft({ ...draft, scopes: next });
  };

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/keys/${apiKey.id}`, {
        scopes: [...draft.scopes],
        ...(draft.rateLimit.trim() ? { rateLimitPerMin: Number(draft.rateLimit) } : { rateLimitPerMin: null }),
        ...(draft.monthlyRequests.trim()
          ? { monthlyRequestLimit: Number(draft.monthlyRequests) }
          : { monthlyRequestLimit: null }),
        ...(draft.monthlyTokens.trim() ? { monthlyTokenLimit: Number(draft.monthlyTokens) } : { monthlyTokenLimit: null }),
        ...(draft.allowedModels.trim()
          ? { allowedModels: draft.allowedModels.split(',').map((m) => m.trim()).filter(Boolean) }
          : { allowedModels: null }),
      });
      void qc.invalidateQueries({ queryKey: ['keys'] });
      toast.success(`Permissions saved for “${apiKey.name}”`);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save key settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            Key permissions — {apiKey.name}
          </DialogTitle>
          <DialogDescription>
            Scopes gate what the key may call; limits cap its usage. Empty means unlimited / global
            default.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="mb-2 block text-sm">Permission scopes</Label>
            <div className="grid grid-cols-2 gap-2">
              {ALL_SCOPES.map((s) => (
                <label
                  key={s}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 transition-colors hover:bg-muted/40"
                >
                  <Switch
                    checked={draft.scopes.has(s)}
                    onCheckedChange={() => toggleScope(s)}
                    aria-label={`Allow ${s}`}
                    className="mt-0.5"
                  />
                  <span className="min-w-0">
                    <span className="block font-mono text-xs font-medium">{s}</span>
                    <span className="block text-[11px] leading-tight text-muted-foreground">
                      {SCOPE_HELP[s]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="key-rl" className="text-xs">
                Rate limit (requests/min)
              </Label>
              <Input
                id="key-rl"
                inputMode="numeric"
                value={draft.rateLimit}
                onChange={(e) => setDraft({ ...draft, rateLimit: e.target.value.replace(/\D/g, '') })}
                placeholder="global default"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-mr" className="text-xs">
                Monthly request limit
              </Label>
              <Input
                id="key-mr"
                inputMode="numeric"
                value={draft.monthlyRequests}
                onChange={(e) => setDraft({ ...draft, monthlyRequests: e.target.value.replace(/\D/g, '') })}
                placeholder="unlimited"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-mt" className="text-xs">
                Monthly token limit
              </Label>
              <Input
                id="key-mt"
                inputMode="numeric"
                value={draft.monthlyTokens}
                onChange={(e) => setDraft({ ...draft, monthlyTokens: e.target.value.replace(/\D/g, '') })}
                placeholder="unlimited"
                className="h-8 text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="key-am" className="text-xs">
                Allowed models (comma-separated)
              </Label>
              <Input
                id="key-am"
                value={draft.allowedModels}
                onChange={(e) => setDraft({ ...draft, allowedModels: e.target.value })}
                placeholder="all models"
                className="h-8 text-xs"
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            Save permissions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Keys table ──────────────────────────────────────────────────────────────

type ConfirmAction = { key: SerializedApiKey; mode: 'revoke' | 'delete' };

function scopeSummary(key: SerializedApiKey): { label: string; full: boolean; count: number } {
  const scopes = key.scopes ?? [];
  const full = scopes.length >= ALL_SCOPES.length;
  return { label: full ? 'full access' : scopes.join(' · '), full, count: scopes.length };
}

function limitsSummary(key: SerializedApiKey): string[] {
  const parts: string[] = [];
  if (key.rateLimitPerMin) parts.push(`${key.rateLimitPerMin}/min`);
  if (key.monthlyRequestLimit) parts.push(`${key.monthlyRequestLimit.toLocaleString()} req/mo`);
  if (key.monthlyTokenLimit) parts.push(`${key.monthlyTokenLimit.toLocaleString()} tok/mo`);
  if (key.allowedModels && key.allowedModels.length > 0)
    parts.push(`${key.allowedModels.length} model${key.allowedModels.length > 1 ? 's' : ''}`);
  return parts;
}

export function KeysTable() {
  const qc = useQueryClient();
  const { data, isLoading } = useApiKeys();
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsFor, setSettingsFor] = useState<SerializedApiKey | null>(null);

  const keys = data?.keys ?? [];

  async function runConfirm() {
    if (!confirm) return;
    setBusy(true);
    const { key, mode } = confirm;
    try {
      if (mode === 'revoke') {
        await api.patch(`/api/keys/${key.id}`, { action: 'revoke' });
        toast.success(`Key “${key.name}” revoked`);
      } else {
        await api.del(`/api/keys/${key.id}`);
        toast.success(`Key “${key.name}” permanently deleted`);
      }
      void qc.invalidateQueries({ queryKey: ['keys'] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Failed to ${mode} key`);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" />
          Your API keys
        </CardTitle>
        <CardDescription>
          Permissions, usage limits and revocation — external apps only ever see these keys, never
          provider credentials.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : keys.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-8 text-center">
            <KeyRound className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              No API keys yet — create your first key in the quickstart above.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead>Permissions</TableHead>
                  <TableHead>Limits</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead className="text-right">Requests</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((key) => {
                  const revoked = key.revokedAt !== null;
                  const scope = scopeSummary(key);
                  const limits = limitsSummary(key);
                  return (
                    <TableRow key={key.id}>
                      <TableCell className="max-w-40 truncate font-medium">{key.name}</TableCell>
                      <TableCell>
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          {key.prefix}…
                        </code>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={cn(
                            'max-w-40 truncate font-mono text-[10px]',
                            scope.full
                              ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'border-amber-500/20 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                          )}
                          title={scope.label}
                        >
                          {scope.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {limits.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          <span className="font-mono text-[10px] text-muted-foreground" title={limits.join(' · ')}>
                            {limits.join(' · ')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(key.createdAt).toLocaleDateString()}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {key.requestCount.toLocaleString()}
                      </TableCell>
                      <TableCell>
                        {revoked ? (
                          <span className="inline-flex items-center gap-1 rounded-full border border-red-500/20 bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
                            <Ban className="size-3" /> Revoked
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                            <CheckCircle2 className="size-3" /> Active
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {!revoked ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1 px-2 text-xs"
                              onClick={() => setSettingsFor(key)}
                              title="Edit permissions and limits"
                            >
                              <Settings2 className="size-3.5" />
                            </Button>
                          ) : null}
                          {revoked ? (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 gap-1.5 px-2 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-400"
                              onClick={() => setConfirm({ key, mode: 'delete' })}
                            >
                              <Trash2 className="size-3.5" /> Delete
                            </Button>
                          ) : (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 gap-1.5 px-2 text-xs"
                              onClick={() => setConfirm({ key, mode: 'revoke' })}
                            >
                              <Ban className="size-3.5" /> Revoke
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <KeySettingsDialog
        apiKey={settingsFor}
        open={settingsFor !== null}
        onOpenChange={(open) => !open && setSettingsFor(null)}
      />

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.mode === 'delete' ? 'Permanently delete key' : 'Revoke key'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.mode === 'delete' ? (
                <>
                  “{confirm?.key.name}” will be removed forever. Any application still using it will
                  start receiving <code className="font-mono text-xs">401 invalid_api_key</code>.
                </>
              ) : (
                <>
                  “{confirm?.key.name}” will stop working immediately and cannot be un-revoked
                  without restoring it. Requests will fail with{' '}
                  <code className="font-mono text-xs">401 key_revoked</code>.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void runConfirm();
              }}
              disabled={busy}
              className={
                confirm?.mode === 'delete'
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-amber-600 text-white hover:bg-amber-700'
              }
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {confirm?.mode === 'delete' ? 'Delete key' : 'Revoke key'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
