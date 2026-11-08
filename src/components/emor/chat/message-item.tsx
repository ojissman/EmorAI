"use client";

import { useState } from 'react';
import { AlertTriangle, Brain, Check, ChevronDown, Copy, ExternalLink, FileText, Loader2, Pencil, RefreshCw, Square, Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Markdown } from './markdown';
import { EmorLogo } from '../logo';
import { useSpeech } from '@/hooks/use-speech';
import type { MessageAttachment, SerializedMessage, WebSource } from '@/lib/types';
import { cn } from '@/lib/utils';

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function AttachmentChips({ attachments, compact }: { attachments: MessageAttachment[]; compact?: boolean }) {
  const images = attachments.filter((a) => a.kind === 'image');
  const docs = attachments.filter((a) => a.kind === 'document');
  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((img) => (
        <img
          key={img.id}
          src={`/api/files/${img.id}`}
          alt={img.name}
          className="h-20 w-20 rounded-lg border object-cover"
        />
      ))}
      {docs.map((doc) => (
        <span
          key={doc.id}
          className={cn(
            'inline-flex max-w-52 items-center gap-1.5 rounded-md border bg-muted px-2 py-1 text-xs text-muted-foreground',
            compact && 'text-[11px]'
          )}
        >
          <FileText className="size-3.5 shrink-0" />
          <span className="truncate">{doc.name}</span>
        </span>
      ))}
    </div>
  );
}

function SourceList({ sources }: { sources: WebSource[] }) {
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {sources.slice(0, 8).map((s, i) => (
        <a
          key={`${s.url}-${i}`}
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="group inline-flex max-w-64 items-center gap-1.5 rounded-full border bg-muted/60 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <ExternalLink className="size-3 shrink-0" />
          <span className="truncate">{s.host_name || s.name || s.url}</span>
        </a>
      ))}
    </div>
  );
}

function ReasoningBlock({ reasoning, streaming }: { reasoning: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="mb-3">
      <CollapsibleTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          aria-expanded={open}
        >
          <Brain className="size-3.5" />
          {streaming ? 'Thinking…' : 'Reasoning trace'}
          <ChevronDown className={cn('size-3 transition-transform', open && 'rotate-180')} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground emor-scroll">
          {reasoning}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActionButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground"
      onClick={onClick}
      aria-label={label}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </Button>
  );
}

export function MessageItem({
  message,
  isLastAssistant,
  onEdit,
  onRegenerate,
}: {
  message: SerializedMessage;
  isLastAssistant: boolean;
  onEdit?: (messageId: string, content: string) => void;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(message.content);
  const isUser = message.role === 'user';
  const speech = useSpeech();

  const readAloud = () => {
    if (speech.isBusy && speech.speakingId === message.id) {
      speech.stop();
      return;
    }
    void speech.speak(message.id, message.content).catch((e) => {
      console.error('Read-aloud failed:', e);
    });
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  const startEdit = () => {
    setDraft(message.content);
    setIsEditing(true);
  };

  const commitEdit = () => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== message.content) {
      onEdit?.(message.id, trimmed);
    }
    setIsEditing(false);
  };

  if (isUser) {
    return (
      <div className="emor-enter group flex flex-col items-end gap-1">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-2.5 text-sm leading-relaxed">
          {message.attachments && message.attachments.length > 0 && (
            <div className="mb-2">
              <AttachmentChips attachments={message.attachments} />
            </div>
          )}
          {message.webSearch && (
            <span className="mb-1.5 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
              Web search
            </span>
          )}
          {isEditing ? (
            <div className="min-w-64 space-y-2 sm:min-w-96">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    commitEdit();
                  }
                  if (e.key === 'Escape') setIsEditing(false);
                }}
                className="min-h-20 text-sm"
                autoFocus
                aria-label="Edit message"
              />
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setIsEditing(false)}>
                  <X className="size-3.5" /> Cancel
                </Button>
                <Button size="sm" onClick={commitEdit}>
                  <Check className="size-3.5" /> Save &amp; resend
                </Button>
              </div>
            </div>
          ) : (
            <p className="whitespace-pre-wrap">{message.content}</p>
          )}
        </div>
        {!isEditing && (
          <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <span className="mr-1 text-[11px] text-muted-foreground">{formatTime(message.createdAt)}</span>
            <ActionButton onClick={copy} label="Copy">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </ActionButton>
            {onEdit && (
              <ActionButton onClick={startEdit} label="Edit">
                <Pencil className="size-3.5" />
              </ActionButton>
            )}
          </div>
        )}
      </div>
    );
  }

  // Assistant message
  const isError = message.status === 'error';
  const stopped = message.status === 'stopped';

  return (
    <div className="emor-enter group flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card">
        <EmorLogo size={18} />
      </div>
      <div className="min-w-0 flex-1">
        {message.reasoning && <ReasoningBlock reasoning={message.reasoning} />}
        {isError ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-destructive">Generation failed</p>
                <p className="mt-1 break-words text-xs text-muted-foreground">{message.errorText ?? 'Unknown error'}</p>
                {onRegenerate && (
                  <Button size="sm" variant="outline" className="mt-2.5 h-7 gap-1.5 text-xs" onClick={onRegenerate}>
                    <RefreshCw className="size-3.5" /> Retry
                  </Button>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
            <Markdown content={message.content || (stopped ? '_(stopped before any output)_' : '')} />
            {stopped && (
              <p className="mt-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <X className="size-3" /> Stopped by you
              </p>
            )}
            {message.sources && message.sources.length > 0 && <SourceList sources={message.sources} />}
          </>
        )}
        <div className="mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <span className="mr-1 text-[11px] text-muted-foreground">
            {formatTime(message.createdAt)}
            {message.servedModel ? ` · ${message.servedModel}` : ''}
            {message.totalTokens ? ` · ${message.totalTokens.toLocaleString()} tokens` : ''}
            {message.latencyMs ? ` · ${(message.latencyMs / 1000).toFixed(1)}s` : ''}
          </span>
          {!isError && (
            <ActionButton onClick={copy} label="Copy">
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            </ActionButton>
          )}
          {!isError && message.content.trim().length > 0 && (
            <ActionButton
              onClick={readAloud}
              label={speech.speakingId === message.id && speech.isBusy ? 'Stop reading' : 'Read aloud'}
            >
              {speech.speakingId === message.id && speech.state === 'loading' ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : speech.speakingId === message.id && speech.state === 'playing' ? (
                <Square className="size-3.5 fill-current text-primary" />
              ) : (
                <Volume2 className="size-3.5" />
              )}
            </ActionButton>
          )}
          {isLastAssistant && onRegenerate && (
            <ActionButton onClick={onRegenerate} label="Regenerate">
              <RefreshCw className="size-3.5" />
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}
