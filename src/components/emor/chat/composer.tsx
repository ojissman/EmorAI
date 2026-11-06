"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Globe, ImagePlus, Loader2, Mic, MicOff, Paperclip, Square, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from 'sonner';
import { api, transcribeAudioClient } from '@/lib/api-client';
import { useDictation } from '@/hooks/use-dictation';
import type { MessageAttachment, ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

type ComposerProps = {
  onSend: (payload: { message: string; attachmentIds: string[]; attachments: MessageAttachment[]; webSearch: boolean }) => void;
  onStop: () => void;
  isStreaming: boolean;
  model: ModelInfo | null;
  webSearchDefault?: boolean;
  autoFocus?: boolean;
};

type PendingAttachment = MessageAttachment & { uploading?: boolean };

export function Composer({ onSend, onStop, isStreaming, model, webSearchDefault, autoFocus }: ComposerProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [webSearch, setWebSearch] = useState(!!webSearchDefault);
  const [uploading, setUploading] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const dictation = useDictation({
    onComplete: (audioBase64) => {
      void (async () => {
        try {
          const text = await transcribeAudioClient(audioBase64);
          dictation.reset();
          if (!text) {
            toast.error('Nothing was heard — try speaking a little louder.');
            return;
          }
          setValue((prev) => (prev ? `${prev} ${text}` : text));
          requestAnimationFrame(() => {
            resize();
            textareaRef.current?.focus();
          });
        } catch (e) {
          dictation.reset();
          toast.error((e as Error).message);
        }
      })();
    },
    onError: (msg) => {
      dictation.reset();
      toast.error(msg);
    },
  });

  useEffect(() => {
    setWebSearch(!!webSearchDefault);
  }, [webSearchDefault]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const resize = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  };

  const canSend = (value.trim().length > 0 || attachments.some((a) => !a.uploading)) && !isStreaming && !uploading;

  const uploadFiles = async (files: FileList, kind: 'image' | 'document') => {
    for (const file of Array.from(files).slice(0, 6)) {
      if (file.size > 10 * 1024 * 1024) {
        toast.error(`"${file.name}" exceeds the 10 MB limit.`);
        continue;
      }
      const tempId = `uploading-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      setAttachments((prev) => [
        ...prev,
        { id: tempId, name: file.name, mime: file.type, size: file.size, kind, uploading: true },
      ]);
      setUploading(true);
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await api.upload<{ file: MessageAttachment }>('/api/files/upload', form);
        setAttachments((prev) => prev.map((a) => (a.id === tempId ? { ...res.file } : a)));
      } catch (e) {
        toast.error(String((e as Error).message));
        setAttachments((prev) => prev.filter((a) => a.id !== tempId));
      } finally {
        setUploading(false);
      }
    }
  };

  const submit = () => {
    if (!canSend) return;
    const ready = attachments.filter((a) => !a.uploading);
    onSend({
      message: value.trim(),
      attachmentIds: ready.map((a) => a.id),
      attachments: ready.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size, kind: a.kind as 'image' | 'document' })),
      webSearch,
    });
    setValue('');
    setAttachments([]);
    requestAnimationFrame(resize);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const hasImages = attachments.some((a) => a.kind === 'image');
  const visionWarning = hasImages && model && !model.capabilities.vision;

  return (
    <div className="px-3 pb-3 sm:px-6 sm:pb-4">
      <div className="mx-auto w-full max-w-3xl">
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="group relative inline-flex items-center gap-2 rounded-lg border bg-card py-1.5 pl-2 pr-7 text-xs"
              >
                {a.uploading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : a.kind === 'image' ? (
                  <img src={`/api/files/${a.id}`} alt={a.name} className="size-8 rounded-md object-cover" />
                ) : (
                  <Paperclip className="size-3.5 text-muted-foreground" />
                )}
                <span className="max-w-36 truncate text-muted-foreground">{a.name}</span>
                <button
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  aria-label={`Remove ${a.name}`}
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        {visionWarning && (
          <p className="mb-2 text-xs text-amber-500">
            {model?.displayName} does not support image inputs. Attach documents, or switch to a vision model (e.g. GLM-4.6V Flash).
          </p>
        )}

        <div
          className={cn(
            'rounded-2xl border bg-card shadow-sm transition-shadow focus-within:ring-1 focus-within:ring-ring'
          )}
        >
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              resize();
            }}
            onKeyDown={handleKeyDown}
            placeholder={isStreaming ? 'EmorAI is responding…' : 'Message EmorAI…'}
            rows={1}
            className="max-h-56 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isStreaming}
            aria-label="Chat message"
          />
          <div className="flex items-center justify-between px-2.5 pb-2.5 pt-1">
            <div className="flex items-center gap-1">
              <input
                ref={imageInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif,image/bmp"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void uploadFiles(e.target.files, 'image');
                  e.target.value = '';
                }}
              />
              <input
                ref={docInputRef}
                type="file"
                accept=".pdf,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.log,.ts,.tsx,.js,.jsx,.py,.rb,.go,.rs,.java,.c,.h,.cpp,.cs,.php,.sh,.sql,.html,.xml,.css,.toml,.ini"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files?.length) void uploadFiles(e.target.files, 'document');
                  e.target.value = '';
                }}
              />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0 text-muted-foreground"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={isStreaming || uploading}
                    aria-label="Attach images"
                  >
                    <ImagePlus className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach images (vision models)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-8 p-0 text-muted-foreground"
                    onClick={() => docInputRef.current?.click()}
                    disabled={isStreaming || uploading}
                    aria-label="Attach documents"
                  >
                    <Paperclip className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Attach documents (PDF, text, code)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'size-8 p-0',
                      dictation.isRecording ? 'text-red-500' : 'text-muted-foreground'
                    )}
                    onClick={() => (dictation.isRecording ? dictation.stop() : void dictation.start())}
                    disabled={isStreaming || dictation.state === 'processing' || dictation.state === 'requesting'}
                    aria-label={dictation.isRecording ? 'Stop recording' : 'Dictate message'}
                    aria-pressed={dictation.isRecording}
                  >
                    {dictation.state === 'processing' || dictation.state === 'requesting' ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : dictation.isRecording ? (
                      <MicOff className="size-4" />
                    ) : (
                      <Mic className="size-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {dictation.isRecording
                    ? `Stop recording (${dictation.elapsedSec}s)`
                    : 'Dictate with your microphone'}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn('h-8 gap-1.5 px-2 text-xs', webSearch ? 'text-primary' : 'text-muted-foreground')}
                    onClick={() => setWebSearch((v) => !v)}
                    disabled={isStreaming}
                    aria-pressed={webSearch}
                    aria-label="Toggle web search"
                  >
                    <Globe className="size-4" />
                    <span className="hidden sm:inline">Web search</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Augment the answer with live web results</TooltipContent>
              </Tooltip>
            </div>
            <div className="flex items-center gap-2">
              {isStreaming ? (
                <Button size="sm" className="h-8 gap-1.5 rounded-xl px-3" onClick={onStop} aria-label="Stop generation">
                  <Square className="size-3.5 fill-current" />
                  Stop
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="h-8 w-8 rounded-xl p-0"
                  onClick={submit}
                  disabled={!canSend}
                  aria-label="Send message"
                >
                  <ArrowUp className="size-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
          {dictation.isRecording
            ? `Recording… ${dictation.elapsedSec}s — tap the mic to transcribe`
            : 'Enter to send · Shift+Enter for a new line · EmorAI can make mistakes'}
        </p>
      </div>
    </div>
  );
}
