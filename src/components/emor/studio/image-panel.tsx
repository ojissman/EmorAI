'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronDown,
  Images,
  Loader2,
  PencilLine,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';

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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
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
  timeAgo,
  type StudioArtifactView,
  errorMessage,
} from './studio-shared';

const MAX_PROMPT = 4000;
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const SIZE_OPTIONS = [
  { value: '1024x1024', label: '1024 × 1024', hint: 'Square 1:1' },
  { value: '768x1344', label: '768 × 1344', hint: 'Tall 9:16' },
  { value: '864x1152', label: '864 × 1152', hint: 'Portrait 3:4' },
  { value: '1344x768', label: '1344 × 768', hint: 'Wide 16:9' },
  { value: '1152x864', label: '1152 × 864', hint: 'Landscape 4:3' },
  { value: '1440x720', label: '1440 × 720', hint: 'Cinematic 21:9' },
  { value: '720x1440', label: '720 × 1440', hint: 'Phone 9:21' },
] as const;

type ImageSize = (typeof SIZE_OPTIONS)[number]['value'];
type Count = 1 | 2 | 3 | 4;

type UploadedFile = { id: string; name: string; mime: string; size: number; kind: string };

export function ImagePanel() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const [count, setCount] = useState<Count>(1);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<StudioArtifactView[]>([]);

  const { data: library, isLoading } = useArtifacts(['image']);

  const sessionIds = useMemo(() => new Set(results.map((r) => r.id)), [results]);
  const merged = useMemo(() => {
    const lib: StudioArtifactView[] = (library ?? []).filter((a) => !sessionIds.has(a.id));
    return [...results, ...lib].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [results, library, sessionIds]);

  const generate = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ artifacts: SerializedArtifact[] }>('/api/studio/image', {
        prompt: prompt.trim(),
        size,
        count,
      });
      setResults((prev) => [...res.artifacts, ...prev].slice(0, 24));
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      toast.success(
        res.artifacts.length > 1 ? `Generated ${res.artifacts.length} images` : 'Image generated'
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4 text-primary" />
            Create images
          </CardTitle>
          <CardDescription>
            Describe the image you want. Generation takes 10–30 seconds per image.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="image-prompt">Prompt</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {prompt.length} / {MAX_PROMPT}
              </span>
            </div>
            <Textarea
              id="image-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
              placeholder="A minimalist flat illustration of a fox reading a book under a paper lantern, warm amber and violet palette, soft grain, high detail"
              rows={3}
              className="resize-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="image-size">Size</Label>
              <Select value={size} onValueChange={(v) => setSize(v as ImageSize)}>
                <SelectTrigger id="image-size" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SIZE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                      <span className="ml-1.5 text-xs text-muted-foreground">· {o.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-count">How many</Label>
              <Select
                value={String(count)}
                onValueChange={(v) => setCount(Number(v) as Count)}
              >
                <SelectTrigger id="image-count" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {([1, 2, 3, 4] as Count[]).map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} image{n > 1 ? 's' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            Tip: mention style, lighting and composition for more control.
          </p>
          <Button onClick={() => void generate()} disabled={submitting || prompt.trim().length < 3}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {submitting ? 'Generating…' : 'Generate'}
          </Button>
        </CardFooter>
      </Card>

      <EditImageSection onCreated={(a) => setResults((prev) => [a, ...prev].slice(0, 24))} />

      <section aria-label="Image library" className="space-y-3">
        <SectionHeading title="Library" count={merged.length} />
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : merged.length === 0 ? (
          <EmptyState
            icon={Images}
            title="Nothing generated yet"
            hint="Your generated and edited images are collected here — they stay available across sessions."
          />
        ) : (
          <div className="emor-scroll max-h-[420px] overflow-y-auto pr-1">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {merged.map((a) => (
                <ImageCard key={a.id} artifact={a} />
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Image card ──────────────────────────────────────────────────────────────

function ImageCard({ artifact }: { artifact: StudioArtifactView }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const sizeMeta = typeof artifact.meta?.size === 'string' ? (artifact.meta.size as string) : null;

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {artifact.status === 'failed' ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 p-4 text-center">
            <p className="text-xs font-medium text-destructive">Generation failed</p>
            {artifact.error ? (
              <p className="line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                {artifact.error}
              </p>
            ) : null}
          </div>
        ) : (
          <>
            {!loaded && !broken ? <Skeleton className="absolute inset-0 rounded-none" /> : null}
            {broken ? (
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Preview unavailable
              </div>
            ) : (
              <img
                src={artifactUrls.file(artifact.id)}
                alt={artifact.title}
                loading="lazy"
                onLoad={() => setLoaded(true)}
                onError={() => setBroken(true)}
                className={cn(
                  'h-full w-full object-cover transition-opacity duration-300',
                  loaded ? 'opacity-100' : 'opacity-0'
                )}
              />
            )}
            {artifact.status !== 'ready' && !broken ? (
              <div className="absolute left-2 top-2">
                <StatusBadge status={artifact.status} />
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="flex items-center gap-1.5 p-2.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={artifact.title}>
            {artifact.title}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {sizeMeta ?? timeAgo(artifact.createdAt)}
          </p>
        </div>
        {sizeMeta ? <Badge variant="secondary">{sizeMeta}</Badge> : null}
        <DownloadArtifactButton artifact={artifact} />
        <DeleteArtifactButton artifact={artifact} />
      </div>
    </Card>
  );
}

// ─── Edit an existing image ──────────────────────────────────────────────────

function EditImageSection({ onCreated }: { onCreated: (a: StudioArtifactView) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState<ImageSize>('1024x1024');
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoke the object URL whenever it is replaced or the section unmounts.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const pickFile = (picked: File | null | undefined) => {
    if (!picked) return;
    if (!picked.type.startsWith('image/')) {
      toast.error('Image editing needs an image file (PNG, JPG, WebP…).');
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      toast.error(`"${picked.name}" exceeds the 10 MB limit.`);
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(picked);
    setPreviewUrl(URL.createObjectURL(picked));
    setUploaded(null);
  };

  const upload = async (): Promise<UploadedFile | null> => {
    if (!file) return null;
    setUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.upload<{ file: UploadedFile }>('/api/files/upload', form);
      setUploaded(res.file);
      return res.file;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : errorMessage(e));
      return null;
    } finally {
      setUploading(false);
    }
  };

  const generate = async () => {
    if (editing) return;
    setEditing(true);
    try {
      const target = uploaded ?? (await upload());
      if (!target) return;
      const res = await api.post<{ artifact: SerializedArtifact }>('/api/studio/image/edit', {
        prompt: prompt.trim(),
        fileId: target.id,
        size,
      });
      onCreated(res.artifact);
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      toast.success('Edited image generated');
      setPrompt('');
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setEditing(false);
    }
  };

  const clearFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl(null);
    setUploaded(null);
  };

  const busy = uploading || editing;
  const ready = uploaded !== null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card className="py-0">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 px-4 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:px-5"
            aria-expanded={open}
          >
            <PencilLine className="size-4 text-primary" />
            <span className="text-sm font-semibold">Edit an image</span>
            <span className="text-xs text-muted-foreground">
              — upload a source image and restyle it with a prompt
            </span>
            <ChevronDown
              className={cn(
                'ml-auto size-4 text-muted-foreground transition-transform duration-200',
                open && 'rotate-180'
              )}
            />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-4 border-t px-4 pb-4 pt-4 sm:px-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload a source image"
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    inputRef.current?.click();
                  }
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  pickFile(e.dataTransfer.files?.[0]);
                }}
                className={cn(
                  'flex min-h-28 w-full shrink-0 cursor-pointer items-center justify-center rounded-lg border border-dashed transition-colors sm:w-44',
                  dragging ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                )}
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={`Source: ${file?.name ?? 'selected image'}`}
                    className="h-28 w-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex flex-col items-center gap-1 p-4 text-center">
                    <Upload className="size-4 text-muted-foreground" />
                    <p className="text-xs font-medium">Drop an image</p>
                    <p className="text-[11px] text-muted-foreground">or click to browse · max 10 MB</p>
                  </div>
                )}
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  pickFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />

              <div className="min-w-0 flex-1 space-y-3">
                <div className="flex items-center gap-2">
                  {file ? (
                    <>
                      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={file.name}>
                        {file.name} · {(file.size / 1024).toFixed(0)} KB
                      </p>
                      {uploading ? (
                        <Badge variant="secondary">
                          <Loader2 className="size-3 animate-spin" /> Uploading
                        </Badge>
                      ) : ready ? (
                        <Badge
                          variant="outline"
                          className="border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                        >
                          Uploaded
                        </Badge>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-muted-foreground hover:text-destructive"
                        onClick={clearFile}
                        disabled={busy}
                        aria-label="Remove selected image"
                      >
                        <X className="size-3.5" />
                      </Button>
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Pick an image first — it is uploaded automatically when you generate.
                    </p>
                  )}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="image-edit-prompt">What should change?</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {prompt.length} / {MAX_PROMPT}
                    </span>
                  </div>
                  <Textarea
                    id="image-edit-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
                    placeholder="Turn the background into a sunset beach, keep the subject unchanged"
                    rows={2}
                    className="resize-none"
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select value={size} onValueChange={(v) => setSize(v as ImageSize)}>
                    <SelectTrigger className="w-full sm:w-44" aria-label="Output size">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SIZE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                          <span className="ml-1.5 text-xs text-muted-foreground">· {o.hint}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="sm:ml-auto">
                        <Button
                          onClick={() => void generate()}
                          disabled={busy || !file || prompt.trim().length < 3}
                        >
                          {busy ? (
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                          ) : (
                            <PencilLine className="size-4" aria-hidden="true" />
                          )}
                          {uploading ? 'Uploading…' : editing ? 'Editing…' : 'Apply edit'}
                        </Button>
                      </span>
                    </TooltipTrigger>
                    {!file ? <TooltipContent>Choose a source image first</TooltipContent> : null}
                  </Tooltip>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
