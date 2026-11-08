import { z } from 'zod';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { getModelInfoByModelId, listEnabledModels } from '@/lib/model-registry';
import { rateLimit } from '@/lib/rate-limit';
import { fail } from '@/lib/api/response';
import { SSE_HEADERS, sseDone, sseEvent } from '@/lib/ai/sse';
import { completeChat, streamChat } from '@/lib/ai/zai-adapter';
import { serializeArtifact, parseArtifactFiles } from '@/lib/artifacts';
import type { AgentPlan, AgentRunEvent, AgentStep, ArtifactFile } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 600;

const schema = z.object({
  template: z.enum(['website', 'webapp', 'blog', 'landing', 'custom']),
  brief: z.string().min(10).max(8000),
  modelId: z.string().min(1).max(120).optional(),
});

function ipOf(req: Request): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    'local'
  );
}

// ─── Prompting ───────────────────────────────────────────────────────────────

const SHARED_RULES = `
Hard requirements:
- Vanilla HTML, CSS and JavaScript only. NO frameworks, NO external CDNs, NO network requests — every site must work fully offline from the file system.
- Fully responsive (mobile-first), polished modern design, accessible (semantic HTML, aria labels, focus styles).
- Shared styling lives in styles.css; scripts in script.js when the site has more than one page.
- All relative links between files must be correct so the folder works when served statically.
- Write production-quality, complete code — never placeholders, never TODOs, never truncated files.`;

const TEMPLATE_BRIEFS: Record<string, string> = {
  website: `Build a complete multi-page marketing/business website. Typical structure:
<<<FILE: index.html>>> home page with hero, features, about, contact sections and a working nav <<<END>>>
<<<FILE: about.html>>> about page <<<END>>>
<<<FILE: services.html>>> (only if relevant) products or services page <<<END>>>
<<<FILE: contact.html>>> contact page with a (client-side only) form that shows a success message <<<END>>>
<<<FILE: styles.css>>> the full shared stylesheet <<<END>>>
<<<FILE: script.js>>> shared JS: mobile nav toggle, scroll effects, form handling, dynamic year <<<END>>>`,
  landing: `Build a single high-converting landing page (one file only):
<<<FILE: index.html>>> complete landing page: hero with a strong value proposition, social proof, feature grid, testimonials, pricing, FAQ (accordion), final CTA — all CSS/JS inline in the file <<<END>>>`,
  webapp: `Build a genuinely useful client-side web application as a single file:
<<<FILE: index.html>>> a fully working app with all CSS/JS inline. State must persist in localStorage. It must actually work: every button and interaction wired up, sensible empty states, keyboard support. Pick solid, useful features for the requested app <<<END>>>`,
  blog: `Build a complete static blog with real, substantive content:
<<<FILE: index.html>>> blog home: header, featured post, post card grid, about blurb, footer <<<END>>>
<<<FILE: post-1.html>>> full article (600+ words of real content on topic 1) <<<END>>>
<<<FILE: post-2.html>>> full article (600+ words of real content on topic 2) <<<END>>>
<<<FILE: post-3.html>>> full article (600+ words of real content on topic 3) <<<END>>>
<<<FILE: styles.css>>> shared stylesheet <<<END>>>`,
  custom: `Design the smallest set of files that fully satisfies the user's brief. Prefer a single index.html unless the brief genuinely needs more files.`,
};

const PLAN_SYSTEM = `You are EmorAI's build planner. Given a brief, output a concise build plan.
Respond with STRICT JSON only (no markdown, no fences): {"title": string (max 60 chars), "description": string (one sentence), "pages": string[] (user-facing pages/sections), "features": string[] (key features, max 6)}`;

function builderSystem(): string {
  return `You are EmorAI's senior full-stack builder agent. You produce complete, working, production-quality static websites.
${SHARED_RULES}

Output protocol (critical): emit every file wrapped exactly like this, one after another, nothing else in your reply:
<<<FILE: styles.css>>>
...complete file content...
<<<END>>>
- The FIRST file must always be index.html.
- Never re-emit a file. Never add commentary before, between or after files.`;
}

// ─── Streaming file parser ───────────────────────────────────────────────────

const FILE_OPEN = '<<<FILE:';

class FileStreamSplitter {
  private buffer = '';
  private currentPath: string | null = null;
  private currentContent = '';
  readonly files: ArtifactFile[] = [];
  onEvent: (e: AgentRunEvent) => void = () => {};

  push(chunk: string) {
    this.buffer += chunk;
    // Loop until no more complete markers can be processed.
    for (;;) {
      if (this.currentPath === null) {
        const openIdx = this.buffer.indexOf(FILE_OPEN);
        if (openIdx === -1) {
          // Keep a small tail in case a marker spans chunk boundaries.
          this.buffer = this.buffer.slice(-20);
          return;
        }
        const lineEnd = this.buffer.indexOf('>>>', openIdx);
        if (lineEnd === -1) return; // wait for the full marker
        const rawPath = this.buffer
          .slice(openIdx + FILE_OPEN.length, lineEnd)
          .trim()
          .replace(/^\.?\//, '')
          .slice(0, 120);
        if (rawPath) {
          this.currentPath = rawPath;
          this.currentContent = '';
          this.onEvent({ type: 'file-start', path: rawPath });
        }
        this.buffer = this.buffer.slice(lineEnd + 3);
        continue;
      }

      const endIdx = this.buffer.indexOf('<<<END>>>');
      if (endIdx === -1) {
        // Stream out what we have (keep a tail for marker splitting).
        const flushable = this.buffer.slice(0, Math.max(0, this.buffer.length - 20));
        if (flushable) {
          this.currentContent += flushable;
          this.onEvent({ type: 'file-delta', path: this.currentPath, delta: flushable });
          this.buffer = this.buffer.slice(flushable.length);
        }
        return;
      }
      const rest = this.buffer.slice(0, endIdx);
      this.currentContent += rest;
      if (rest) this.onEvent({ type: 'file-delta', path: this.currentPath, delta: rest });
      const content = this.currentContent.replace(/^\s*\n/, '').replace(/\n\s*$/, '');
      if (this.currentPath) {
        this.files.push({ path: this.currentPath, content, entry: this.currentPath === 'index.html' });
        this.onEvent({ type: 'file-done', path: this.currentPath });
      }
      this.currentPath = null;
      this.currentContent = '';
      this.buffer = this.buffer.slice(endIdx + '<<<END>>>'.length);
    }
  }

  finish() {
    if (this.currentPath && this.currentContent.trim()) {
      // Unterminated trailing file — accept it so a truncated tail still yields work.
      this.files.push({ path: this.currentPath, content: this.currentContent.trim(), entry: this.currentPath === 'index.html' });
      this.onEvent({ type: 'file-done', path: this.currentPath });
    }
    this.currentPath = null;
    this.currentContent = '';
    this.buffer = '';
  }
}

function parsePlan(raw: string): AgentPlan {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const json = start !== -1 && end > start ? cleaned.slice(start, end + 1) : null;
  if (!json) throw new Error('Planner did not return JSON.');
  const parsed = JSON.parse(json) as Partial<AgentPlan>;
  return {
    title: String(parsed.title ?? 'Untitled project').slice(0, 80),
    description: String(parsed.description ?? '').slice(0, 300),
    pages: Array.isArray(parsed.pages) ? parsed.pages.slice(0, 12).map(String) : [],
    features: Array.isArray(parsed.features) ? parsed.features.slice(0, 8).map(String) : [],
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, 'bad_json', 'Request body must be valid JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return fail(400, 'invalid_request', 'Invalid agent request.', { details: parsed.error.flatten() });
  }
  const { template, brief, modelId } = parsed.data;

  const settings = await getSettings();
  const rl = rateLimit(`agent:${ipOf(req)}`, settings.dashboardRateLimitPerMin, 60_000);
  if (!rl.ok) {
    return fail(429, 'rate_limited', `Too many agent runs. Retry after ${rl.retryAfterSec}s.`);
  }

  const effectiveModelId = modelId ?? settings.defaultModelId;
  const model = effectiveModelId
    ? await getModelInfoByModelId(effectiveModelId)
    : (await listEnabledModels())[0] ?? null;
  if (!model) {
    return fail(400, 'unknown_model', `Model "${effectiveModelId ?? '(default)'}" is not available.`);
  }
  if (!model.enabled) {
    return fail(409, 'model_disabled', `"${model.displayName}" is disabled. Enable it in Settings → Models first.`);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (e: AgentRunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEvent(e)));
      };
      const step = (id: string, label: string, status: AgentStep['status'], detail?: string) =>
        send({ type: 'step', step: { id, label, status, ...(detail ? { detail } : {}) } });

      try {
        // ── Step 1: plan ────────────────────────────────────────────────────
        step('plan', 'Planning architecture', 'running');
        const planCompletion = await completeChat({
          modelId: model.modelId,
          provider: model.provider,
          messages: [
            { role: 'system', content: PLAN_SYSTEM },
            { role: 'user', content: `Template: ${template}\nBrief: ${brief}` },
          ],
          temperature: 0.4,
        });
        const plan = parsePlan(planCompletion.content);
        step('plan', 'Planning architecture', 'done', plan.pages.join(' · ') || undefined);
        send({ type: 'plan', plan });

        // ── Step 2: build (streaming, file-split) ───────────────────────────
        step('build', 'Building files', 'running');
        const splitter = new FileStreamSplitter();
        splitter.onEvent = send;
        let lastServed: string | null = null;
        for await (const ev of streamChat({
          modelId: model.modelId,
          provider: model.provider,
          messages: [
            { role: 'system', content: builderSystem() },
            {
              role: 'user',
              content: `Template: ${template}\n\nApproved plan (follow it exactly):\n${JSON.stringify(plan, null, 2)}\n\nUser brief: ${brief}\n\nTemplate output protocol:\n${TEMPLATE_BRIEFS[template] ?? TEMPLATE_BRIEFS.custom}`,
            },
          ],
          temperature: 0.7,
        })) {
          if (ev.type === 'delta') splitter.push(ev.content);
          else if (ev.type === 'served-model') lastServed = ev.model;
        }
        splitter.finish();

        const files = parseArtifactFiles(splitter.files);
        if (files.length === 0) {
          throw new Error('The builder produced no files. Try again or use a different model.');
        }
        step('build', 'Building files', 'done', `${files.length} file${files.length === 1 ? '' : 's'} written`);

        // ── Step 3: persist artifact ────────────────────────────────────────
        step('save', 'Saving project', 'running');
        const artifact = await db.artifact.create({
          data: {
            kind: template === 'blog' ? 'blog' : template === 'webapp' ? 'webapp' : 'website',
            title: plan.title || 'Untitled project',
            description: plan.description,
            prompt: brief.slice(0, 2000),
            modelId: model.modelId,
            status: 'ready',
            files,
            meta: { template, pages: plan.pages, features: plan.features, servedModel: lastServed },
          },
        });
        step('save', 'Saving project', 'done');
        send({ type: 'artifact', artifact: serializeArtifact(artifact, { includeFiles: true }) });
        send({ type: 'done' });
      } catch (e) {
        const message = (e as Error).message.slice(0, 400);
        send({ type: 'error', message, code: 'agent_failed' });
        send({ type: 'done' });
      } finally {
        closed = true;
        controller.enqueue(encoder.encode(sseDone()));
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
