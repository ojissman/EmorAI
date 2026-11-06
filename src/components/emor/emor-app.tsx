"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useTheme } from 'next-themes';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  BarChart3,
  BookOpen,
  Bot,
  FileText,
  KeyRound,
  Menu,
  MessageSquare,
  MoreVertical,
  PanelLeft,
  Settings,
  Sun,
  Moon,
  MonitorSmartphone,
  Sparkles,
  Code2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sidebar, MobileSidebar } from './sidebar/sidebar';
import { ChatArea } from './chat/chat-area';
import { ModelSelector } from './model-selector';
import { SettingsDialog } from './dialogs/settings-dialog';
import { KeysDialog } from './dialogs/keys-dialog';
import { DocsDialog } from './dialogs/docs-dialog';
import { UsageDialog } from './dialogs/usage-dialog';
import { SummaryDialog } from './dialogs/summary-dialog';
import { MediaStudio } from './studio/media-studio';
import { AgentStudio } from './agents/agent-studio';
import { DeveloperHub } from './developer/developer-hub';
import { VoiceModeDialog } from './chat/voice-mode';
import { useEmorStore } from '@/stores/emor-store';
import { useConversations, useModels, useSettings } from '@/hooks/use-emor-queries';
import { api } from '@/lib/api-client';
import type { ModelInfo } from '@/lib/types';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 20_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}

function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  // Hydration-safe: the theme is only known on the client after mount.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  if (!mounted) {
    return (
      <span className="inline-flex size-8 items-center justify-center" aria-hidden="true" />
    );
  }
  const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : MonitorSmartphone;
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-8 w-8 p-0 text-muted-foreground"
      onClick={() => setTheme(next)}
      aria-label={`Switch theme to ${next}`}
      title={`Theme: ${theme} (click for ${next})`}
    >
      <Icon className="size-4" />
    </Button>
  );
}

type WorkspaceView = 'chat' | 'studio' | 'agents' | 'developer';

const VIEW_META: Record<WorkspaceView, { label: string; icon: typeof MessageSquare }> = {
  chat: { label: 'Chat', icon: MessageSquare },
  studio: { label: 'Studio', icon: Sparkles },
  agents: { label: 'Agents', icon: Bot },
  developer: { label: 'Developer', icon: Code2 },
};

function ViewSwitcher() {
  const view = useEmorStore((s) => s.view);
  const setView = useEmorStore((s) => s.setView);
  return (
    <div
      role="tablist"
      aria-label="Workspace views"
      className="hidden items-center gap-0.5 rounded-lg border bg-muted/40 p-0.5 md:flex"
    >
      {(Object.keys(VIEW_META) as WorkspaceView[]).map((v) => {
        const Icon = VIEW_META[v].icon;
        const active = view === v;
        return (
          <button
            key={v}
            role="tab"
            aria-selected={active}
            onClick={() => setView(v)}
            className={`flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors ${
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="size-3.5" />
            {VIEW_META[v].label}
          </button>
        );
      })}
    </div>
  );
}

function DashboardHeader({
  title,
  selectedModel,
  onModelChange,
  onOpenMobileSidebar,
  view,
}: {
  title: string;
  selectedModel: ModelInfo | null;
  onModelChange: (id: string) => void;
  onOpenMobileSidebar: () => void;
  view: WorkspaceView;
}) {
  const openDialog = useEmorStore((s) => s.openDialog);
  const toggleSidebar = useEmorStore((s) => s.toggleSidebar);
  const activeId = useEmorStore((s) => s.activeConversationId);

  const summarize = async () => {
    if (!activeId) {
      toast.error('Open a conversation first.');
      return;
    }
    openDialog('summary');
  };

  return (
    <header className="flex h-13 shrink-0 items-center gap-1.5 border-b bg-background/80 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 md:hidden" onClick={onOpenMobileSidebar} aria-label="Open sidebar">
        <Menu className="size-4" />
      </Button>
      <Button variant="ghost" size="sm" className="hidden h-8 w-8 p-0 text-muted-foreground md:flex" onClick={toggleSidebar} aria-label="Toggle sidebar">
        <PanelLeft className="size-4" />
      </Button>
      <ViewSwitcher />
      {view === 'chat' && <ModelSelector selected={selectedModel} onSelect={onModelChange} />}
      <span className="hidden min-w-0 flex-1 truncate px-2 text-sm text-muted-foreground sm:block">{title}</span>
      <span className="flex-1 sm:hidden" />
      <VoiceModeDialog conversationId={activeId} model={selectedModel} />
      <ThemeToggleButton />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" aria-label="More options">
            <MoreVertical className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuSeparator className="md:hidden" />
          <div className="grid grid-cols-2 gap-1 p-1 md:hidden">
            {(Object.keys(VIEW_META) as WorkspaceView[]).map((v) => {
              const Icon = VIEW_META[v].icon;
              return (
                <DropdownMenuItem key={v} onClick={() => useEmorStore.getState().setView(v)}>
                  <Icon className="size-3.5" /> {VIEW_META[v].label}
                </DropdownMenuItem>
              );
            })}
          </div>
          <DropdownMenuSeparator className="md:hidden" />
          <DropdownMenuItem onClick={() => openDialog('keys')}>
            <KeyRound className="size-3.5" /> API keys
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog('docs')}>
            <BookOpen className="size-3.5" /> API documentation
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog('usage')}>
            <BarChart3 className="size-3.5" /> Usage
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void summarize()} disabled={!activeId}>
            <FileText className="size-3.5" /> Summarize conversation
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => openDialog('settings', 'general')}>
            <Settings className="size-3.5" /> Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}

export function EmorApp() {
  const [queryClient] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <EmorDashboard />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function EmorDashboard() {
  const queryClient = useQueryClient();
  const activeConversationId = useEmorStore((s) => s.activeConversationId);
  const suppressAutoSelect = useEmorStore((s) => s.suppressAutoSelect);
  const setActiveConversation = useEmorStore((s) => s.setActiveConversation);
  const setMobileSidebarOpen = useEmorStore((s) => s.setMobileSidebarOpen);
  const draftModelId = useEmorStore((s) => s.draftModelId);
  const setDraftModelId = useEmorStore((s) => s.setDraftModelId);

  const { data: convList } = useConversations('');
  const { data: settingsData } = useSettings();
  const { data: modelsData } = useModels();

  // Conversation detail (title/model/pinned) — reuse messages query conversation meta via list.
  const activeConversation = (convList?.conversations ?? []).find((c) => c.id === activeConversationId) ?? null;

  // Resolve the active model: conversation override > draft > settings default.
  const settings = settingsData?.settings;
  const models = modelsData?.models ?? [];
  const effectiveModelId =
    draftModelId ??
    activeConversation?.modelId ??
    settings?.defaultModelId ??
    'glm-5.3-flash';
  const activeModel = models.find((m) => m.modelId === effectiveModelId && m.enabled) ?? models.find((m) => m.enabled) ?? null;

  // Select the most recent conversation on first load only (never when the
  // user explicitly started a new chat).
  useEffect(() => {
    if (!activeConversationId && !suppressAutoSelect && convList?.conversations?.length) {
      setActiveConversation(convList.conversations[0].id);
    }
  }, [activeConversationId, suppressAutoSelect, convList, setActiveConversation]);

  const changeModel = (modelId: string) => {
    setDraftModelId(modelId);
    if (activeConversationId) {
      void api
        .patch(`/api/conversations/${activeConversationId}`, { modelId })
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        })
        .catch((e) => toast.error(String((e as Error).message)));
    }
  };

  const title = activeConversation?.title ?? 'New chat';
  const view = useEmorStore((s) => s.view);
  const viewTitle =
    view === 'studio'
      ? 'Media Studio — images, video, speech & documents'
      : view === 'agents'
        ? 'Agent Studio — describe it, the agent builds it'
        : view === 'developer'
          ? 'Developer Hub — build on the EmorAI API'
          : title;

  return (
    <>
      <div className="flex h-dvh overflow-hidden bg-background">
        <Sidebar />
        <MobileSidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <DashboardHeader
            title={viewTitle}
            selectedModel={activeModel}
            onModelChange={changeModel}
            onOpenMobileSidebar={() => setMobileSidebarOpen(true)}
            view={view}
          />
          {view === 'chat' && (
            <ChatArea
              activeConversationId={activeConversationId}
              activeModel={activeModel}
              onModelMissing={() => useEmorStore.getState().openDialog('settings', 'models')}
            />
          )}
          {view === 'studio' && <MediaStudio />}
          {view === 'agents' && <AgentStudio />}
          {view === 'developer' && <DeveloperHub />}
        </main>
      </div>

      <SettingsDialog />
      <KeysDialog />
      <DocsDialog />
      <UsageDialog />
      <SummaryDialog conversationId={activeConversationId} />
    </>
  );
}
