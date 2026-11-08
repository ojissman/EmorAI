'use client';

import { useState, useSyncExternalStore } from 'react';
import { Plug } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OverviewPanel } from './overview';
import { EndpointDocs } from './endpoint-docs';
import { Playground } from './playground';
import { UsagePanel } from './usage-panel';
import { AgentGuides } from './agent-guides';
import { RequestLogs } from './request-logs';

type TabId = 'overview' | 'integrations' | 'reference' | 'playground' | 'usage';

const TAB_IDS: TabId[] = ['overview', 'integrations', 'reference', 'playground', 'usage'];

function toTabId(value: string): TabId {
  return (TAB_IDS as string[]).includes(value) ? (value as TabId) : 'overview';
}

// window.location.origin, exposed hydration-safely without setState-in-effect.
function subscribeOrigin(_onChange: () => void): () => void {
  return () => undefined; // origin never changes during a session
}

function getOriginSnapshot(): string {
  return window.location.origin;
}

function getOriginServerSnapshot(): string {
  return '';
}

/**
 * EMORAI API & INTEGRATIONS — the universal AI provider control room.
 * OpenAI-compatible + Anthropic-compatible gateway docs, key management, live
 * playground, agent integration guides (ZCode, Claude Code, OpenClaw) and
 * request logs.
 */
export function DeveloperHub() {
  const [tab, setTab] = useState<TabId>('overview');
  // Resolved on the client only (server snapshot '') to avoid hydration mismatch.
  const origin = useSyncExternalStore(
    subscribeOrigin,
    getOriginSnapshot,
    getOriginServerSnapshot
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <header className="shrink-0 border-b bg-background/95 px-4 pb-0 pt-4 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
            <Plug className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">EmorAI API &amp; Integrations</h1>
            <p className="truncate text-xs text-muted-foreground">
              Universal AI provider gateway — OpenAI-compatible, Anthropic-compatible, ready for
              ZCode, Claude Code, OpenClaw and any coding agent.
            </p>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(toTabId(v))} className="mt-3">
          <div className="-mb-px overflow-x-auto">
            <TabsList className="h-9 w-full justify-start rounded-none border-b bg-transparent p-0">
              {(
                [
                  ['overview', 'Overview'],
                  ['integrations', 'Integrations'],
                  ['reference', 'API Reference'],
                  ['playground', 'Playground'],
                  ['usage', 'Usage & Logs'],
                ] as [TabId, string][]
              ).map(([id, label]) => (
                <TabsTrigger
                  key={id}
                  value={id}
                  className="h-9 rounded-none border-0 border-b-2 border-transparent px-4 text-sm data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>
        </Tabs>
      </header>

      {/* Content scrolls; panels stay mounted (except usage) so playground state survives tab switches. */}
      <main className="flex-1 overflow-y-auto pb-8 pt-4">
        <div className={tab === 'overview' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <OverviewPanel origin={origin} onNavigate={(t) => setTab(toTabId(t))} />
        </div>
        <div className={tab === 'integrations' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <AgentGuides origin={origin} />
        </div>
        <div className={tab === 'reference' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <EndpointDocs origin={origin} />
        </div>
        <div className={tab === 'playground' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <Playground origin={origin} />
        </div>
        <div className={tab === 'usage' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <UsagePanel active={tab === 'usage'} onNavigate={(t) => setTab(toTabId(t))} />
          <div className="mt-4 px-0 sm:px-0">
            <RequestLogs active={tab === 'usage'} />
          </div>
        </div>
      </main>
    </div>
  );
}

export default DeveloperHub;
