'use client';

import dynamic from 'next/dynamic';
import { EmorLogo } from '@/components/emor/logo';

// The dashboard is rendered client-only. React's useId (used by every Radix
// dropdown/dialog trigger) currently produces different values during SSR and
// hydration for trees that cross the RSC boundary with Radix providers, which
// triggers persistent hydration-mismatch warnings on all trigger buttons.
// Rendering client-only removes that entire bug class; this app is a personal,
// auth-less dashboard where SSR/SEO provides no benefit.
const EmorApp = dynamic(
  () => import('@/components/emor/emor-app').then((mod) => ({ default: mod.EmorApp })),
  {
    ssr: false,
    loading: () => <EmorLoadingShell />,
  }
);

function EmorLoadingShell() {
  return (
    <div className="flex h-dvh overflow-hidden bg-background" aria-busy="true">
      <aside className="hidden w-72 shrink-0 border-r bg-sidebar md:block" aria-hidden="true" />
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="h-13 shrink-0 border-b bg-background/80" aria-hidden="true" />
        <div className="flex flex-1 items-center justify-center">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <EmorLogo size={36} className="animate-pulse" />
            <p className="text-sm">Loading EmorAI…</p>
          </div>
        </div>
      </main>
    </div>
  );
}

export default function Home() {
  return <EmorApp />;
}
