'use client';

import { useState } from 'react';
import { AudioLines, Clapperboard, FileText, Image as ImageIcon, WandSparkles } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ImagePanel } from './image-panel';
import { VideoPanel } from './video-panel';
import { AudioPanel } from './audio-panel';
import { DocumentPanel } from './document-panel';

type StudioTab = 'images' | 'video' | 'speech' | 'documents';

const TABS: { value: StudioTab; label: string; icon: typeof ImageIcon }[] = [
  { value: 'images', label: 'Images', icon: ImageIcon },
  { value: 'video', label: 'Video', icon: Clapperboard },
  { value: 'speech', label: 'Speech', icon: AudioLines },
  { value: 'documents', label: 'Docs', icon: FileText },
];

/**
 * Full-height Media Studio view: four generation tabs over a shared artifact
 * library. The parent renders it inside the main content column.
 */
export function MediaStudio() {
  const [tab, setTab] = useState<StudioTab>('images');

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="shrink-0 border-b bg-background/80 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:px-6">
        <div className="mx-auto flex w-full max-w-5xl items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <WandSparkles className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold leading-tight">Media Studio</h1>
            <p className="truncate text-xs text-muted-foreground">
              Generate images, video, speech and documents — every result is saved to your library.
            </p>
          </div>
        </div>
      </header>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as StudioTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="shrink-0 px-4 pt-3 sm:px-6">
          <TabsList className="h-10 w-full sm:w-auto">
            {TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value} className="flex-1 px-2.5 sm:flex-none sm:px-3">
                <t.icon className="size-4" aria-hidden="true" />
                <span className="text-xs sm:text-sm">{t.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        </div>

        <TabsContent value="images" className="emor-scroll mt-0 min-h-0 flex-1 overflow-y-auto pb-8">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
            <ImagePanel />
          </div>
        </TabsContent>

        <TabsContent value="video" className="emor-scroll mt-0 min-h-0 flex-1 overflow-y-auto pb-8">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
            <VideoPanel />
          </div>
        </TabsContent>

        <TabsContent value="speech" className="emor-scroll mt-0 min-h-0 flex-1 overflow-y-auto pb-8">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
            <AudioPanel />
          </div>
        </TabsContent>

        <TabsContent value="documents" className="emor-scroll mt-0 min-h-0 flex-1 overflow-y-auto pb-8">
          <div className="mx-auto w-full max-w-5xl px-4 py-4 sm:px-6">
            <DocumentPanel />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default MediaStudio;
