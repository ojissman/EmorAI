"use client";

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, Copy, KeyRound, Loader2, Plus, ShieldCheck, Trash2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { useApiKeys } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';
import type { SerializedApiKey } from '@/lib/types';

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

export function KeysDialog() {
  const dialog = useEmorStore((s) => s.dialog);
  const closeDialog = useEmorStore((s) => s.closeDialog);
  const openDialog = useEmorStore((s) => s.openDialog);
  const { data, isLoading } = useApiKeys(dialog === 'keys');
  const qc = useQueryClient();

  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [plaintextReveal, setPlaintextReveal] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SerializedApiKey | null>(null);

  const refresh = () => void qc.invalidateQueries({ queryKey: ['keys'] });

  const create = async () => {
    if (!name.trim()) {
      toast.error('Give the key a name first.');
      return;
    }
    setCreating(true);
    try {
      const res = await api.post<{ key: SerializedApiKey; plaintext: string }>('/api/keys', { name: name.trim() });
      setPlaintextReveal(res.plaintext);
      setName('');
      refresh();
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setCreating(false);
    }
  };

  const copyPlaintext = async () => {
    if (!plaintextReveal) return;
    try {
      await navigator.clipboard.writeText(plaintextReveal);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Copy failed — select the text manually.');
    }
  };

  const revoke = async (key: SerializedApiKey) => {
    try {
      await api.patch(`/api/keys/${key.id}`, { action: 'revoke' });
      refresh();
      toast.success(`“${key.name}” revoked. Requests with it are rejected immediately.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const restore = async (key: SerializedApiKey) => {
    try {
      await api.patch(`/api/keys/${key.id}`, { action: 'restore' });
      refresh();
      toast.success(`“${key.name}” restored.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await api.del(`/api/keys/${deleteTarget.id}`);
      refresh();
      toast.success(`“${deleteTarget.name}” deleted.`);
    } catch (e) {
      toast.error(String((e as Error).message));
    } finally {
      setDeleteTarget(null);
    }
  };

  const keys = data?.keys ?? [];

  return (
    <Dialog open={dialog === 'keys'} onOpenChange={(v) => (!v ? closeDialog() : undefined)}>
      <DialogContent className="max-h-[85vh] overflow-y-auto emor-scroll sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" /> EmorAI API keys
          </DialogTitle>
          <DialogDescription>
            Keys authenticate external applications against the EmorAI developer API (<code className="rounded bg-muted px-1">/api/v1</code>).
            Only a SHA-256 hash is stored — the plaintext is shown once, right after creation.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-xl border bg-muted/30 p-3.5">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-1.5">
                <Label htmlFor="key-name">Key name</Label>
                <Input
                  id="key-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Mobile app, CI bot, Home server"
                  maxLength={60}
                  onKeyDown={(e) => e.key === 'Enter' && void create()}
                />
              </div>
              <Button onClick={() => void create()} disabled={creating} className="gap-1.5">
                {creating ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
                Generate key
              </Button>
            </div>
          </div>

          {plaintextReveal && (
            <div className="rounded-xl border border-primary/40 bg-primary/5 p-3.5">
              <p className="flex items-center gap-1.5 text-sm font-medium text-primary">
                <ShieldCheck className="size-4" /> Copy your key now — it will not be shown again
              </p>
              <div className="mt-2.5 flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg border bg-background px-3 py-2 font-mono text-xs">{plaintextReveal}</code>
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void copyPlaintext()}>
                  {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <Button variant="ghost" size="sm" className="mt-2 h-6 text-xs text-muted-foreground" onClick={() => setPlaintextReveal(null)}>
                Dismiss
              </Button>
            </div>
          )}

          <div className="space-y-2.5">
            {isLoading && <p className="py-4 text-center text-sm text-muted-foreground"><Loader2 className="mx-auto size-4 animate-spin" /></p>}
            {!isLoading && keys.length === 0 && (
              <div className="rounded-xl border border-dashed p-6 text-center">
                <KeyRound className="mx-auto size-6 text-muted-foreground" />
                <p className="mt-2 text-sm font-medium">No API keys yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Generate a key to connect external apps to your EmorAI instance.</p>
              </div>
            )}
            {keys.map((key) => (
              <div key={key.id} className="rounded-xl border p-3.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{key.name}</span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{key.prefix}</code>
                  {key.revokedAt ? (
                    <Badge variant="outline" className="gap-1 border-destructive/40 text-[10px] text-destructive">
                      <CircleAlert className="size-2.5" /> Revoked
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
                      <span className="size-1.5 rounded-full bg-emerald-500" /> Active
                    </Badge>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    {key.revokedAt ? (
                      <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => void restore(key)}>
                        <Undo2 className="size-3" /> Restore
                      </Button>
                    ) : (
                      <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs text-destructive hover:text-destructive" onClick={() => void revoke(key)}>
                        <CircleAlert className="size-3" /> Revoke
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(key)} aria-label={`Delete ${key.name}`}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                  <span>Created: {formatDate(key.createdAt)}</span>
                  <span>Last used: {formatDate(key.lastUsedAt)}</span>
                  <span>Requests: {key.requestCount.toLocaleString()}</span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Single-owner installation: keys grant access to this instance&apos;s provider quota — do not share them publicly.
            <button className="ml-1 text-primary underline underline-offset-2" onClick={() => openDialog('docs')}>
              Read the API documentation
            </button>
          </p>
        </div>

        <AlertDialog open={!!deleteTarget} onOpenChange={(v) => (!v ? setDeleteTarget(null) : undefined)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete “{deleteTarget?.name}”?</AlertDialogTitle>
              <AlertDialogDescription>
                The key record is removed permanently. Any application still using it will receive 401 responses.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={() => void remove()}>
                Delete key
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
