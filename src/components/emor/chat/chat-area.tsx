"use client";

import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Globe, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmorLogo } from '../logo';
import { MessageItem } from './message-item';
import { Markdown } from './markdown';
import { EmptyState } from './empty-state';
import { Composer } from './composer';
import { useEmorStore } from '@/stores/emor-store';
import { useChatStream } from '@/hooks/use-chat-stream';
import { useConversationMessages, useModels } from '@/hooks/use-emor-queries';
import type { ModelInfo, SerializedMessage } from '@/lib/types';
import { cn } from '@/lib/utils';

function StreamingAssistantBubble({
  content,
  reasoning,
  servedModel,
  phase,
}: {
  content: string;
  reasoning: string;
  servedModel: string | null;
  phase: string;
}) {
  return (
    <div className="emor-enter flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border bg-card">
        <EmorLogo size={18} />
      </div>
      <div className="min-w-0 flex-1">
        {reasoning && (
          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> Thinking…
          </p>
        )}
        {content ? (
          <div className="emor-caret">
            <Markdown content={content} />
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {phase === 'connecting' ? 'Connecting…' : 'Generating…'}
          </p>
        )}
        {servedModel && <p className="mt-1.5 text-[11px] text-muted-foreground">{servedModel}</p>}
      </div>
    </div>
  );
}

export function ChatArea({
  activeConversationId,
  activeModel,
  onModelMissing,
}: {
  activeConversationId: string | null;
  activeModel: ModelInfo | null;
  onModelMissing: () => void;
}) {
  const { data: messagesData, isLoading: messagesLoading } = useConversationMessages(activeConversationId);
  const { data: modelsData } = useModels();
  const streaming = useEmorStore((s) => s.streaming);
  const { send, regenerate, editMessage, stop } = useChatStream();

  const [showScrollButton, setShowScrollButton] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  const dbMessages = useMemo(() => {
    const rows = (messagesData?.messages ?? []).filter((m) => m.status !== 'streaming');
    return rows;
  }, [messagesData]);

  const streamingHere = streaming && streaming.conversationId === (activeConversationId ?? 'pending');
  const streamingElsewhere = streaming && !streamingHere;

  // Auto-scroll while streaming, stick-to-bottom behavior.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < 80;
      setShowScrollButton(distance > 240);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dbMessages.length, streamingHere, streaming?.content, streaming?.reasoning, activeConversationId]);

  useEffect(() => {
    // Reset stick on conversation switch.
    stickToBottomRef.current = true;
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [activeConversationId]);

  const lastAssistantId = useMemo(() => {
    for (let i = dbMessages.length - 1; i >= 0; i--) {
      if (dbMessages[i].role === 'assistant') return dbMessages[i].id;
    }
    return null;
  }, [dbMessages]);

  const renderUserOptimistic = streamingHere && streaming!.mode === 'send' && streaming!.optimisticUserMessage;

  const handleSend = (payload: {
    message: string;
    attachmentIds: string[];
    attachments: MessageAttachment[];
    webSearch: boolean;
  }) => {
    const modelId = activeModel?.modelId;
    if (!modelId) {
      onModelMissing();
      return;
    }
    send({
      conversationId: activeConversationId,
      message: payload.message,
      modelId,
      webSearch: payload.webSearch,
      attachmentIds: payload.attachmentIds,
      attachments: payload.attachments,
    });
  };

  const handleEdit = (messageId: string, content: string) => {
    if (!activeConversationId || !activeModel) return;
    editMessage(activeConversationId, messageId, content, activeModel.modelId);
  };

  const suggestionsEnabled = dbMessages.length === 0 && !streamingHere;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="emor-scroll relative min-h-0 flex-1 overflow-y-auto">
        {suggestionsEnabled ? (
          <EmptyState
            onPick={(prompt) =>
              activeModel &&
              send({ conversationId: activeConversationId, message: prompt, modelId: activeModel.modelId })
            }
          />
        ) : (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
            {messagesLoading && dbMessages.length === 0 && !streamingHere && (
              <div className="space-y-4 py-4">
                {[0, 1].map((i) => (
                  <div key={i} className="space-y-2">
                    <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
                    <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            )}

            {dbMessages.map((m) => (
              <MessageItem
                key={m.id}
                message={m}
                isLastAssistant={m.id === lastAssistantId && !streamingHere}
                onEdit={m.role === 'user' && !streamingHere ? handleEdit : undefined}
                onRegenerate={
                  m.role === 'assistant' && m.id === lastAssistantId && !streamingHere && activeConversationId && activeModel
                    ? () => regenerate(activeConversationId, activeModel.modelId)
                    : undefined
                }
              />
            ))}

            {renderUserOptimistic && (
              <MessageItem
                message={streaming!.optimisticUserMessage as SerializedMessage}
                isLastAssistant={false}
              />
            )}

            {streamingHere &&
              (streaming!.error ? (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3.5 text-sm">
                  <p className="font-medium text-destructive">Generation failed</p>
                  <p className="mt-1 text-xs text-muted-foreground">{streaming!.error.message}</p>
                </div>
              ) : (
                <StreamingAssistantBubble
                  content={streaming!.content}
                  reasoning={streaming!.reasoning}
                  servedModel={streaming!.servedModel}
                  phase={streaming!.phase}
                />
              ))}
          </div>
        )}
      </div>

      {showScrollButton && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-40 left-1/2 z-10 h-8 w-8 -translate-x-1/2 rounded-full p-0 shadow-md"
          onClick={() => {
            stickToBottomRef.current = true;
            scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
          }}
          aria-label="Scroll to bottom"
        >
          <ArrowDown className="size-4" />
        </Button>
      )}

      {streamingElsewhere && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center pt-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground shadow-sm">
            <Loader2 className="size-3 animate-spin" /> Generating in another conversation…
          </span>
        </div>
      )}

      <Composer
        onSend={handleSend}
        onStop={stop}
        isStreaming={!!streaming}
        model={activeModel}
        autoFocus
      />
    </div>
  );
}
