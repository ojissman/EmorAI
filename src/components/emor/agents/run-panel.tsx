"use client";

// Live run progress: steps timeline, plan card, streaming file tail, error alert.

import { useEffect, useRef } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  ListChecks,
  Loader2,
  Map,
  XCircle,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { AgentPlan, AgentStep } from '@/lib/types';
import type { AgentRunState } from '@/hooks/use-agent-run';
import { cn } from '@/lib/utils';

/** How much of a streaming file's tail to keep in the <pre> (keeps re-renders cheap). */
const TAIL_CHARS = 4000;

function StepIcon({ status }: { status: AgentStep['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 className="size-3.5 text-emerald-500" aria-hidden="true" />;
  }
  if (status === 'failed') {
    return <XCircle className="size-3.5 text-destructive" aria-hidden="true" />;
  }
  return <Loader2 className="size-3.5 animate-spin text-amber-500" aria-hidden="true" />;
}

function StepTimeline({ steps }: { steps: AgentStep[] }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ListChecks className="size-4 text-primary" aria-hidden="true" />
          Agent activity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="relative ml-2.5 space-y-4 border-l pl-6">
          {steps.map((step) => (
            <li key={step.id} className="relative">
              <span
                className="absolute -left-[31px] top-0 flex size-5 items-center justify-center rounded-full border bg-background"
                aria-hidden="true"
              >
                <StepIcon status={step.status} />
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium leading-5">{step.label}</span>
                {step.status === 'running' && (
                  <Badge variant="outline" className="h-4.5 px-1.5 text-[10px] font-normal text-amber-600 dark:text-amber-400">
                    Running
                  </Badge>
                )}
              </div>
              {step.detail && (
                <p className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{step.detail}</p>
              )}
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function PlanCard({ plan }: { plan: AgentPlan }) {
  return (
    <Card className="border-primary/30 bg-primary/[0.03]">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <Map className="size-3.5 text-primary" aria-hidden="true" />
          Build plan
        </div>
        <CardTitle className="text-base">{plan.title}</CardTitle>
        {plan.description && (
          <p className="text-sm text-muted-foreground">{plan.description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {plan.pages.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Pages</p>
            <div className="flex flex-wrap gap-1.5">
              {plan.pages.map((page) => (
                <Badge key={page} variant="secondary" className="max-w-full font-normal">
                  <span className="truncate">{page}</span>
                </Badge>
              ))}
            </div>
          </div>
        )}
        {plan.features.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Features</p>
            <ul className="space-y-1.5">
              {plan.features.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm">
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden="true" />
                  <span>{feature}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function LiveFileCard({ path, content, done }: { path: string; content: string; done: boolean }) {
  const preRef = useRef<HTMLPreElement | null>(null);

  // Keep the streaming tail pinned to the bottom until the file finishes.
  useEffect(() => {
    if (!done && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [content, done]);

  const tail = content.length > TAIL_CHARS ? `…${content.slice(-TAIL_CHARS)}` : content;

  return (
    <Card className="overflow-hidden py-0">
      <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2.5">
        <FileCode2 className="size-4 shrink-0 text-violet-500" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{path}</span>
        {done ? (
          <Badge variant="outline" className="gap-1 border-emerald-500/30 text-[10px] font-normal text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="size-2.5" aria-hidden="true" />
            Done
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1.5 text-[10px] font-normal">
            <span className="size-1.5 animate-pulse rounded-full bg-amber-500" aria-hidden="true" />
            Writing
          </Badge>
        )}
      </div>
      <pre
        ref={preRef}
        className={cn(
          'emor-scroll max-h-40 overflow-y-auto px-4 py-3 text-xs leading-relaxed',
          done ? 'text-muted-foreground' : 'text-foreground/90'
        )}
      >
        <code className="whitespace-pre font-mono">{tail || ' '}</code>
      </pre>
    </Card>
  );
}

export function RunPanel({ state }: { state: AgentRunState }) {
  const { steps, plan, files, error, running } = state;

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Build failed</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <p className="text-xs">
              Check that a builder model is enabled in Settings → Models, then try again. Partial
              progress above is kept until you start a new run.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {steps.length > 0 && <StepTimeline steps={steps} />}
      {plan && <PlanCard plan={plan} />}

      {files.length > 0 ? (
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Files — {files.filter((f) => f.done).length}/{files.length} written
          </p>
          {files.map((file) => (
            <LiveFileCard key={file.path} path={file.path} content={file.content} done={file.done} />
          ))}
        </div>
      ) : (
        running && (
          <div className="flex items-center gap-3 rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin text-amber-500" aria-hidden="true" />
            The agent is thinking — files will stream in here as they are written.
          </div>
        )
      )}
    </div>
  );
}
