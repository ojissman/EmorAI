'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  FileCode,
  FileImage,
  FileText,
  FileType,
  Loader2,
  NotebookPen,
  ScanEye,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { api, artifactUrls, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useArtifacts } from '@/hooks/use-artifacts';
import type { SerializedArtifact } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  DeleteArtifactButton,
  DownloadArtifactButton,
  EmptyState,
  SectionHeading,
  StatusBadge,
  formatBytes,
  timeAgo,
  type StudioArtifactView,
  errorMessage,
} from './studio-shared';

const MAX_BRIEF = 8000;

type DocFormat = 'md' | 'html' | 'docx' | 'pdf';

const FORMATS: { value: DocFormat; label: string; hint: string; icon: LucideIcon }[] = [
  { value: 'md', label: 'Markdown', hint: '.md — plain, portable', icon: FileText },
  { value: 'html', label: 'Web page', hint: '.html — styled, standalone', icon: FileCode },
  { value: 'docx', label: 'Word', hint: '.docx — editable in Word/Docs', icon: FileType },
  { value: 'pdf', label: 'PDF', hint: '.pdf — print-ready', icon: FileImage },
];

function formatFromMime(mime: string | null): DocFormat | null {
  switch (mime) {
    case 'text/markdown':
      return 'md';
    case 'text/html':
      return 'html';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/pdf':
      return 'pdf';
    default:
      return null;
  }
}

function formatMeta(a: StudioArtifactView): { format: DocFormat | null; icon: LucideIcon; label: string } {
  const format = formatFromMime(a.mime);
  if (format === 'md') return { format, icon: FileText, label: 'MD' };
  if (format === 'html') return { format, icon: FileCode, label: 'HTML' };
  if (format === 'docx') return { format, icon: FileType, label: 'DOCX' };
  if (format === 'pdf') return { format, icon: FileImage, label: 'PDF' };
  return { format: null, icon: FileText, label: a.mime ?? 'file' };
}

export function DocumentPanel() {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [format, setFormat] = useState<DocFormat>('md');
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<StudioArtifactView[]>([]);
  const [preview, setPreview] = useState<{ id: string; title: string; format: DocFormat } | null>(null);

  const { data: library, isLoading } = useArtifacts(['document']);

  const sessionIds = useMemo(() => new Set(results.map((r) => r.id)), [results]);
  const merged = useMemo(() => {
    const lib: StudioArtifactView[] = (library ?? []).filter((a) => !sessionIds.has(a.id));
    return [...results, ...lib].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [results, library, sessionIds]);

  const generate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ artifact: SerializedArtifact }>('/api/studio/document', {
        title: title.trim().slice(0, 120),
        prompt: brief.trim(),
        format,
      });
      setResults((prev) => [res.artifact, ...prev].slice(0, 24));
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      toast.success(`“${res.artifact.title.slice(0, 48)}” is ready`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  const openPreview = (a: StudioArtifactView, fmt: DocFormat | null) => {
    if (!fmt) return;
    setPreview({ id: a.id, title: a.title, format: fmt });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <NotebookPen className="size-4 text-primary" />
            Write a document
          </CardTitle>
          <CardDescription>
            Give a title and a brief — an AI writer drafts a polished document, usually in 20–60
            seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="doc-title">Title</Label>
            <Input
              id="doc-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 120))}
              placeholder="e.g. Q3 Growth Review & Roadmap"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="doc-brief">Brief</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {brief.length} / {MAX_BRIEF}
              </span>
            </div>
            <Textarea
              id="doc-brief"
              value={brief}
              onChange={(e) => setBrief(e.target.value.slice(0, MAX_BRIEF))}
              placeholder="Audience, tone, length and the key points to cover. Example: “A 2-page executive summary for non-technical stakeholders: why we're migrating to edge deployment, expected cost impact, three risks with mitigations. Professional but plain-spoken.”"
              rows={6}
              className="resize-none"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="doc-format">Format</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as DocFormat)}>
              <SelectTrigger id="doc-format" className="w-full sm:w-72">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map((f) => (
                  <SelectItem key={f.value} value={f.value}>
                    {f.label}
                    <span className="ml-1.5 text-xs text-muted-foreground">· {f.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {submitting ? 'The writer is drafting your document — this can take up to a minute.' : 'Markdown and web pages support in-browser preview.'}
          </p>
          <Button onClick={() => void generate()} disabled={submitting || !title.trim() || brief.trim().length < 3}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {submitting ? 'Writing…' : 'Write document'}
          </Button>
        </CardFooter>
      </Card>

      <section aria-label="Document library" className="space-y-3">
        <SectionHeading title="Library" count={merged.length} />
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-16 rounded-xl" />
            ))}
          </div>
        ) : merged.length === 0 ? (
          <EmptyState
            icon={NotebookPen}
            title="Nothing generated yet"
            hint="Reports, memos and pages you generate are kept here with one-click download."
          />
        ) : (
          <div className="emor-scroll max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {merged.map((a) => {
              const meta = formatMeta(a);
              const previewable = meta.format === 'md' || meta.format === 'html';
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-3 transition-colors hover:bg-accent/40"
                >
                  <div
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-muted-foreground',
                      a.status === 'failed' && 'text-destructive'
                    )}
                  >
                    <meta.icon className="size-4" aria-hidden="true" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" title={a.title}>
                      {a.title}
                    </p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
                        {meta.label}
                      </Badge>
                      {a.status !== 'ready' ? <StatusBadge status={a.status} /> : null}
                      {a.size != null ? <span>{formatBytes(a.size)}</span> : null}
                      <span>{timeAgo(a.createdAt)}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-8 text-muted-foreground hover:text-foreground"
                            disabled={!previewable}
                            onClick={() => openPreview(a, meta.format)}
                            aria-label={`Preview ${a.title}`}
                            title={previewable ? 'Preview' : 'Download to view'}
                          >
                            <ScanEye className="size-4" />
                          </Button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>{previewable ? 'Preview' : 'Download to view'}</TooltipContent>
                    </Tooltip>
                    <DownloadArtifactButton artifact={a} />
                    <DeleteArtifactButton artifact={a} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <DocumentPreviewDialog preview={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

// ─── Preview dialog ──────────────────────────────────────────────────────────

function DocumentPreviewDialog({
  preview,
  onClose,
}: {
  preview: { id: string; title: string; format: DocFormat } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={preview !== null} onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="truncate pr-8 text-base">{preview?.title ?? 'Preview'}</DialogTitle>
          <DialogDescription>
            {preview?.format === 'html'
              ? 'Rendered web page preview'
              : preview?.format === 'md'
                ? 'Markdown source'
                : 'Preview'}
          </DialogDescription>
        </DialogHeader>
        {preview ? (
          preview.format === 'html' ? (
            <iframe
              src={artifactUrls.preview(preview.id)}
              title={`Preview of ${preview.title}`}
              className="h-[70vh] w-full flex-1 bg-background"
              sandbox="allow-same-origin"
            />
          ) : (
            <MarkdownPreview key={preview.id} id={preview.id} />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MarkdownPreview({ id }: { id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(artifactUrls.file(id))
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load the document (status ${res.status}).`);
        return res.text();
      })
      .then((t) => {
        if (!cancelled) setText(t);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <p className="text-sm text-destructive">{error}</p>
      </div>
    );
  }
  if (text === null) {
    return (
      <div className="emor-scroll flex-1 space-y-2.5 overflow-y-auto p-5">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className={cn('h-4', i % 3 === 0 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    );
  }
  return (
    <div className="emor-scroll flex-1 overflow-y-auto p-5">
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
        {text}
      </pre>
    </div>
  );
}
