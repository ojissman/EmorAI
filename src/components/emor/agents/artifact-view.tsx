"use client";

// Rendered artifact: browser-style preview, browsable code with copy, ZIP download, delete.

import { useMemo, useState } from 'react';
import {
  Calendar,
  Check,
  Code2,
  Copy,
  Download,
  Eye,
  FileCode2,
  Loader2,
  Lock,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { artifactUrls } from '@/lib/api-client';
import type { ArtifactFile, SerializedArtifact } from '@/lib/types';
import { cn } from '@/lib/utils';
import { byteSize, formatBytes, formatDate, kindMeta } from './agent-meta';

type ArtifactViewProps = {
  artifact: SerializedArtifact;
  onDelete?: (id: string) => void;
  deletePending?: boolean;
};

function copyToClipboard(content: string) {
  void navigator.clipboard
    .writeText(content)
    .then(() => toast.success('Copied to clipboard'))
    .catch(() => toast.error('Could not copy to clipboard'));
}

function BrowserFrame({ artifact }: { artifact: SerializedArtifact }) {
  const url = artifactUrls.preview(artifact.id);
  return (
    <div className="overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="flex items-center gap-2 border-b bg-muted/50 px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden="true">
          <span className="size-2.5 rounded-full bg-red-400" />
          <span className="size-2.5 rounded-full bg-amber-400" />
          <span className="size-2.5 rounded-full bg-emerald-400" />
        </span>
        <div className="ml-1 flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-background px-2.5 py-1">
          <Lock className="size-3 shrink-0 text-emerald-500" aria-hidden="true" />
          <span className="truncate font-mono text-[11px] text-muted-foreground">{url}</span>
        </div>
      </div>
      <iframe
        src={url}
        className="h-[60vh] min-h-[560px] w-full bg-white"
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        title={`Preview of ${artifact.title}`}
      />
    </div>
  );
}

function FileList({
  files,
  activePath,
  onSelect,
}: {
  files: ArtifactFile[];
  activePath: string | null;
  onSelect: (path: string) => void;
}) {
  return (
    <nav
      aria-label="Project files"
      className="emor-scroll flex gap-1 overflow-x-auto rounded-lg border bg-muted/30 p-1.5 md:max-h-[60vh] md:flex-col md:overflow-y-auto"
    >
      {files.map((file) => {
        const active = file.path === activePath;
        return (
          <button
            key={file.path}
            type="button"
            onClick={() => onSelect(file.path)}
            aria-current={active ? 'true' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors md:w-full',
              active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:bg-background/60'
            )}
          >
            <FileCode2 className={cn('size-3.5 shrink-0', active ? 'text-violet-500' : 'text-muted-foreground/70')} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
            <span className="hidden shrink-0 text-[10px] text-muted-foreground/80 md:block">
              {formatBytes(byteSize(file.content))}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function CodeBrowser({ files }: { files: ArtifactFile[] }) {
  const entryIndex = files.findIndex((f) => f.entry || f.path === 'index.html');
  const defaultPath = files[entryIndex >= 0 ? entryIndex : 0]?.path ?? null;
  const [picked, setPicked] = useState<string | null>(null);

  const activePath = picked && files.some((f) => f.path === picked) ? picked : defaultPath;
  const active = files.find((f) => f.path === activePath) ?? null;

  if (!active) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No source files were stored for this artifact.
      </p>
    );
  }

  return (
    <div className="grid gap-3 md:grid-cols-[230px_1fr]">
      <FileList files={files} activePath={activePath} onSelect={setPicked} />
      <div className="min-w-0 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium">{active.path}</span>
          <span className="hidden shrink-0 text-[11px] text-muted-foreground sm:block">
            {formatBytes(byteSize(active.content))}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-xs"
            onClick={() => copyToClipboard(active.content)}
          >
            <Copy className="size-3.5" aria-hidden="true" />
            Copy
          </Button>
        </div>
        <pre className="emor-scroll max-h-[60vh] overflow-auto bg-muted/20 px-4 py-3 text-xs leading-relaxed text-foreground/90">
          <code className="whitespace-pre font-mono">{active.content}</code>
        </pre>
      </div>
    </div>
  );
}

export function ArtifactView({ artifact, onDelete, deletePending = false }: ArtifactViewProps) {
  const [tab, setTab] = useState<'preview' | 'code'>('preview');
  const meta = kindMeta(artifact.kind);
  const Icon = meta.icon;

  const files = artifact.files ?? [];
  const totalSize = useMemo(() => files.reduce((sum, f) => sum + byteSize(f.content), 0), [files]);
  const pending = artifact.status === 'pending' || artifact.status === 'processing';

  return (
    <section className="space-y-4" aria-label={`Artifact ${artifact.title}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
              <Icon className="size-4 text-violet-500" aria-hidden="true" />
            </span>
            <h2 className="min-w-0 text-lg font-semibold leading-tight tracking-tight">{artifact.title}</h2>
            <Badge variant="secondary" className="font-normal">
              {meta.label}
            </Badge>
          </div>
          {artifact.description && (
            <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">{artifact.description}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {artifact.modelId && (
              <span className="inline-flex items-center gap-1">
                <Check className="size-3" aria-hidden="true" />
                {artifact.modelId}
              </span>
            )}
            <span className="inline-flex items-center gap-1">
              <Calendar className="size-3" aria-hidden="true" />
              {formatDate(artifact.createdAt)}
            </span>
            {files.length > 0 && (
              <span className="inline-flex items-center gap-1">
                <FileCode2 className="size-3" aria-hidden="true" />
                {files.length} file{files.length === 1 ? '' : 's'} · {formatBytes(totalSize)}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={artifactUrls.zip(artifact.id)} download aria-label={`Download ${artifact.title} as ZIP`}>
              <Download className="size-4" aria-hidden="true" />
              ZIP
            </a>
          </Button>
          {onDelete && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={deletePending}
                  aria-label={`Delete ${artifact.title}`}
                >
                  {deletePending ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="size-4" aria-hidden="true" />
                  )}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this project?</AlertDialogTitle>
                  <AlertDialogDescription>
                    “{artifact.title}” and all of its files will be permanently removed. This cannot
                    be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    onClick={() => onDelete(artifact.id)}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {artifact.status === 'failed' && (
        <Alert variant="destructive">
          <AlertTitle>This artifact failed to build</AlertTitle>
          <AlertDescription>{artifact.error ?? 'An unknown error occurred.'}</AlertDescription>
        </Alert>
      )}

      {pending && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <Loader2 className="size-6 animate-spin text-amber-500" aria-hidden="true" />
            <p className="text-sm font-medium">Finishing up…</p>
            <p className="text-xs text-muted-foreground">
              The project files are being written. The preview will appear here automatically.
            </p>
          </CardContent>
        </Card>
      )}

      {!pending && artifact.status !== 'failed' && (
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'preview' | 'code')}>
          <TabsList aria-label="Artifact views">
            <TabsTrigger value="preview">
              <Eye className="size-4" aria-hidden="true" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="code">
              <Code2 className="size-4" aria-hidden="true" />
              Code
            </TabsTrigger>
          </TabsList>
          <TabsContent value="preview" className="mt-2">
            <BrowserFrame artifact={artifact} />
          </TabsContent>
          <TabsContent value="code" className="mt-2">
            {files.length > 0 ? (
              <CodeBrowser files={files} />
            ) : (
              <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                No source files were stored for this artifact.
              </p>
            )}
          </TabsContent>
        </Tabs>
      )}
    </section>
  );
}
