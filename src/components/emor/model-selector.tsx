"use client";

import { ChevronDown, Check, Eye, Sparkles, Wrench, Braces, Settings2, CircleAlert, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { useModels } from '@/hooks/use-emor-queries';
import { useEmorStore } from '@/stores/emor-store';
import type { ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';

function CapabilityIcons({ model }: { model: ModelInfo }) {
  const caps = model.capabilities;
  return (
    <span className="flex items-center gap-1 text-muted-foreground" aria-hidden="true">
      {caps.reasoning && <Sparkles className="size-3" aria-label="reasoning" />}
      {caps.vision && <Eye className="size-3" aria-label="vision" />}
      {caps.tools && <Wrench className="size-3" aria-label="tools" />}
      {caps.json && <Braces className="size-3" aria-label="structured output" />}
    </span>
  );
}

export function ModelSelector({ selected, onSelect, compact }: { selected: ModelInfo | null; onSelect: (modelId: string) => void; compact?: boolean }) {
  const { data } = useModels();
  const openDialog = useEmorStore((s) => s.openDialog);
  const models = data?.models ?? [];
  const enabled = models.filter((m) => m.enabled);
  const disabled = models.filter((m) => !m.enabled);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn('h-8 max-w-56 gap-1.5 px-2.5 text-sm font-medium', compact && 'h-7 text-xs')}
          aria-label="Select model"
        >
          <span className="truncate">{selected?.displayName ?? 'Select model'}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80">
        <DropdownMenuLabel className="text-xs text-muted-foreground">Models — free tiers first</DropdownMenuLabel>
        {enabled.map((m) => (
          <DropdownMenuItem
            key={m.id}
            onClick={() => onSelect(m.modelId)}
            className={cn('flex-col items-start gap-1 py-2.5', selected?.modelId === m.modelId && 'bg-accent/60')}
          >
            <div className="flex w-full items-center gap-2">
              <span className="text-sm font-medium">{m.displayName}</span>
              {m.freeTier ? (
                <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal text-emerald-600 dark:text-emerald-400">
                  <Zap className="mr-0.5 size-2.5" /> Free
                </Badge>
              ) : (
                <Badge variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                  Plan
                </Badge>
              )}
              {m.lastStatus === 'error' && (
                <Badge variant="outline" className="h-4 gap-1 border-destructive/40 px-1.5 text-[10px] font-normal text-destructive">
                  <CircleAlert className="size-2.5" /> Issue
                </Badge>
              )}
              <span className="ml-auto flex items-center gap-2">
                <CapabilityIcons model={m} />
                {selected?.modelId === m.modelId && <Check className="size-3.5 text-primary" />}
              </span>
            </div>
            <span className="line-clamp-1 w-full text-xs text-muted-foreground">{m.description}</span>
          </DropdownMenuItem>
        ))}
        {disabled.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Disabled</DropdownMenuLabel>
            {disabled.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-2 py-1.5 opacity-50">
                <span className="text-sm">{m.displayName}</span>
                <span className="ml-auto text-[10px] text-muted-foreground">Disabled</span>
              </div>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => openDialog('settings', 'models')} className="gap-2 text-primary">
          <Settings2 className="size-3.5" /> Manage models
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
