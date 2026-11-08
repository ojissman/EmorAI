"use client";

import { useCallback, useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { api } from '@/lib/api-client';
import { useEmorStore } from '@/stores/emor-store';
import { Markdown } from '../chat/markdown';

export function SummaryDialog({ conversationId }: { conversationId: string | null }) {
  const dialog = useEmorStore((s) => s.dialog);
  const closeDialog = useEmorStore((s) => s.closeDialog);
  const open = dialog === 'summary';
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [requestedFor, setRequestedFor] = useState<string | null>(null);

  const run = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setSummary(null);
    try {
      const res = await api.post<{ summary: string }>(`/api/conversations/${id}/summary`);
      setSummary(res.summary);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open && conversationId && requestedFor !== conversationId) {
      setRequestedFor(conversationId);
      void run(conversationId);
    }
  }, [open, conversationId, requestedFor, run]);

  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setRequestedFor(null);
      setSummary(null);
      setError(null);
      setLoading(false);
      closeDialog();
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="border-b px-5 pb-4 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <FileText className="size-4 text-primary" /> Conversation summary
          </DialogTitle>
          <DialogDescription>Generated with the conversation&apos;s model — a brief of key facts, decisions and open questions.</DialogDescription>
        </DialogHeader>
        <div className="emor-scroll overflow-y-auto px-5 py-4" style={{ maxHeight: '58vh' }}>
          {loading && (
            <p className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Summarizing…
            </p>
          )}
          {!loading && error && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
          )}
          {!loading && !error && summary && <Markdown content={summary} />}
          {!loading && !error && !summary && <p className="py-8 text-center text-sm text-muted-foreground">Preparing…</p>}
          {summary && !error && (
            <button
              className="mt-4 text-xs text-primary underline underline-offset-2"
              onClick={() => {
                void navigator.clipboard.writeText(summary).then(() => toast.success('Summary copied'));
              }}
            >
              Copy summary
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
