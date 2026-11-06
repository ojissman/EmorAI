"use client";

import { create } from 'zustand';
import type { MessageAttachment, SerializedMessage, WebSource } from '@/lib/types';

export type DialogKind = 'settings' | 'keys' | 'docs' | 'usage' | 'summary' | null;

export type StreamingState = {
  conversationId: string;
  mode: 'send' | 'regenerate' | 'edit';
  phase: 'connecting' | 'streaming' | 'waiting-title';
  assistantMessageId: string;
  userMessageId: string | null;
  optimisticUserMessage: SerializedMessage | null;
  content: string;
  reasoning: string;
  sources: WebSource[] | null;
  servedModel: string | null;
  error: { code: string; message: string } | null;
  modelId: string;
};

type EmorStore = {
  sidebarOpen: boolean;
  mobileSidebarOpen: boolean;
  activeConversationId: string | null;
  // When true, the dashboard must not auto-select the most recent
  // conversation (set when the user explicitly starts a new chat).
  suppressAutoSelect: boolean;
  draftModelId: string | null;
  dialog: DialogKind;
  dialogTab: string | null;
  streaming: StreamingState | null;

  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setMobileSidebarOpen: (open: boolean) => void;
  setActiveConversation: (id: string | null) => void;
  setDraftModelId: (id: string | null) => void;
  openDialog: (kind: Exclude<DialogKind, null>, tab?: string) => void;
  closeDialog: () => void;
  startStreaming: (state: Pick<StreamingState, 'conversationId' | 'mode'> & Partial<StreamingState>) => void;
  updateStreaming: (patch: Partial<StreamingState>) => void;
  appendDelta: (content: string) => void;
  appendReasoning: (content: string) => void;
  stopStreaming: () => void;
};

export const useEmorStore = create<EmorStore>((set) => ({
  sidebarOpen: true,
  mobileSidebarOpen: false,
  activeConversationId: null,
  suppressAutoSelect: false,
  draftModelId: null,
  dialog: null,
  dialogTab: null,
  streaming: null,

  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setMobileSidebarOpen: (open) => set({ mobileSidebarOpen: open }),
  setActiveConversation: (id) => set({ activeConversationId: id, suppressAutoSelect: id === null }),
  setDraftModelId: (id) => set({ draftModelId: id }),
  openDialog: (kind, tab) => set({ dialog: kind, dialogTab: tab ?? null }),
  closeDialog: () => set({ dialog: null, dialogTab: null }),

  startStreaming: (state) =>
    set({
      streaming: {
        phase: 'connecting',
        assistantMessageId: `temp-${Date.now()}`,
        userMessageId: null,
        optimisticUserMessage: null,
        content: '',
        reasoning: '',
        sources: null,
        servedModel: null,
        error: null,
        modelId: '',
        ...state,
      },
    }),
  updateStreaming: (patch) =>
    set((s) => (s.streaming ? { streaming: { ...s.streaming, ...patch } } : {})),
  appendDelta: (content) =>
    set((s) => (s.streaming ? { streaming: { ...s.streaming, content: s.streaming.content + content } } : {})),
  appendReasoning: (content) =>
    set((s) => (s.streaming ? { streaming: { ...s.streaming, reasoning: s.streaming.reasoning + content } } : {})),
  stopStreaming: () => set({ streaming: null }),
}));

export function optimisticUserMessage(conversationId: string, content: string, attachments: MessageAttachment[]): SerializedMessage {
  return {
    id: `optimistic-${Date.now()}`,
    conversationId,
    role: 'user',
    content,
    modelId: null,
    servedModel: null,
    reasoning: null,
    webSearch: false,
    sources: null,
    attachments: attachments.length ? attachments : null,
    status: 'complete',
    errorText: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    latencyMs: null,
    createdAt: new Date().toISOString(),
  };
}
