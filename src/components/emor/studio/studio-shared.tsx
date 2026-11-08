'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Download, Loader2, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { artifactUrls } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useDeleteArtifact } from '@/hooks/use-artifacts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/**
 * Unified display shape for artifacts. Accepts both the full `SerializedArtifact`
 * (returned by studio POST endpoints) and the lighter `ArtifactSummary`
 * (returned by `useArtifacts`), so every panel can render the same components.
 */
export type StudioArtifactView = {
  id: string;
  kind: string;
  title: string;
  status: string;
  mime: string | null;
  size: number | null;
  createdAt: string;
  meta?: Record<string, unknown> | null;
  error?: string | null;
};

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message.slice(0, 300) : 'Something went wrong. Please try again.';
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

export function formatBytes(bytes: number | null): string {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function timeAgo(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** 65_000 → "1:05" — used for the video render elapsed timer. */
export function formatClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function extFromMime(mime: string | null, fallback: string): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'audio/mpeg':
      return 'mp3';
    case 'audio/wav':
      return 'wav';
    case 'video/mp4':
      return 'mp4';
    case 'text/markdown':
      return 'md';
    case 'text/html':
      return 'html';
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    default:
      return fallback;
  }
}

/** A sane filename for the browser `download` attribute. */
export function downloadNameFor(a: StudioArtifactView): string {
  const ext = extFromMime(
    a.mime,
    a.kind === 'image' ? 'png' : a.kind === 'video' ? 'mp4' : a.kind === 'audio' ? 'mp3' : 'md'
  );
  const slug = a.title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || `emor-${a.kind}`}.${ext}`;
}

// ─── Small building blocks ───────────────────────────────────────────────────

export function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-6 py-12 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {hint ? <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function SectionHeading({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      {typeof count === 'number' ? (
        <Badge variant="secondary" className="tabular-nums">
          {count}
        </Badge>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5">{children}</div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  if (status === 'ready') {
    return (
      <Badge
        variant="outline"
        className="border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
      >
        Ready
      </Badge>
    );
  }
  if (status === 'failed') {
    return <Badge variant="destructive">Failed</Badge>;
  }
  if (status === 'processing' || status === 'pending') {
    return (
      <Badge
        variant="outline"
        className="border-amber-600/30 bg-amber-600/10 text-amber-700 dark:text-amber-400"
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
        </span>
        {status === 'pending' ? 'Queued' : 'Rendering'}
      </Badge>
    );
  }
  return <Badge variant="secondary">{status}</Badge>;
}

export function DownloadArtifactButton({ artifact }: { artifact: StudioArtifactView }) {
  const disabled = artifact.status !== 'ready';
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-8 text-muted-foreground hover:text-foreground"
      disabled={disabled}
      title={disabled ? 'Not available yet' : 'Download'}
      aria-label={`Download ${artifact.title}`}
      onClick={() => {
        // Trigger through a temporary anchor so the browser honors `download`.
        const a = document.createElement('a');
        a.href = artifactUrls.file(artifact.id);
        a.download = downloadNameFor(artifact);
        document.body.appendChild(a);
        a.click();
        a.remove();
      }}
    >
      <Download className="size-4" />
    </Button>
  );
}

export function DeleteArtifactButton({
  artifact,
  onDeleted,
  className,
}: {
  artifact: StudioArtifactView;
  onDeleted?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const remove = useDeleteArtifact();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('size-8 text-muted-foreground hover:text-destructive', className)}
          disabled={remove.isPending}
          aria-label={`Delete ${artifact.title}`}
          title="Delete"
        >
          {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this {artifact.kind}?</AlertDialogTitle>
          <AlertDialogDescription>
            “{artifact.title.slice(0, 80)}” will be removed permanently, including its generated file. This cannot be
            undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-white hover:bg-destructive/90"
            disabled={remove.isPending}
            onClick={(e) => {
              e.preventDefault();
              remove.mutate(artifact.id, {
                onSuccess: () => {
                  toast.success(`Deleted “${artifact.title.slice(0, 48)}”`);
                  onDeleted?.();
                  setOpen(false);
                },
                onError: (err) => toast.error(errorMessage(err)),
              });
            }}
          >
            {remove.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
