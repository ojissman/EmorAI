"use client";

// Network egress policy editor (Phase 10, Priority 2 frontend) — lives in the
// Settings dialog's Security tab. Edits the `network` block of AppSettings:
// allowlist (private/self-hosted destinations), requireHttps, maxResponseBytes.

import { useState } from 'react';
import { Check, Globe, Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { useSettings, useSettingsMutation } from '@/hooks/use-emor-queries';
import type { NetworkSettings } from '@/lib/types';

const MIN_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024;

// hostname / IPv4, optionally with :port (1-65535) — the allowlist shape the
// server accepts (string entries, max 253 chars each)
const ENTRY_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

function normalizeEntry(raw: string): { value: string; error: string | null } {
  const value = raw.trim().toLowerCase();
  if (!value) return { value: '', error: 'Enter a hostname or host:port entry first.' };
  if (value.length > 253) return { value, error: 'Entries must be at most 253 characters.' };
  if (!ENTRY_PATTERN.test(value)) {
    return { value, error: 'Not a valid host or host:port (e.g. api.example.com or 127.0.0.1:3999).' };
  }
  const portStr = value.includes(':') ? value.slice(value.lastIndexOf(':') + 1) : null;
  if (portStr) {
    const port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { value, error: 'Port must be between 1 and 65535.' };
    }
  }
  return { value, error: null };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes % (1024 * 1024) === 0 ? 0 : 1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function NetworkSection() {
  const { data } = useSettings();
  const settingsMutation = useSettingsMutation();
  const network: NetworkSettings | undefined = data?.settings.network;

  const [allowlist, setAllowlist] = useState<string[] | null>(null);
  const [requireHttps, setRequireHttps] = useState<boolean | null>(null);
  const [maxResponseBytes, setMaxResponseBytes] = useState<string | null>(null);
  const [entry, setEntry] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const [bytesError, setBytesError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Load the stored network block into the draft once it arrives.
  if (network && !initialized) {
    setAllowlist([...network.allowlist]);
    setRequireHttps(network.requireHttps);
    setMaxResponseBytes(String(network.maxResponseBytes));
    setInitialized(true);
  }

  const dirty =
    network !== undefined &&
    allowlist !== null &&
    requireHttps !== null &&
    maxResponseBytes !== null &&
    (allowlist.join('\n') !== network.allowlist.join('\n') ||
      requireHttps !== network.requireHttps ||
      Math.trunc(Number(maxResponseBytes)) !== network.maxResponseBytes);

  const addEntry = () => {
    if (allowlist === null) return;
    const { value, error } = normalizeEntry(entry);
    if (error) {
      setEntryError(error);
      return;
    }
    if (allowlist.includes(value)) {
      setEntryError('Already allowlisted.');
      return;
    }
    setAllowlist([...allowlist, value]);
    setEntry('');
    setEntryError(null);
  };

  const removeEntry = (value: string) => {
    setAllowlist((list) => (list ?? []).filter((e) => e !== value));
  };

  const save = async () => {
    if (allowlist === null || requireHttps === null || maxResponseBytes === null) return;
    const bytes = Math.trunc(Number(maxResponseBytes));
    if (!Number.isFinite(bytes) || bytes < MIN_RESPONSE_BYTES || bytes > MAX_RESPONSE_BYTES) {
      setBytesError(`Between ${formatBytes(MIN_RESPONSE_BYTES)} and ${formatBytes(MAX_RESPONSE_BYTES)}.`);
      return;
    }
    setBytesError(null);
    try {
      await settingsMutation.mutateAsync({
        network: { allowlist, requireHttps, maxResponseBytes: bytes },
      });
      toast.success('Network policy saved.');
      setInitialized(false); // reload draft from the authoritative response
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  if (!network || allowlist === null || requireHttps === null || maxResponseBytes === null) {
    return (
      <div className="rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <Globe className="size-4 text-primary" />
          <p className="text-sm font-medium">Network & outbound destinations</p>
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
          <Loader2 className="size-3 animate-spin" /> Loading network policy…
        </p>
      </div>
    );
  }

  return (
    <section className="rounded-xl border p-4" aria-label="Network and outbound destinations">
      <div className="flex items-center gap-2">
        <Globe className="size-4 text-primary" />
        <p className="text-sm font-medium">Network & outbound destinations</p>
        {dirty && <Badge variant="outline" className="ml-auto text-[10px] text-amber-600 dark:text-amber-400">Unsaved</Badge>}
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
        Private/self-hosted endpoints (e.g. http://127.0.0.1:3999) are rejected unless allowlisted here. Every
        non-allowlisted external destination must use HTTPS.
      </p>

      <div className="mt-3 space-y-2">
        <Label htmlFor="allowlist-entry">Allowlist (host or host:port)</Label>
        <div className="flex gap-2">
          <Input
            id="allowlist-entry"
            value={entry}
            onChange={(e) => {
              setEntry(e.target.value);
              setEntryError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addEntry();
              }
            }}
            placeholder="e.g. inference.lan or 127.0.0.1:3999"
            className="h-9"
            aria-invalid={entryError ? true : undefined}
            aria-describedby={entryError ? 'allowlist-entry-error' : undefined}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-9 shrink-0 gap-1.5 px-3"
            onClick={addEntry}
            aria-label="Add allowlist entry"
          >
            <Plus className="size-3.5" /> Add
          </Button>
        </div>
        {entryError && (
          <p id="allowlist-entry-error" className="text-xs text-destructive" role="alert">
            {entryError}
          </p>
        )}
        {allowlist.length === 0 ? (
          <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">
            Nothing allowlisted — loopback, link-local and private addresses stay blocked.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Allowlisted destinations">
            {allowlist.map((value) => (
              <li key={value}>
                <Badge variant="secondary" className="gap-1 py-1 pl-2.5 pr-1 font-mono text-[11px]">
                  {value}
                  <button
                    type="button"
                    onClick={() => removeEntry(value)}
                    className="inline-flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted-foreground/10 hover:text-foreground"
                    aria-label={`Remove ${value} from the allowlist`}
                  >
                    <X className="size-3" />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="pr-3">
            <p className="text-sm font-medium">Require HTTPS</p>
            <p className="text-xs text-muted-foreground">Reject plain-HTTP destinations outside the allowlist.</p>
          </div>
          <Switch
            checked={requireHttps}
            onCheckedChange={(v) => setRequireHttps(v)}
            aria-label="Require HTTPS for non-allowlisted destinations"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="max-response-bytes">Maximum response body size (bytes)</Label>
          <Input
            id="max-response-bytes"
            inputMode="numeric"
            value={maxResponseBytes}
            onChange={(e) => {
              setMaxResponseBytes(e.target.value.replace(/\D/g, ''));
              setBytesError(null);
            }}
            className="h-9"
            aria-invalid={bytesError ? true : undefined}
            aria-describedby={bytesError ? 'max-response-bytes-error' : 'max-response-bytes-hint'}
          />
          <p id="max-response-bytes-hint" className="text-xs text-muted-foreground">
            Currently {formatBytes(Number(maxResponseBytes) || 0)} — hard cap protecting against oversized upstream
            responses (min {formatBytes(MIN_RESPONSE_BYTES)}, max {formatBytes(MAX_RESPONSE_BYTES)}).
          </p>
          {bytesError && (
            <p id="max-response-bytes-error" className="text-xs text-destructive" role="alert">
              {bytesError}
            </p>
          )}
        </div>
      </div>

      {dirty && (
        <div className="mt-3 flex justify-end">
          <Button onClick={() => void save()} disabled={settingsMutation.isPending} className="h-9 gap-1.5 px-4">
            {settingsMutation.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save network policy
          </Button>
        </div>
      )}
    </section>
  );
}
