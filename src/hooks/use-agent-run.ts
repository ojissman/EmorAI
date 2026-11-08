"use client";

import { useCallback, useRef, useState } from 'react';
import type { AgentPlan, AgentRunEvent, AgentStep, SerializedArtifact } from '@/lib/types';

export type AgentRunState = {
  running: boolean;
  steps: AgentStep[];
  plan: AgentPlan | null;
  files: { path: string; content: string; done: boolean }[];
  artifact: SerializedArtifact | null;
  error: string | null;
};

const INITIAL: AgentRunState = {
  running: false,
  steps: [],
  plan: null,
  files: [],
  artifact: null,
  error: null,
};

/**
 * Runs the EmorAI build agent and consumes its SSE stream into UI state.
 * Events mirror /api/agent/run exactly.
 */
export function useAgentRun() {
  const [state, setState] = useState<AgentRunState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState((s) => ({ ...s, running: false }));
  }, []);

  const run = useCallback(
    async (args: { template: string; brief: string; modelId?: string }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setState({ ...INITIAL, running: true });

      try {
        const res = await fetch('/api/agent/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(args),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          let message = `Agent request failed (${res.status})`;
          try {
            const body = (await res.json()) as { error?: { message?: string } };
            if (body?.error?.message) message = body.error.message;
          } catch {
            // non-JSON
          }
          setState((s) => ({ ...s, running: false, error: message }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const apply = (event: AgentRunEvent) => {
          switch (event.type) {
            case 'step':
              setState((s) => {
                const steps = [...s.steps];
                const idx = steps.findIndex((x) => x.id === event.step.id);
                if (idx >= 0) steps[idx] = event.step;
                else steps.push(event.step);
                return { ...s, steps };
              });
              break;
            case 'plan':
              setState((s) => ({ ...s, plan: event.plan }));
              break;
            case 'file-start':
              setState((s) => ({
                ...s,
                files: [...s.files, { path: event.path, content: '', done: false }],
              }));
              break;
            case 'file-delta':
              setState((s) => {
                const files = [...s.files];
                for (let i = files.length - 1; i >= 0; i--) {
                  if (files[i].path === event.path && !files[i].done) {
                    files[i] = { ...files[i], content: files[i].content + event.delta };
                    break;
                  }
                }
                return { ...s, files };
              });
              break;
            case 'file-done':
              setState((s) => ({
                ...s,
                files: s.files.map((f) => (f.path === event.path ? { ...f, done: true } : f)),
              }));
              break;
            case 'artifact':
              setState((s) => ({ ...s, artifact: event.artifact }));
              break;
            case 'error':
              setState((s) => ({ ...s, error: event.message }));
              break;
            case 'done':
              setState((s) => ({ ...s, running: false }));
              break;
          }
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            if (payload === '[DONE]') {
              setState((s) => ({ ...s, running: false }));
              continue;
            }
            try {
              apply(JSON.parse(payload) as AgentRunEvent);
            } catch {
              // skip malformed frame
            }
          }
        }
        setState((s) => ({ ...s, running: false }));
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        setState((s) => ({ ...s, running: false, error: (e as Error).message }));
      } finally {
        abortRef.current = null;
      }
    },
    []
  );

  return { state, run, stop };
}
