'use client';

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AudioLines, Loader2, Sparkles } from 'lucide-react';

import { api, artifactUrls, ApiError } from '@/lib/api-client';
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
import { Slider } from '@/components/ui/slider';
import { Textarea } from '@/components/ui/textarea';
import {
  DeleteArtifactButton,
  DownloadArtifactButton,
  EmptyState,
  SectionHeading,
  StatusBadge,
  formatBytes,
  timeAgo,
  wordCount,
  type StudioArtifactView,
  errorMessage,
} from './studio-shared';

const MAX_TEXT = 8000;

const VOICES = [
  { value: 'tongtong', label: 'Tongtong', hint: 'Warm, expressive narrator' },
  { value: 'xiaochen', label: 'Xiaochen', hint: 'Calm, gentle female' },
  { value: 'chuichui', label: 'Chuichui', hint: 'Bright and energetic' },
  { value: 'xiaoxiao', label: 'Xiaoxiao', hint: 'Soft, friendly female' },
  { value: 'doudou', label: 'Doudou', hint: 'Playful youthful tone' },
] as const;

type Voice = (typeof VOICES)[number]['value'];

type SessionInfo = { voice?: Voice; speed?: number; words: number };

export function AudioPanel() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [voice, setVoice] = useState<Voice>('tongtong');
  const [speed, setSpeed] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<StudioArtifactView[]>([]);
  const [sessionInfo, setSessionInfo] = useState<Record<string, SessionInfo>>({});

  const { data: library, isLoading } = useArtifacts(['audio']);
  const words = wordCount(text);

  const sessionIds = useMemo(() => new Set(results.map((r) => r.id)), [results]);
  const merged = useMemo(() => {
    const lib: StudioArtifactView[] = (library ?? []).filter((a) => !sessionIds.has(a.id));
    return [...results, ...lib].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }, [results, library, sessionIds]);

  const generate = async () => {
    if (submitting || !text.trim()) return;
    setSubmitting(true);
    try {
      const res = await api.post<{ artifact: SerializedArtifact }>('/api/studio/audio', {
        text: text.trim(),
        voice,
        speed,
        ...(title.trim() ? { title: title.trim().slice(0, 120) } : {}),
      });
      setResults((prev) => [res.artifact, ...prev].slice(0, 24));
      setSessionInfo((prev) => ({
        ...prev,
        [res.artifact.id]: { voice, speed, words: wordCount(text) },
      }));
      void qc.invalidateQueries({ queryKey: ['artifacts'] });
      toast.success('Speech generated');
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
            <AudioLines className="size-4 text-primary" />
            Text to speech
          </CardTitle>
          <CardDescription>
            Paste a script and pick a voice. Audio is usually ready in a couple of seconds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="audio-title">Title (optional)</Label>
            <Input
              id="audio-title"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 120))}
              placeholder="e.g. Product intro voiceover"
              maxLength={120}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="audio-text">Script</Label>
              <span className="text-xs tabular-nums text-muted-foreground">
                {words} words · {text.length} / {MAX_TEXT}
              </span>
            </div>
            <Textarea
              id="audio-text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT))}
              placeholder="Welcome to EmorAI — your personal AI studio for images, video, speech and documents. Paste any text here and I will read it aloud."
              rows={6}
              className="resize-none"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="audio-voice">Voice</Label>
              <Select value={voice} onValueChange={(v) => setVoice(v as Voice)}>
                <SelectTrigger id="audio-voice" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VOICES.map((v) => (
                    <SelectItem key={v.value} value={v.value}>
                      {v.label}
                      <span className="ml-1.5 text-xs text-muted-foreground">· {v.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="audio-speed">Speed</Label>
                <Badge variant="secondary" className="tabular-nums">
                  {speed.toFixed(2)}×
                </Badge>
              </div>
              <div className="flex h-9 items-center gap-3">
                <Slider
                  id="audio-speed"
                  value={[speed]}
                  min={0.5}
                  max={2}
                  step={0.05}
                  onValueChange={(v) => setSpeed(v[0] ?? 1)}
                  aria-label="Speech speed"
                />
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>0.5× slow</span>
                <span>2× fast</span>
              </div>
            </div>
          </div>
        </CardContent>
        <CardFooter className="justify-end">
          <Button onClick={() => void generate()} disabled={submitting || !text.trim()}>
            {submitting ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="size-4" aria-hidden="true" />
            )}
            {submitting ? 'Synthesizing…' : 'Generate speech'}
          </Button>
        </CardFooter>
      </Card>

      <section aria-label="Speech library" className="space-y-3">
        <SectionHeading title="Library" count={merged.length} />
        {isLoading ? (
          <div className="space-y-3">
            {[0, 1].map((i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : merged.length === 0 ? (
          <EmptyState
            icon={AudioLines}
            title="Nothing generated yet"
            hint="Voice clips you synthesize are archived here so you can replay or download them anytime."
          />
        ) : (
          <div className="emor-scroll max-h-[420px] space-y-3 overflow-y-auto pr-1">
            {merged.map((a) => {
              const info = sessionInfo[a.id];
              return (
                <Card key={a.id} className="gap-0 py-0">
                  <div className="flex flex-wrap items-center gap-2 p-3 pb-1.5">
                    <p className="min-w-0 flex-1 truncate text-sm font-medium" title={a.title}>
                      {a.title}
                    </p>
                    {info?.voice ? <Badge variant="secondary">{info.voice}</Badge> : null}
                    {info?.speed != null && info.speed !== 1 ? (
                      <Badge variant="secondary" className="tabular-nums">
                        {info.speed.toFixed(2)}×
                      </Badge>
                    ) : null}
                    {info ? (
                      <Badge variant="secondary" className="tabular-nums">
                        {info.words} words
                      </Badge>
                    ) : null}
                    {a.size != null ? (
                      <span className="text-[11px] text-muted-foreground">{formatBytes(a.size)}</span>
                    ) : null}
                    {a.status !== 'ready' ? <StatusBadge status={a.status} /> : null}
                    <span className="text-[11px] text-muted-foreground">{timeAgo(a.createdAt)}</span>
                    <DownloadArtifactButton artifact={a} />
                    <DeleteArtifactButton artifact={a} />
                  </div>
                  <div className="px-3 pb-3">
                    {a.status === 'ready' ? (
                      <audio
                        controls
                        preload="none"
                        src={artifactUrls.file(a.id)}
                        className="h-9 w-full"
                      />
                    ) : a.status === 'failed' ? (
                      <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                        {a.error ?? 'Speech generation failed.'}
                      </p>
                    ) : (
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" /> Rendering audio…
                      </p>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
