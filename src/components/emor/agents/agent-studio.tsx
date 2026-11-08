"use client";

// Agent Studio — describe a site, run the build agent, watch files stream in,
// then preview / browse / download the finished project.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Eye,
  History,
  Loader2,
  MoreVertical,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Wand2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api-client';
import { useAgentRun } from '@/hooks/use-agent-run';
import { useArtifact, useArtifacts, useDeleteArtifact, type ArtifactSummary } from '@/hooks/use-artifacts';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import type { AgentTemplate, SerializedArtifact } from '@/lib/types';
import { cn } from '@/lib/utils';
import { TEMPLATES, formatBytes, formatDate, kindMeta } from './agent-meta';
import { RunPanel } from './run-panel';
import { ArtifactView } from './artifact-view';

type ModelsResponse = { models: { modelId: string; displayName: string; enabled: boolean }[] };
type DeleteTarget = { id: string; title: string } | null;

const MIN_BRIEF = 10;
const MAX_BRIEF = 8000;

function DetailSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-96 max-w-full" />
          <Skeleton className="h-3 w-48" />
        </div>
        <Skeleton className="h-8 w-24" />
      </div>
      <Skeleton className="h-9 w-44" />
      <Skeleton className="h-[560px] w-full rounded-lg" />
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-2.5">
          <Skeleton className="size-8 rounded-md" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyOutput() {
  return (
    <div className="flex min-h-[420px] flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8 text-center">
      <span className="flex size-12 items-center justify-center rounded-xl border bg-muted/40">
        <Bot className="size-6 text-violet-500" aria-hidden="true" />
      </span>
      <div>
        <p className="font-medium">Describe what to build</p>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
          Pick a template, write a brief and run the agent. It will plan the project, stream every
          file as it is written, then hand you a live preview, browsable code and a ZIP download.
        </p>
      </div>
    </div>
  );
}

export function AgentStudio() {
  const queryClient = useQueryClient();
  const { state, run, stop } = useAgentRun();

  const [template, setTemplate] = useState<AgentTemplate>('website');
  const [brief, setBrief] = useState('');
  // null = "use the first enabled model" (derived below); a selection overrides it.
  const [modelChoice, setModelChoice] = useState<string | null>(null);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget>(null);

  const { data: modelsData, isLoading: modelsLoading } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.get<ModelsResponse>('/api/models'),
    staleTime: 30_000,
  });
  const enabledModels = useMemo(
    () => (modelsData?.models ?? []).filter((m) => m.enabled),
    [modelsData]
  );
  const modelId = modelChoice ?? enabledModels[0]?.modelId ?? '';

  const { data: history, isLoading: historyLoading } = useArtifacts(['website', 'webapp', 'blog']);
  const detailQuery = useArtifact(selectedArtifactId);
  const deleteArtifact = useDeleteArtifact();

  // Live run artifact (already contains files) vs. history detail.
  const detailArtifact: SerializedArtifact | null = selectedArtifactId
    ? detailQuery.data ?? null
    : state.artifact;

  // Refresh the history list once a run persists its artifact.
  useEffect(() => {
    if (state.artifact) {
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    }
  }, [state.artifact, queryClient]);

  useEffect(() => {
    if (state.error) {
      toast.error('Build failed', { description: state.error });
    }
  }, [state.error]);

  // Auto-scroll the whole output region to the bottom while files stream —
  // but only while the user is already near the bottom.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickRef = useRef(true);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current && state.running) {
      el.scrollTop = el.scrollHeight;
    }
  }, [state.files, state.steps, state.plan, state.running]);

  // Jump back to the top when switching artifacts (incl. run completion).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      stickRef.current = true;
      el.scrollTop = 0;
    }
  }, [selectedArtifactId, state.artifact]);

  const briefLength = brief.trim().length;
  const templateMeta = TEMPLATES.find((t) => t.id === template);

  const startRun = () => {
    const trimmed = brief.trim();
    if (state.running || trimmed.length < MIN_BRIEF) return;
    setSelectedArtifactId(null);
    toast.success('Agent started', {
      description: `Building a ${templateMeta?.label.toLowerCase() ?? 'project'} — files will stream in as they are written.`,
    });
    void run({ template, brief: trimmed, modelId: modelId || undefined });
  };

  const handleDelete = (id: string) => {
    deleteArtifact.mutate(id, {
      onSuccess: () => {
        toast.success('Project deleted');
        if (selectedArtifactId === id) setSelectedArtifactId(null);
      },
      onError: (e) => toast.error('Delete failed', { description: (e as Error).message }),
    });
  };

  const activeId = selectedArtifactId ?? state.artifact?.id ?? null;
  const liveInProgress =
    !selectedArtifactId && !state.artifact && (state.running || state.steps.length > 0 || !!state.error);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div ref={scrollRef} onScroll={handleScroll} className="emor-scroll min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid w-full max-w-6xl gap-6 px-4 pb-8 pt-6 lg:grid-cols-[380px_1fr]">
          {/* ── Left: new build form + history ─────────────────────────────── */}
          <aside className="min-w-0 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Wand2 className="size-4 text-violet-500" aria-hidden="true" />
                  New build
                </CardTitle>
                <CardDescription>Describe a site — the agent plans it and writes every file live.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Template</Label>
                  <div role="radiogroup" aria-label="Template" className="mt-2 grid grid-cols-2 gap-2">
                    {TEMPLATES.map((t) => {
                      const selected = template === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          role="radio"
                          aria-checked={selected}
                          onClick={() => setTemplate(t.id)}
                          className={cn(
                            'rounded-lg border p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selected && 'border-primary bg-primary/5 ring-1 ring-primary'
                          )}
                        >
                          <t.icon
                            className={cn('size-4', selected ? 'text-primary' : 'text-muted-foreground')}
                            aria-hidden="true"
                          />
                          <span className="mt-1.5 block text-sm font-medium">{t.label}</span>
                          <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                            {t.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="agent-brief">Brief</Label>
                    <span
                      className={cn('text-xs tabular-nums', briefLength < MIN_BRIEF ? 'text-destructive' : 'text-muted-foreground')}
                    >
                      {brief.length}/{MAX_BRIEF}
                    </span>
                  </div>
                  <Textarea
                    id="agent-brief"
                    rows={5}
                    value={brief}
                    maxLength={MAX_BRIEF}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="A portfolio site for a freelance photographer with gallery, about, and a contact form…"
                    className="resize-none"
                    disabled={state.running}
                  />
                  {briefLength < MIN_BRIEF && (
                    <p className="text-xs text-muted-foreground">
                      Write at least {MIN_BRIEF} characters ({MIN_BRIEF - briefLength} to go).
                    </p>
                  )}
                </div>

                <div className="space-y-2">
                  <Label htmlFor="agent-model">Builder model</Label>
                  <Select
                    value={modelId}
                    onValueChange={setModelChoice}
                    disabled={modelsLoading || enabledModels.length === 0}
                  >
                    <SelectTrigger id="agent-model" className="w-full" aria-label="Builder model">
                      <SelectValue
                        placeholder={modelsLoading ? 'Loading models…' : 'Select a model'}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {enabledModels.map((m) => (
                        <SelectItem key={m.modelId} value={m.modelId}>
                          {m.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {!modelsLoading && enabledModels.length === 0 && (
                    <p className="text-xs text-destructive">
                      No enabled models found — enable one in Settings → Models first.
                    </p>
                  )}
                </div>

                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    onClick={startRun}
                    disabled={state.running || briefLength < MIN_BRIEF}
                  >
                    {state.running ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <Sparkles className="size-4" aria-hidden="true" />
                    )}
                    {state.running ? 'Building…' : 'Run agent'}
                  </Button>
                  {state.running && (
                    <Button variant="outline" onClick={stop} aria-label="Stop the agent">
                      <Square className="size-4 fill-current" aria-hidden="true" />
                      Stop
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-base">
                  <History className="size-4 text-violet-500" aria-hidden="true" />
                  History
                </CardTitle>
                <CardDescription>Projects this agent has built.</CardDescription>
              </CardHeader>
              <CardContent>
                {historyLoading ? (
                  <HistorySkeleton />
                ) : history && history.length > 0 ? (
                  <div className="emor-scroll max-h-96 space-y-1 overflow-y-auto pr-1" role="list">
                    {history.map((item) => {
                      const meta = kindMeta(item.kind);
                      const Icon = meta.icon;
                      const active = item.id === activeId;
                      return (
                        <div
                          key={item.id}
                          role="listitem"
                          className={cn(
                            'flex items-center gap-1 rounded-lg border pr-1 transition-colors',
                            active
                              ? 'border-primary/40 bg-primary/[0.06]'
                              : 'border-transparent hover:bg-accent/50'
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => setSelectedArtifactId(item.id)}
                            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-2.5 text-left"
                            aria-pressed={active}
                          >
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40">
                              <Icon
                                className={cn('size-4', active ? 'text-primary' : 'text-violet-500')}
                                aria-hidden="true"
                              />
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{item.title}</span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {meta.label} · {formatDate(item.createdAt)} · {formatBytes(item.size)}
                              </span>
                            </span>
                          </button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 w-8 shrink-0 p-0 text-muted-foreground"
                                aria-label={`Options for ${item.title}`}
                              >
                                <MoreVertical className="size-4" aria-hidden="true" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem onClick={() => setSelectedArtifactId(item.id)}>
                                <Eye className="size-3.5" aria-hidden="true" />
                                Open
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleteTarget(item)}>
                                <Trash2 className="size-3.5" aria-hidden="true" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
                    No builds yet — finished projects will appear here.
                  </p>
                )}
              </CardContent>
            </Card>
          </aside>

          {/* ── Right: run progress + artifact ──────────────────────────────── */}
          <section aria-label="Build output" className="min-w-0">
            {state.running && selectedArtifactId && (
              <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/[0.06] px-4 py-3">
                <p className="flex items-center gap-2 text-sm">
                  <Loader2 className="size-4 shrink-0 animate-spin text-amber-500" aria-hidden="true" />
                  A build is running…
                </p>
                <Button size="sm" variant="outline" onClick={() => setSelectedArtifactId(null)}>
                  View live build
                </Button>
              </div>
            )}

            {selectedArtifactId && detailQuery.isPending ? (
              <DetailSkeleton />
            ) : selectedArtifactId && detailQuery.isError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not load this project</AlertTitle>
                <AlertDescription className="flex flex-wrap items-center gap-3">
                  <span>It may have been deleted.</span>
                  <Button size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
                    <RefreshCw className="size-3.5" aria-hidden="true" />
                    Retry
                  </Button>
                </AlertDescription>
              </Alert>
            ) : detailArtifact ? (
              <ArtifactView
                key={detailArtifact.id}
                artifact={detailArtifact}
                onDelete={handleDelete}
                deletePending={deleteArtifact.isPending}
              />
            ) : liveInProgress ? (
              <RunPanel state={state} />
            ) : (
              <EmptyOutput />
            )}
          </section>
        </div>
      </div>

      {/* History delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project?</AlertDialogTitle>
            <AlertDialogDescription>
              “{deleteTarget?.title}” and all of its files will be permanently removed. This cannot
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) handleDelete(deleteTarget.id);
                setDeleteTarget(null);
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
