'use client';

import { useState, useSyncExternalStore } from 'react';
import { Code2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { OverviewPanel } from './overview';
import { EndpointDocs } from './endpoint-docs';
import { Playground } from './playground';
import { UsagePanel } from './usage-panel';

type TabId = 'overview' | 'reference' | 'playground' | 'usage';

const TAB_IDS: TabId[] = ['overview', 'reference', 'playground', 'usage'];

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
 * Developer Hub — in-app docs + live playground for EmorAI's OpenAI-compatible
 * developer API. Self-contained: computes the base URL after mount and manages
 * its own data fetching / localStorage key vault.
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
            <Code2 className="size-4.5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-semibold leading-tight">Developer Hub</h1>
            <p className="truncate text-xs text-muted-foreground">
              OpenAI-compatible API — chat, images, speech and video, documented and runnable
              in-browser.
            </p>
          </div>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(toTabId(v))} className="mt-3">
          <div className="-mb-px overflow-x-auto">
            <TabsList className="h-9 w-full justify-start rounded-none border-b bg-transparent p-0">
              {(
                [
                  ['overview', 'Overview'],
                  ['reference', 'API Reference'],
                  ['playground', 'Playground'],
                  ['usage', 'Usage'],
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
        <div className={tab === 'reference' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <EndpointDocs origin={origin} />
        </div>
        <div className={tab === 'playground' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <Playground origin={origin} />
        </div>
        <div className={tab === 'usage' ? 'px-4 sm:px-6' : 'hidden px-4 sm:px-6'}>
          <UsagePanel active={tab === 'usage'} onNavigate={(t) => setTab(toTabId(t))} />
        </div>
      </main>
    </div>
  );
}

export default DeveloperHub;
