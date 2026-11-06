"use client";

// Shared metadata + tiny formatting helpers for the Agent Studio.

import {
  AppWindow,
  FileAudio,
  FileText,
  FileVideo,
  Globe,
  Image as ImageIcon,
  PenLine,
  Rocket,
  Sparkles,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AgentTemplate } from '@/lib/types';

export type TemplateMeta = {
  id: AgentTemplate;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const TEMPLATES: TemplateMeta[] = [
  {
    id: 'website',
    label: 'Website',
    description: 'Multi-page marketing site — index, about, contact + styles',
    icon: Globe,
  },
  {
    id: 'landing',
    label: 'Landing page',
    description: 'Single high-converting landing page',
    icon: Rocket,
  },
  {
    id: 'webapp',
    label: 'Web app',
    description: 'Working client-side app with localStorage persistence',
    icon: AppWindow,
  },
  {
    id: 'blog',
    label: 'Blog',
    description: 'Static blog with three full articles',
    icon: PenLine,
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Anything you can describe',
    icon: Sparkles,
  },
];

export const KIND_META: Record<string, { icon: LucideIcon; label: string }> = {
  website: { icon: Globe, label: 'Website' },
  webapp: { icon: AppWindow, label: 'Web app' },
  blog: { icon: PenLine, label: 'Blog' },
  landing: { icon: Rocket, label: 'Landing page' },
  custom: { icon: Sparkles, label: 'Custom' },
  document: { icon: FileText, label: 'Document' },
  image: { icon: ImageIcon, label: 'Image' },
  video: { icon: FileVideo, label: 'Video' },
  audio: { icon: FileAudio, label: 'Audio' },
};

export function kindMeta(kind: string): { icon: LucideIcon; label: string } {
  return KIND_META[kind] ?? { icon: FileText, label: 'Project' };
}

const TEXT_ENCODER = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

/** Approximate byte size of a string (UTF-8). */
export function byteSize(content: string): number {
  if (TEXT_ENCODER) return TEXT_ENCODER.encode(content).length;
  return content.length;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
