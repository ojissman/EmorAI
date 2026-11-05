"use client";

import { useMemo, useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  Folder as FolderIcon,
  FolderPlus,
  ListEnd,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Settings,
  KeyRound,
  Trash2,
  BarChart3,
  BookOpen,
  Sun,
  Moon,
  MonitorSmartphone,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api-client';
import { useConversations, useFolders } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';
import { EmorLogo, EmorWordmark } from '../logo';
import type { SerializedConversation } from '@/lib/types';
import { cn } from '@/lib/utils';

function ConversationRow({
  conversation,
  active,
  folders,
  onSwitch,
  compact,
}: {
  conversation: SerializedConversation;
  active: boolean;
  folders: { id: string; name: string }[];
  onSwitch: (id: string) => void;
  compact?: boolean;
}) {
  const qc = useFoldersQC();
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(conversation.title);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const patch = async (data: Record<string, unknown>, successMsg?: string) => {
    try {
      await api.patch(`/api/conversations/${conversation.id}`, data);
      qc();
      if (successMsg) toast.success(successMsg);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const remove = async () => {
    try {
      await api.del(`/api/conversations/${conversation.id}`);
      qc();
      toast.success('Conversation deleted');
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const commitRename = () => {
    const name = draftName.trim();
    setRenaming(false);
    if (name && name !== conversation.title) void patch({ title: name }, 'Conversation renamed');
  };

  if (renaming) {
    return (
      <div className="px-1 py-0.5">
        <Input
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') setRenaming(false);
          }}
          onBlur={commitRename}
          autoFocus
          className="h-8 text-sm"
          aria-label="Rename conversation"
        />
      </div>
    );
  }

  return (
    <>
      <div
        className={cn(
          'group relative flex items-center rounded-lg transition-colors',
          active ? 'bg-accent text-accent-foreground' : 'hover:bg-sidebar-accent/70',
          compact ? 'mx-auto w-9 justify-center' : 'pr-1'
        )}
      >
        <button
          onClick={() => onSwitch(conversation.id)}
          className={cn('flex min-w-0 flex-1 items-center gap-2 text-left', compact ? 'p-2' : 'py-2 pl-2.5')}
          aria-current={active ? 'page' : undefined}
        >
          {conversation.pinned ? (
            <Pin className="size-3.5 shrink-0 text-primary" />
          ) : (
            <MessageSquare className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className={cn('truncate text-sm', compact && 'hidden')}>{conversation.title}</span>
        </button>
        {!compact && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 shrink-0 p-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                aria-label={`Actions for ${conversation.title}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-48">
              <DropdownMenuItem onClick={() => void patch({ pinned: !conversation.pinned }, conversation.pinned ? 'Unpinned' : 'Pinned')}>
                {conversation.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
                {conversation.pinned ? 'Unpin' : 'Pin'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <Pencil className="size-3.5" /> Rename
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <FolderIcon className="mr-1.5 size-3.5" /> Move to folder
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-44">
                  <DropdownMenuItem onClick={() => void patch({ folderId: null }, 'Moved out of folder')}>
                    <ListEnd className="size-3.5" /> No folder
                  </DropdownMenuItem>
                  {folders.map((f) => (
                    <DropdownMenuItem key={f.id} onClick={() => void patch({ folderId: f.id }, `Moved to ${f.name}`)}>
                      <FolderIcon className="size-3.5" /> {f.name}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="size-3.5" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete conversation?</AlertDialogTitle>
              <AlertDialogDescription>
                “{conversation.title}” and all of its messages will be permanently removed.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="bg-destructive text-white hover:bg-destructive/90"
                onClick={() => void remove()}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  );
}

function useFoldersQC() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['folders'] });
    void qc.invalidateQueries({ queryKey: ['conversations'] });
  };
}

function FolderRow({
  id,
  name,
  conversations,
  activeId,
  onSwitch,
  compact,
}: {
  id: string;
  name: string;
  conversations: SerializedConversation[];
  activeId: string | null;
  onSwitch: (id: string) => void;
  compact?: boolean;
}) {
  const qc = useFoldersQC();
  const [open, setOpen] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(name);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (compact) {
    return (
      <div className="mx-auto flex w-9 items-center justify-center py-1" title={name}>
        <FolderIcon className="size-4 text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mt-1">
      <div className="group flex items-center rounded-lg hover:bg-sidebar-accent/70">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pl-2.5 text-left"
          aria-expanded={open}
        >
          <ChevronDown className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
          <FolderIcon className="size-3.5 shrink-0 text-primary/80" />
          <span className="truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">{name}</span>
          <span className="text-[10px] text-muted-foreground/70">({conversations.length})</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 shrink-0 p-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
              aria-label={`Folder actions for ${name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <Pencil className="size-3.5" /> Rename folder
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 className="size-3.5" /> Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {renaming && (
        <div className="px-1 py-1">
          <Input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === 'Enter') {
                const n = draftName.trim();
                setRenaming(false);
                if (n && n !== name) {
                  try {
                    await api.patch(`/api/folders/${id}`, { name: n });
                    qc();
                    toast.success('Folder renamed');
                  } catch (err) {
                    toast.error(String((err as Error).message));
                  }
                }
              }
              if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={async () => {
              const n = draftName.trim();
              setRenaming(false);
              if (n && n !== name) {
                try {
                  await api.patch(`/api/folders/${id}`, { name: n });
                  qc();
                  toast.success('Folder renamed');
                } catch (err) {
                  toast.error(String((err as Error).message));
                }
              }
            }}
            autoFocus
            className="h-8 text-sm"
            aria-label="Rename folder"
          />
        </div>
      )}
      {open && (
        <div className="ml-4 border-l pl-1">
          {conversations.length === 0 && <p className="px-2.5 py-1.5 text-xs text-muted-foreground/70">Empty folder</p>}
          {conversations.map((c) => (
            <ConversationRow key={c.id} conversation={c} active={c.id === activeId} folders={[]} onSwitch={onSwitch} />
          ))}
        </div>
      )}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete folder?</AlertDialogTitle>
            <AlertDialogDescription>
              “{name}” will be removed. Conversations inside are kept and moved out of the folder.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={async () => {
                try {
                  await api.del(`/api/folders/${id}`);
                  qc();
                  toast.success('Folder deleted');
                } catch (e) {
                  toast.error(String((e as Error).message));
                }
              }}
            >
              Delete folder
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ThemeToggleItem() {
  const { theme, setTheme } = useTheme();
  // Hydration-safe: theme is only known after mount (sidebar also SSRs).
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false
  );
  if (!mounted) {
    return (
      <div className="px-2 py-1.5 text-sm text-muted-foreground" role="status">
        Theme: …
      </div>
    );
  }
  const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const Icon = theme === 'dark' ? Moon : theme === 'light' ? Sun : MonitorSmartphone;
  return (
    <DropdownMenuItem onClick={() => setTheme(next)}>
      <Icon className="size-3.5" />
      Theme: {theme === 'dark' ? 'Dark' : theme === 'light' ? 'Light' : 'System'} → {next === 'dark' ? 'Dark' : next === 'light' ? 'Light' : 'System'}
    </DropdownMenuItem>
  );
}

export function SidebarContent({ compact }: { compact?: boolean }) {
  const [search, setSearch] = useState('');
  const activeConversationId = useEmorStore((s) => s.activeConversationId);
  const setActiveConversation = useEmorStore((s) => s.setActiveConversation);
  const setMobileSidebarOpen = useEmorStore((s) => s.setMobileSidebarOpen);
  const openDialog = useEmorStore((s) => s.openDialog);
  const { data: convData } = useConversations(search);
  const { data: folderData } = useFolders();
  const conversations = convData?.conversations ?? [];
  const folders = folderData?.folders ?? [];

  const { pinned, unpinned, byFolder } = useMemo(() => {
    const pinned2: SerializedConversation[] = [];
    const unpinned2: SerializedConversation[] = [];
    const byFolder2 = new Map<string, SerializedConversation[]>();
    for (const c of conversations) {
      if (c.pinned) pinned2.push(c);
      else if (c.folderId) {
        const arr = byFolder2.get(c.folderId) ?? [];
        arr.push(c);
        byFolder2.set(c.folderId, arr);
      } else unpinned2.push(c);
    }
    return { pinned: pinned2, unpinned: unpinned2, byFolder: byFolder2 };
  }, [conversations]);

  const createFolder = async () => {
    try {
      const res = await api.post<{ folder: { id: string; name: string } }>('/api/folders', { name: 'New folder' });
      refetchFolders();
      toast.success(`Folder “${res.folder.name}” created`);
    } catch (e) {
      toast.error(String((e as Error).message));
    }
  };

  const refetchFolders = useFoldersQC();

  const switchTo = (id: string) => {
    setActiveConversation(id);
    setMobileSidebarOpen(false);
  };

  const newChat = () => {
    setActiveConversation(null);
    setMobileSidebarOpen(false);
  };

  const openSettings = (tab?: string) => {
    openDialog('settings', tab);
    setMobileSidebarOpen(false);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className={cn('flex items-center gap-2 px-3 pt-3', compact && 'flex-col px-2')}>
        <div className={cn('flex items-center gap-2', compact && 'justify-center')}>
          <EmorLogo size={compact ? 26 : 24} />
          {!compact && <EmorWordmark className="text-[15px]" />}
        </div>
      </div>

      {/* New chat */}
      <div className={cn('px-3 pt-3', compact && 'px-2')}>
        <Button
          onClick={newChat}
          className={cn('w-full gap-2', compact ? 'h-9 w-9 px-0' : 'justify-start')}
          aria-label="New chat"
        >
          <Plus className="size-4" />
          {!compact && 'New chat'}
        </Button>
      </div>

      {/* Search */}
      {!compact && (
        <div className="relative px-3 pt-2.5">
          <Search className="pointer-events-none absolute left-6 top-1/2 size-3.5 -translate-y-1/4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search chats…"
            className="h-8 pl-8 text-sm"
            aria-label="Search conversations"
          />
        </div>
      )}

      {/* Lists */}
      <div className="emor-scroll mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {compact ? (
          <>
            {pinned.slice(0, 5).map((c) => (
              <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} folders={[]} onSwitch={switchTo} compact />
            ))}
            {folders.map((f) => (
              <FolderRow key={f.id} id={f.id} name={f.name} conversations={byFolder.get(f.id) ?? []} activeId={activeConversationId} onSwitch={switchTo} compact />
            ))}
            {unpinned.slice(0, 8).map((c) => (
              <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} folders={[]} onSwitch={switchTo} compact />
            ))}
          </>
        ) : (
          <>
            {search === '' && (
              <>
                <div className="mt-1 flex items-center justify-between px-2.5 pb-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Projects</span>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground" onClick={() => void createFolder()} aria-label="New folder">
                    <FolderPlus className="size-3.5" />
                  </Button>
                </div>
                {folders.map((f) => (
                  <FolderRow key={f.id} id={f.id} name={f.name} conversations={byFolder.get(f.id) ?? []} activeId={activeConversationId} onSwitch={switchTo} />
                ))}
              </>
            )}

            {pinned.length > 0 && (
              <>
                <p className="mt-3 px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Pinned</p>
                {pinned.map((c) => (
                  <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} folders={folders} onSwitch={switchTo} />
                ))}
              </>
            )}

            <p className="mt-3 px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Chats</p>
            {unpinned.length === 0 && pinned.length === 0 && folders.length === 0 && (
              <p className="px-2.5 py-3 text-xs text-muted-foreground">
                {search ? 'No conversations match your search.' : 'No conversations yet. Start a new chat!'}
              </p>
            )}
            {unpinned.map((c) => (
              <ConversationRow key={c.id} conversation={c} active={c.id === activeConversationId} folders={folders} onSwitch={switchTo} />
            ))}
          </>
        )}
      </div>

      {/* Footer */}
      <div className={cn('border-t p-2', compact && 'px-1.5')}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className={cn('w-full gap-2 text-muted-foreground', compact ? 'h-9 w-9 px-0' : 'justify-start')} aria-label="Open menu">
              <MoreHorizontal className="size-4" />
              {!compact && <span className="text-sm">More</span>}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side={compact ? 'right' : 'top'} align="start" className="w-52">
            <DropdownMenuItem onClick={() => openSettings('general')}>
              <Settings className="size-3.5" /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openDialog('keys')}>
              <KeyRound className="size-3.5" /> API keys
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openDialog('docs')}>
              <BookOpen className="size-3.5" /> API documentation
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openDialog('usage')}>
              <BarChart3 className="size-3.5" /> Usage
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <ThemeToggleItem />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

/** Collapsible desktop sidebar (icon rail when collapsed). */
export function Sidebar() {
  const sidebarOpen = useEmorStore((s) => s.sidebarOpen);
  return (
    <aside
      className={cn(
        'hidden shrink-0 border-r bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:block',
        sidebarOpen ? 'w-72' : 'w-[68px]'
      )}
      aria-label="Sidebar"
    >
      {sidebarOpen ? <SidebarContent /> : <SidebarContent compact />}
    </aside>
  );
}

/** Mobile drawer. */
export function MobileSidebar() {
  const open = useEmorStore((s) => s.mobileSidebarOpen);
  const setOpen = useEmorStore((s) => s.setMobileSidebarOpen);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="left" className="w-80 border-r bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden">
        <SheetHeader className="sr-only">
          <SheetTitle>Conversations</SheetTitle>
          <SheetDescription>Your EmorAI conversation list</SheetDescription>
        </SheetHeader>
        <SidebarContent />
      </SheetContent>
    </Sheet>
  );
}
