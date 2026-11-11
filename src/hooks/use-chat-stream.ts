"use client";

import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useEmorStore } from '@/stores/emor-store';
import { optimisticUserMessage } from '@/stores/emor-store';
import type { ChatStreamEvent, MessageAttachment, SerializedConversation } from '@/lib/types';

type SendArgs = {
  conversationId: string | null;
  message: string;
  modelId: string;
  webSearch?: boolean;
  attachmentIds?: string[];
  attachments?: MessageAttachment[];
  onConversationCreated?: (conversation: SerializedConversation) => void;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function useChatStream() {
  const qc = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const store = useEmorStore;

  const invalidateAfter = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['conversations'] });
    void qc.invalidateQueries({ queryKey: ['messages'] });
    void qc.invalidateQueries({ queryKey: ['usage'] });
  }, [qc]);

  const run = useCallback(
    async (args: SendArgs & { mode: 'send' | 'regenerate' | 'edit'; editMessageId?: string }) => {
      const { conversationId, mode } = args;
      // Guard: one stream at a time.
      if (store.getState().streaming) return;

      store.getState().startStreaming({
        conversationId: conversationId ?? 'pending',
        mode,
        modelId: args.modelId,
        optimisticUserMessage:
          mode === 'send'
            ? optimisticUserMessage(conversationId ?? 'pending', args.message, args.attachments ?? [])
            : null,
      });

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationId ?? undefined,
            message: args.message,
            modelId: args.modelId,
            mode,
            editMessageId: args.editMessageId,
            webSearch: args.webSearch ?? false,
            attachmentIds: args.attachmentIds ?? [],
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let message = `Chat request failed (${res.status})`;
          let code = 'http_error';
          try {
            const body = (await res.json()) as { error?: { code?: string; message?: string } };
            if (body?.error?.message) message = body.error.message;
            if (body?.error?.code) code = body.error.code;
          } catch {
            // ignore
          }
          store.getState().updateStreaming({
            error: { code, message },
            phase: 'streaming',
          });
          toast.error(message);
          invalidateAfter();
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              let evt: ChatStreamEvent;
              try {
                evt = JSON.parse(line.slice(5)) as ChatStreamEvent;
              } catch {
                continue;
              }
              const s = store.getState().streaming;
              // After 'done' the streaming state is cleared, but the stream
              // stays open briefly for post-done events (title). Keep reading
              // those; anything else after the stream ended is stale.
              if (!s && evt.type !== 'title' && evt.type !== 'usage') break;
              switch (evt.type) {
                case 'start':
                  store.getState().updateStreaming({
                    phase: 'streaming',
                    conversationId: evt.conversationId,
                    assistantMessageId: evt.assistantMessageId,
                    userMessageId: evt.userMessageId || null,
                    optimisticUserMessage: null,
                  });
                  // A brand-new conversation was created server-side: adopt it.
                  if (s.mode === 'send' && s.conversationId !== evt.conversationId) {
                    store.getState().setActiveConversation(evt.conversationId);
                  }
                  void qc.invalidateQueries({ queryKey: ['messages', evt.conversationId] });
                  void qc.invalidateQueries({ queryKey: ['conversations'] });
                  break;
                case 'served-model':
                  store.getState().updateStreaming({ servedModel: evt.servedModel });
                  break;
                case 'delta':
                  store.getState().appendDelta(evt.content);
                  break;
                case 'reasoning':
                  store.getState().appendReasoning(evt.content);
                  break;
                case 'sources':
                  store.getState().updateStreaming({ sources: evt.sources });
                  break;
                case 'title': {
                  // May arrive after 'done' (title generation is decoupled
                  // from the reply) — target the event's own conversationId,
                  // falling back to the live streaming state.
                  const convId = evt.conversationId ?? s?.conversationId;
                  if (convId) {
                    qc.setQueryData<{ conversations: SerializedConversation[] }>(
                      ['conversations', ''],
                      (old) =>
                        old
                          ? {
                              conversations: old.conversations.map((c) =>
                                c.id === convId ? { ...c, title: evt.title } : c
                              ),
                            }
                          : old
                    );
                  }
                  void qc.invalidateQueries({ queryKey: ['conversations'] });
                  break;
                }
                case 'usage':
                  // Recorded server-side; usage dashboard picks it up on next visit.
                  break;
                case 'done':
                  invalidateAfter();
                  store.getState().stopStreaming();
                  break;
                case 'error':
                  toast.error(evt.message);
                  invalidateAfter();
                  store.getState().stopStreaming();
                  break;
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') {
          // The server persists the partial message as the stream is cancelled;
          // refetch immediately and again shortly after to win the race.
          invalidateAfter();
          setTimeout(() => invalidateAfter(), 1200);
          store.getState().stopStreaming();
        } else {
          toast.error(String((e as Error)?.message ?? 'Connection error'));
          store.getState().updateStreaming({
            error: { code: 'network', message: String((e as Error)?.message ?? 'Connection error') },
            phase: 'streaming',
          });
        }
      } finally {
        abortRef.current = null;
        // If still streaming state (e.g., stream ended without done event), clean up.
        if (store.getState().streaming) {
          invalidateAfter();
          store.getState().stopStreaming();
        }
      }
    },
    [qc, store, invalidateAfter]
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const send = useCallback(
    (args: SendArgs) => {
      if (store.getState().streaming) {
        toast.error('Please wait for the current response to finish.');
        return;
      }
      void run({ ...args, mode: 'send' });
    },
    [run, store]
  );

  const regenerate = useCallback(
    (conversationId: string, modelId: string) => {
      if (store.getState().streaming) {
        toast.error('Please wait for the current response to finish.');
        return;
      }
      void run({ conversationId, message: '', modelId, mode: 'regenerate' });
    },
    [run, store]
  );

  const editMessage = useCallback(
    (conversationId: string, editMessageId: string, message: string, modelId: string, webSearch?: boolean) => {
      if (store.getState().streaming) {
        toast.error('Please wait for the current response to finish.');
        return;
      }
      void run({ conversationId, editMessageId, message, modelId, mode: 'edit', webSearch });
    },
    [run, store]
  );

  return { send, regenerate, editMessage, stop, streaming: useEmorStore((s) => s.streaming) };
}
