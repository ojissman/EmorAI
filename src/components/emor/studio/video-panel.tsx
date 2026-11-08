'use client';

import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Clapperboard,
  CircleAlert,
  Loader2,
  RefreshCw,
  Sparkles,
  Timer,
  X,
} from 'lucide-react';

import { api, artifactUrls, ApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { useArtifact, useArtifacts } from '@/hooks/use-artifacts';
import type { SerializedArtifact } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  DeleteArtifactButton,
  DownloadArtifactButton,
  EmptyState,
  SectionHeading,
  StatusBadge,
  formatClock,
  timeAgo,
  type StudioArtifactView,
  errorMessage,
} from './studio-shared';

const MAX_PROMPT = 4000;

type VideoRequest = {
  prompt: string;
  quality: 'speed' | 'quality';
  withAudio: boolean;
  duration: 5 | 10;
};

export function VideoPanel() {
  const qc = useQueryClient();
  const [prompt, setPrompt] = useState('');
  const [quality, setQuality] = useState<'speed' | 'quality'>('speed');
  const [duration, setDuration] = useState<5 | 10>(5);
  const [withAudio, setWithAudio] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const lastRequest = useRef<VideoRequest | null>(null);

  const { data: library, isLoading } = useArtifacts(['video']);

  const generate = async (body?: VideoRequest) => {
    if (submitting) return;
    const payload: VideoRequest = body ?? {
      prompt: prompt.trim(),
      quality,
      withAudio,
      duration,
    };
    setSubmitting(true);
    try {
      const res = await api.post<{ artifact: SerializedArtifact }>('/api/studio/video', payload);
      lastRequest.current = payload;
      setActiveJobId(res.artifact.id);
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      toast.success('Video task submitted', {
        description: 'Renders usually take 1–6 minutes. We keep polling for you.',
      });
      if (!body) setPrompt('');
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
            <Clapperboard className="size-4 text-primary" />
            Generate video
          </CardTitle>
          <CardDescription>
            Describe a scene or camera move. Rendering runs in the background and takes 1–6 minutes.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="video-prompt">Prompt</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {prompt.length} / {MAX_PROMPT}
              </span>
            </div>
            <Textarea
              id="video-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, MAX_PROMPT))}
              placeholder="A slow dolly shot through a misty pine forest at dawn, volumetric light rays between the trees, cinematic color grading, 24fps film look"
              rows={3}
              className="resize-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="video-quality">Quality</Label>
              <Select value={quality} onValueChange={(v) => setQuality(v as 'speed' | 'quality')}>
                <SelectTrigger id="video-quality" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="speed">
                    Speed
                    <span className="ml-1.5 text-xs text-muted-foreground">· faster, standard fidelity</span>
                  </SelectItem>
                  <SelectItem value="quality">
                    Quality
                    <span className="ml-1.5 text-xs text-muted-foreground">· slower, higher fidelity</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="video-duration">Duration</Label>
              <Select value={String(duration)} onValueChange={(v) => setDuration(Number(v) as 5 | 10)}>
                <SelectTrigger id="video-duration" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 seconds</SelectItem>
                  <SelectItem value="10">10 seconds</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="pr-3">
              <Label htmlFor="video-audio" className="text-sm">
                Generate audio track
              </Label>
              <p className="text-xs text-muted-foreground">
                Adds a matching soundtrack or ambience to the clip.
              </p>
            </div>
            <Switch
              id="video-audio"
              checked={withAudio}
              onCheckedChange={setWithAudio}
              aria-label="Generate audio track"
            />
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button onClick={() => void generate()} disabled={submitting || prompt.trim().length < 3}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {submitting ? 'Submitting…' : 'Start render'}
          </Button>
        </CardFooter>
      </Card>

      <ActiveJobCard
        jobId={activeJobId}
        onDismiss={() => setActiveJobId(null)}
        onRetry={() => void generate(lastRequest.current ?? undefined)}
      />

      <section aria-label="Video library" className="space-y-3">
        <SectionHeading title="Library" count={(library ?? []).filter((v) => v.id !== activeJobId).length} />
        {isLoading ? (
          <div className="grid gap-4 md:grid-cols-2">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="aspect-video rounded-xl" />
            ))}
          </div>
        ) : (library ?? []).filter((v) => v.id !== activeJobId).length === 0 ? (
          <EmptyState
            icon={Clapperboard}
            title="Nothing generated yet"
            hint="Rendered videos land here. Longer, higher-quality renders can take several minutes."
          />
        ) : (
          <div className="emor-scroll max-h-[420px] overflow-y-auto pr-1">
            <div className="grid gap-4 md:grid-cols-2">
              {(library ?? [])
                .filter((v) => v.id !== activeJobId)
                .map((v) => (
                  <VideoCard key={v.id} artifact={v} />
                ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

// ─── Live job card (polls the detail endpoint while rendering) ───────────────

function ActiveJobCard({
  jobId,
  onDismiss,
  onRetry,
}: {
  jobId: string | null;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  const { data: artifact, isLoading } = useArtifact(jobId);
  const qc = useQueryClient();
  const notifiedRef = useRef<string | null>(null);
  const status = artifact?.status;

  const processing = status === 'processing' || status === 'pending';
  const createdAtMs = artifact ? Date.parse(artifact.createdAt) : null;

  // Tick state only forces a re-render every second; elapsed time and the
  // progress bar are derived from the artifact's creation time at render.
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!processing) return;
    const tick = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(tick);
  }, [processing]);

  useEffect(() => {
    if (!artifact || notifiedRef.current === artifact.id) return;
    if (artifact.status === 'ready') {
      notifiedRef.current = artifact.id;
      toast.success('Your video is ready');
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
    } else if (artifact.status === 'failed') {
      notifiedRef.current = artifact.id;
      toast.error('Video render failed', {
        description: artifact.error?.slice(0, 160) ?? 'The provider reported an error.',
      });
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
    }
  }, [artifact, qc]);

  if (!jobId) return null;

  const elapsedMs =
    processing && createdAtMs !== null ? Math.max(0, Date.now() - createdAtMs) : 0;
  // Asymptotic estimate: ~55% after 2 min, ~80% after 4 min, capped at 92%.
  const progress = Math.min(92, 100 * (1 - Math.exp(-elapsedMs / 1000 / 150)));

  if (isLoading || !artifact) {
    return (
      <section aria-label="Current render" aria-busy="true">
        <Card className="gap-0 overflow-hidden py-0">
          <Skeleton className="aspect-video w-full rounded-none" />
          <div className="space-y-2 p-4">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </Card>
      </section>
    );
  }

  return (
    <section aria-label="Current render" aria-live="polite">
      {processing ? (
        <Card className="relative overflow-hidden">
          <button
            type="button"
            onClick={onDismiss}
            className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Hide the progress card (render keeps running)"
            title="Hide — the render keeps running"
          >
            <X className="size-4" />
          </button>
          <CardHeader className="pb-3 pr-10">
            <CardTitle className="flex items-center gap-2 text-base">
              <Loader2 className="size-4 animate-spin text-primary" />
              Rendering video
              <StatusBadge status={artifact.status} />
            </CardTitle>
            <CardDescription className="line-clamp-2">{artifact.title}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Progress value={progress} aria-label="Render progress (estimated)" />
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                <Timer className="size-3.5" />
                Elapsed {formatClock(elapsedMs)}
              </span>
              {artifact.providerTaskId ? (
                <span className="truncate font-mono text-[11px]">task {artifact.providerTaskId}</span>
              ) : null}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Video renders usually take <span className="font-medium text-foreground">1–6 minutes</span>.
              You can hide this card or browse other tabs — we keep checking the provider task until it
              finishes.
            </p>
          </CardContent>
        </Card>
      ) : artifact.status === 'ready' ? (
        <VideoCard artifact={artifact} featured onDismiss={onDismiss} />
      ) : artifact.status === 'failed' ? (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-destructive">
              <CircleAlert className="size-4" />
              Render failed
            </CardTitle>
            <CardDescription className="line-clamp-2">{artifact.title}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {artifact.error ?? 'The provider reported an error for this task.'}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={onRetry}>
                <RefreshCw className="size-4" />
                Try again
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </section>
  );
}

// ─── Video card ──────────────────────────────────────────────────────────────

function VideoCard({
  artifact,
  featured,
  onDismiss,
}: {
  artifact: StudioArtifactView;
  featured?: boolean;
  onDismiss?: () => void;
}) {
  const ready = artifact.status === 'ready';
  const qualityMeta =
    artifact.meta?.quality === 'speed' || artifact.meta?.quality === 'quality'
      ? (artifact.meta.quality as string)
      : null;
  const durationMeta =
    typeof artifact.meta?.duration === 'number' ? (artifact.meta.duration as number) : null;

  return (
    <Card className={cn(featured && 'border-primary/40')}>
      <div className="relative overflow-hidden rounded-t-lg bg-black">
        {ready ? (
          <video
            controls
            preload="metadata"
            src={artifactUrls.file(artifact.id)}
            className="aspect-video w-full"
          />
        ) : (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-muted">
            {artifact.status === 'failed' ? (
              <>
                <CircleAlert className="size-5 text-destructive" />
                <p className="max-w-[80%] text-center text-xs text-muted-foreground">
                  {artifact.error ?? 'Generation failed.'}
                </p>
              </>
            ) : (
              <>
                <Loader2 className="size-5 animate-spin text-primary" />
                <p className="text-xs text-muted-foreground">Rendering…</p>
              </>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 p-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={artifact.title}>
            {artifact.title}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {timeAgo(artifact.createdAt)}
            {qualityMeta ? ` · ${qualityMeta}` : ''}
            {durationMeta ? ` · ${durationMeta}s` : ''}
          </p>
        </div>
        {artifact.status !== 'ready' ? <StatusBadge status={artifact.status} /> : null}
        {featured && onDismiss ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-foreground"
            onClick={onDismiss}
            aria-label="Hide this video"
            title="Hide"
          >
            <X className="size-4" />
          </Button>
        ) : null}
        <DownloadArtifactButton artifact={artifact} />
        <DeleteArtifactButton artifact={artifact} onDeleted={featured ? onDismiss : undefined} />
      </div>
    </Card>
  );
}
