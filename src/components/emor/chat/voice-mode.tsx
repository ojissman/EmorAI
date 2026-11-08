"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AudioLines, Loader2, Mic, Square, Volume2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from 'sonner';
import { transcribeAudioClient } from '@/lib/api-client';
import { useDictation } from '@/hooks/use-dictation';
import { useSpeech } from '@/hooks/use-speech';
import type { ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

type VoiceModeDialogProps = {
  conversationId: string | null;
  model: ModelInfo | null;
};

type Turn = { role: 'user' | 'assistant'; text: string };

type Phase = 'idle' | 'recording' | 'transcribing' | 'thinking' | 'speaking';

/**
 * Hands-free voice chat: talk → transcript → streamed reply → spoken answer.
 * Sends through /api/chat directly (same engine as the main chat area) and
 * syncs the sidebar/message caches when the turn completes.
 */
export function VoiceModeDialog({ conversationId, model }: VoiceModeDialogProps) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [partialText, setPartialText] = useState('');
  const [handsFree, setHandsFree] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const handsFreeRef = useRef(handsFree);

  useEffect(() => {
    handsFreeRef.current = handsFree;
  }, [handsFree]);

  const speech = useSpeech();

  const handleDictation = useCallback(
    async (audioBase64: string) => {
      setPhase('transcribing');
      try {
        const text = await transcribeAudioClient(audioBase64);
        if (!text) {
          toast.error('Nothing was heard — try speaking a little louder.');
          setPhase('idle');
          return;
        }
        setTurns((prev) => [...prev, { role: 'user', text }]);
        setPartialText('');
        setPhase('thinking');
        await streamReply(text);
      } catch (e) {
        toast.error((e as Error).message);
        setPhase('idle');
      }
    },
    [conversationId, model]
  );

  const dictation = useDictation({
    onComplete: (b64) => void handleDictation(b64),
    onError: (msg) => {
      toast.error(msg);
      setPhase('idle');
    },
  });

  // Keep the dialog's phase in sync with recording state.
  useEffect(() => {
    if (dictation.isRecording) setPhase('recording');
  }, [dictation.isRecording]);

  const streamReply = useCallback(
    async (userText: string) => {
      const controller = new AbortController();
      abortRef.current = controller;
      let full = '';
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationId ?? undefined,
            message: userText,
            modelId: model?.modelId ?? 'glm-5.3-flash',
            mode: 'send',
            webSearch: false,
            attachmentIds: [],
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          let message = `Chat failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            if (body?.error?.message) message = body.error.message;
          } catch {
            // non-JSON
          }
          throw new Error(message);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamDone = false;

        const processFrame = (line: string) => {
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') {
            streamDone = true;
            return;
          }
          try {
            const ev = JSON.parse(payload) as {
              type?: string;
              delta?: string;
              content?: string;
              error?: { message?: string };
            };
            if (ev.type === 'delta' && ev.delta) {
              full += ev.delta;
              setPartialText(full);
            } else if (ev.type === 'error' && ev.error?.message) {
              throw new Error(ev.error.message);
            }
          } catch (e) {
            if (e instanceof SyntaxError) return;
            throw e;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line) processFrame(line);
          }
          if (streamDone) break;
        }

        const reply = full.trim();
        if (!reply) throw new Error('The model returned an empty reply.');
        setTurns((prev) => [...prev, { role: 'assistant', text: reply }]);
        setPartialText('');
        void qc.invalidateQueries({ queryKey: ['conversations'] });
        void qc.invalidateQueries({ queryKey: ['messages'] });
        void qc.invalidateQueries({ queryKey: ['usage'] });

        setPhase('speaking');
        await speech.speak(`voice-${Date.now()}`, reply, { speed: 1 });
        setPhase('idle');
        if (handsFreeRef.current && open) {
          // Small pause so the mouth of the orb visibly resets before listening.
          setTimeout(() => {
            if (handsFreeRef.current) void dictation.start();
          }, 600);
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        toast.error((e as Error).message);
        setPhase('idle');
      } finally {
        abortRef.current = null;
      }
    },
    [conversationId, model, qc, speech, dictation, open]
  );

  const toggleMic = () => {
    if (phase === 'recording') {
      dictation.stop();
    } else if (phase === 'idle') {
      setPartialText('');
      void dictation.start();
    }
  };

  const closeAndReset = () => {
    abortRef.current?.abort();
    if (phase === 'recording') dictation.cancel();
    speech.stop();
    setOpen(false);
    setPhase('idle');
  };

  const phaseLabel: Record<Phase, string> = {
    idle: 'Tap the mic and start talking',
    recording: 'Listening… tap to finish',
    transcribing: 'Transcribing your speech…',
    thinking: `${model?.displayName ?? 'EmorAI'} is thinking…`,
    speaking: 'Speaking — hands-free will listen again',
  };

  const orbActive = phase === 'recording';
  const orbBusy = phase === 'transcribing' || phase === 'thinking';

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : closeAndReset())}>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-label="Open voice mode"
      >
        <AudioLines className="size-4" />
        <span className="hidden sm:inline">Voice</span>
      </Button>
      <DialogContent className="max-w-lg gap-4 p-6" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AudioLines className="size-4 text-primary" /> Voice mode
          </DialogTitle>
          <DialogDescription>
            Talk to {model?.displayName ?? 'EmorAI'} out loud. Replies are spoken back to you.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col items-center gap-4 py-2">
          <button
            type="button"
            onClick={orbActive ? toggleMic : orbBusy ? undefined : toggleMic}
            disabled={orbBusy || phase === 'speaking'}
            aria-label={orbActive ? 'Stop recording' : 'Start recording'}
            className={cn(
              'relative flex size-28 items-center justify-center rounded-full border transition-all',
              orbActive
                ? 'border-red-500/40 bg-red-500/10'
                : orbBusy
                  ? 'border-border bg-muted/50'
                  : 'border-border bg-muted/30 hover:bg-muted/60',
              phase === 'idle' && 'cursor-pointer'
            )}
          >
            {orbActive && (
              <span className="absolute inset-0 animate-ping rounded-full bg-red-500/10" aria-hidden="true" />
            )}
            {orbActive ? (
              <Square className="size-8 fill-red-500 text-red-500" />
            ) : orbBusy ? (
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            ) : phase === 'speaking' ? (
              <Volume2 className="size-8 animate-pulse text-primary" />
            ) : (
              <Mic className="size-8 text-muted-foreground" />
            )}
          </button>
          <p className="min-h-5 text-center text-sm text-muted-foreground" aria-live="polite">
            {phaseLabel[phase]}
            {phase === 'recording' && dictation.elapsedSec > 0 && (
              <span className="ml-2 font-mono text-xs">
                {Math.floor(dictation.elapsedSec / 60)}:{String(dictation.elapsedSec % 60).padStart(2, '0')}
              </span>
            )}
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border px-3 py-2">
          <Label htmlFor="hands-free" className="text-xs text-muted-foreground">
            Hands-free (auto-listen after each reply)
          </Label>
          <Switch id="hands-free" checked={handsFree} onCheckedChange={setHandsFree} />
        </div>

        <ScrollArea className="h-44 rounded-lg border bg-muted/20">
          <div className="space-y-3 p-3">
            {turns.length === 0 && !partialText && (
              <p className="py-10 text-center text-xs text-muted-foreground">
                Your conversation transcript will appear here.
              </p>
            )}
            {turns.map((t, i) => (
              <div key={i} className={cn('text-sm', t.role === 'user' ? 'text-muted-foreground' : '')}>
                <span className={cn('mb-0.5 block text-[10px] font-semibold uppercase tracking-wide', t.role === 'user' ? 'text-muted-foreground/70' : 'text-primary')}>
                  {t.role === 'user' ? 'You' : model?.displayName ?? 'EmorAI'}
                </span>
                <p className="whitespace-pre-wrap leading-relaxed">{t.text}</p>
              </div>
            ))}
            {partialText && (
              <div className="text-sm">
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-primary">
                  {model?.displayName ?? 'EmorAI'}
                </span>
                <p className="whitespace-pre-wrap leading-relaxed">{partialText}</p>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex justify-end">
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={closeAndReset}>
            <X className="size-3.5" /> Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
