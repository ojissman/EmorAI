# Task 6-a — Media Studio (Images / Video / Speech / Documents)

Agent: media-studio builder
Status: ✅ COMPLETE — lint clean, tsc clean for owned files, dev.log has no compile errors.

## Files created (ONLY inside `src/components/emor/studio/`)

| File | Purpose |
|---|---|
| `src/components/emor/studio/media-studio.tsx` | Main export: `MediaStudio` (+ `export default`). Full-height shell: fixed header, 4 shadcn Tabs (Images / Video / Speech / Docs), each `TabsContent` scrolls (`flex-1 overflow-y-auto emor-scroll pb-8`). |
| `src/components/emor/studio/image-panel.tsx` | Image generation form (prompt w/ char count, 7 sizes, count 1–4), `EditImageSection` collapsible (drag-drop or file picker → auto-upload → prompt → apply edit), image card grid w/ skeleton-while-loading, size badge, download/delete. |
| `src/components/emor/studio/video-panel.tsx` | Video form (prompt, quality speed/quality, duration 5/10, withAudio Switch), `ActiveJobCard` polling via `useArtifact` (Progress shimmer + live elapsed timer + provider task id + 1–6 min note), toast on ready/failed, Retry re-submits last request, video library grid. |
| `src/components/emor/studio/audio-panel.tsx` | TTS form (title, script w/ words + char count, 5 voices, speed Slider 0.5–2× shown as badge), audio rows with `<audio controls>`, voice/speed/words badges on session items. |
| `src/components/emor/studio/document-panel.tsx` | Doc writer form (title, brief, format md/html/docx/pdf), rows with format icons (FileText/FileCode/FileType/FileImage) + format badge + size + time, Preview dialog: html → `<iframe src=preview>`, md → fetch text → `<pre>`; docx/pdf preview disabled w/ Tooltip "Download to view". |
| `src/components/emor/studio/studio-shared.tsx` | Shared: `StudioArtifactView` type (accepts both SerializedArtifact & ArtifactSummary), EmptyState, SectionHeading, StatusBadge, DownloadArtifactButton (temp-anchor `download` attr), DeleteArtifactButton (AlertDialog confirm → `useDeleteArtifact`), formatBytes/timeAgo/formatClock/wordCount/downloadNameFor. |

## Main export signature

```ts
export function MediaStudio(): JSX.Element   // named export in media-studio.tsx
export default MediaStudio                   // also default-exported for flexibility
```

Integrate with: `<MediaStudio />` rendered full-height in the main content column (expects parent to give it a definite height, e.g. `h-full` inside a flex column).

## Contracts used (exactly as specified)

- `useArtifacts(['image'|'video'|'audio'|'document'])`, `useArtifact(id)` (polls while processing/pending), `useDeleteArtifact()`.
- `api.post` for all 5 studio endpoints; `api.upload('/api/files/upload', form)` with field `file`.
- `artifactUrls.file(id)` / `artifactUrls.preview(id)`; `['artifacts']` queryKey invalidated after every successful generation.
- Bodies: image `{prompt,size,count}`, image/edit `{prompt,fileId,size}`, video `{prompt,quality,withAudio,duration}`, audio `{text,voice,speed,title?}`, document `{title,prompt,format}`.

## Verification results

- `bun run lint` → **PASS, exit 0, zero errors/warnings** (whole project).
- `bunx tsc --noEmit` → **0 errors** inside `src/components/emor/studio/**` (remaining project TS errors are in files owned by other tasks: `src/app/api/chat`, `src/app/api/v1/...`, `src/components/emor/chat/chat-area.tsx`, `src/stores/emor-store.ts`, `src/lib/artifacts.ts`, `examples/`, `skills/`).
- `dev.log` → no compile errors mentioning studio files; all 5 studio routes mounted (curl validation smoke test → expected 400s).

## Contract mismatches / integration notes for the integrator

1. **`GET /api/artifacts` currently 500s**: `db.artifact.findMany` threw `Cannot read properties of undefined` because the running dev server holds a Prisma client generated before the `Artifact` model existed. I ran `bun run db:push` (schema was already in sync; it regenerated the client on disk) — the **dev server process must be restarted** (or hot-reload the route) for `db.artifact` to exist. Until then every Library section shows its loading/empty state. NOT a studio-code bug.
2. **`POST /api/files/upload` route is missing** (GET 404 / POST 405). The chat composer uses the same endpoint, so presumably the files/upload task agent adds it. My EditImageSection degrades gracefully (toast on failure) and follows the specified response shape `{ file: { id, name, mime, size, kind } }`.
3. `lucide-react` has **no `FileWord` icon** — used `FileType` for docx and `FileImage` for pdf (spec allowed "or similar lucide icons").
4. Library summaries (`ArtifactSummary`) carry no `meta`/`prompt`, so size/format badges are derived from `mime` (format) and shown fully only for session-fresh artifacts; image size badge appears when `meta.size` is known.

## UX notes

- Controlled forms everywhere, `Loader2 animate-spin` submit states, sonner toasts on success/error, char/word counters, specific placeholders, empty states ("Nothing generated yet"), delete confirm AlertDialogs, `max-h-[420px] overflow-y-auto emor-scroll` libraries, `grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` responsive image grid, video elapsed timer + asymptotic Progress estimate, `pb-8` so the app's sticky footer never overlaps.
