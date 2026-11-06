"use client";

import { Code2, FileSearch, Globe, Lightbulb, PenLine } from 'lucide-react';
import { EmorLogo, EmorWordmark } from '../logo';

const SUGGESTIONS = [
  {
    icon: Lightbulb,
    title: 'Brainstorm ideas',
    prompt: 'Help me brainstorm 10 creative names for a coffee subscription startup, with a one-line pitch for each.',
  },
  {
    icon: Code2,
    title: 'Write & debug code',
    prompt: 'Write a Python function that finds the longest palindromic substring, with tests and complexity analysis.',
  },
  {
    icon: Globe,
    title: 'Research with web search',
    prompt: 'What are the most significant AI model releases this year? Use web search and cite sources.',
  },
  {
    icon: FileSearch,
    title: 'Analyze documents',
    prompt: 'I will upload a PDF. Summarize the key points, risks, and action items.',
  },
];

export function EmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10">
      <div className="flex flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl border bg-card shadow-sm">
          <EmorLogo size={34} />
        </div>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          <EmorWordmark />
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Intelligence Without Limits.</p>
      </div>
      <div className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s.title}
            onClick={() => onPick(s.prompt)}
            className="group rounded-xl border bg-card p-3.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <s.icon className="size-4 text-primary" />
              {s.title}
            </div>
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{s.prompt}</p>
          </button>
        ))}
      </div>
    </div>
  );
}
