import ZAI from 'z-ai-web-dev-sdk';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import os from 'os';
import path from 'path';

// ─── Shared helpers ──────────────────────────────────────────────────────────

export const IMAGE_SIZES = [
  '1024x1024',
  '768x1344',
  '864x1152',
  '1344x768',
  '1152x864',
  '1440x720',
  '720x1440',
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

export type GeneratedImage = { buffer: Buffer; mime: string };

/** Generates one or more images. Returns PNG buffers. */
export async function generateImages(prompt: string, size: ImageSize = '1024x1024'): Promise<GeneratedImage[]> {
  const zai = await ZAI.create();
  const res = await zai.images.generations.create({ prompt: prompt.slice(0, 4000), size });
  if (!res?.data?.length) throw new Error('The image model returned no output.');
  return res.data
    .filter((d) => typeof d.base64 === 'string' && d.base64.length > 0)
    .map((d) => ({ buffer: Buffer.from(d.base64, 'base64'), mime: 'image/png' }));
}

/** Edits an existing image with a prompt. `imageBase64` is raw base64 (no data: prefix). */
export async function editImage(prompt: string, imageBase64: string, size: ImageSize = '1024x1024'): Promise<GeneratedImage> {
  const zai = await ZAI.create();
  const res = await zai.images.generations.edit({ prompt: prompt.slice(0, 4000), image: imageBase64, size });
  const first = res?.data?.find((d) => typeof d.base64 === 'string' && d.base64.length > 0);
  if (!first) throw new Error('The image model returned no output.');
  return { buffer: Buffer.from(first.base64, 'base64'), mime: 'image/png' };
}

// ─── Video (async tasks) ─────────────────────────────────────────────────────

export type VideoJobOptions = {
  prompt: string;
  quality?: 'speed' | 'quality';
  withAudio?: boolean;
  duration?: number;
  size?: string;
};

export async function startVideoJob(opts: VideoJobOptions): Promise<string> {
  const zai = await ZAI.create();
  const res = await zai.video.generations.create({
    prompt: opts.prompt.slice(0, 4000),
    quality: opts.quality === 'quality' ? 'quality' : 'speed',
    with_audio: Boolean(opts.withAudio),
    ...(opts.duration ? { duration: Math.min(Math.max(Math.round(opts.duration), 5), 10) } : {}),
    ...(opts.size ? { size: opts.size } : {}),
  });
  if (!res?.id) throw new Error('The video service did not return a task id.');
  return res.id;
}

export type VideoJobStatus = {
  status: 'processing' | 'success' | 'failed';
  videoUrl: string | null;
  raw: unknown;
};

export async function queryVideoJob(taskId: string): Promise<VideoJobStatus> {
  const zai = await ZAI.create();
  const res = await zai.async.result.query(taskId);
  const status = res?.task_status === 'SUCCESS' ? 'success' : res?.task_status === 'FAIL' ? 'failed' : 'processing';
  const videoUrl =
    res?.video_result?.[0]?.url ?? res?.video_url ?? res?.url ?? res?.video ?? null;
  return { status, videoUrl: typeof videoUrl === 'string' ? videoUrl : null, raw: res };
}

/** Downloads a produced video so the artifact survives without the provider URL. */
export async function downloadRemoteFile(url: string): Promise<{ buffer: Buffer; mime: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download media (${res.status})`);
  const mime = res.headers.get('content-type') ?? 'application/octet-stream';
  return { buffer: Buffer.from(await res.arrayBuffer()), mime };
}

// ─── Speech (TTS) ────────────────────────────────────────────────────────────

export const TTS_VOICES = ['tongtong', 'xiaochen', 'chuichui', 'xiaoxiao', 'doudou'] as const;

export type TtsResult = { buffer: Buffer; mime: string };

/** Text → speech. Returns the audio bytes and mime as reported upstream. */
export async function synthesizeSpeech(text: string, voice?: string, speed?: number): Promise<TtsResult> {
  const zai = await ZAI.create();
  const upstream = await zai.audio.tts.create({
    input: text.slice(0, 8000),
    // The gateway defaults to raw PCM (unplayable in browsers); WAV works.
    response_format: 'wav',
    ...(voice ? { voice } : {}),
    ...(typeof speed === 'number' ? { speed: Math.min(Math.max(speed, 0.5), 2) } : {}),
  });
  const mime = (upstream.headers.get('content-type') ?? 'audio/wav').split(';')[0].trim();
  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (buffer.byteLength < 256) throw new Error('The speech service returned empty audio.');
  return { buffer, mime };
}

// ─── Speech recognition (ASR) ────────────────────────────────────────────────

export async function transcribeAudio(fileBase64: string): Promise<string> {
  const zai = await ZAI.create();
  const res = (await zai.audio.asr.create({ file_base64: fileBase64 })) as {
    text?: string;
    data?: { text?: string };
    result?: { text?: string };
  };
  const text = res?.text ?? res?.data?.text ?? res?.result?.text ?? '';
  if (typeof text !== 'string') throw new Error('Unexpected transcription response.');
  return text.trim();
}

// ─── Documents: DOCX ─────────────────────────────────────────────────────────

type InlineRun = { text: string; bold?: boolean; italic?: boolean; code?: boolean };

/** Parses **bold**, *italic* and `code` spans inside a line. */
function parseInline(line: string): InlineRun[] {
  const runs: InlineRun[] = [];
  const regex = /(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(line)) !== null) {
    if (match.index > last) runs.push({ text: line.slice(last, match.index) });
    const token = match[0];
    if (token.startsWith('**')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = match.index + token.length;
  }
  if (last < line.length) runs.push({ text: line.slice(last) });
  return runs.length ? runs : [{ text: line }];
}

function stripMd(line: string): string {
  return line.replace(/(\*\*|__)(.*?)\1/g, '$2').replace(/(\*|_)(.*?)\1/g, '$2').replace(/`([^`]+)`/g, '$1');
}

/** Converts markdown text into a styled .docx buffer (headings, lists, quotes, code, rules). */
export async function markdownToDocx(markdown: string, title: string): Promise<Buffer> {
  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, BorderStyle,
  } = await import('docx');

  const children: InstanceType<typeof Paragraph>[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  const inlineToRuns = (line: string, extra?: Partial<InlineRun>) =>
    parseInline(line).map(
      (r) =>
        new TextRun({
          text: r.text,
          bold: r.bold || extra?.bold,
          italics: r.italic || extra?.italic,
          font: r.code ? 'Courier New' : undefined,
          size: r.code ? 20 : undefined,
        })
    );

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      i++;
      const codeLines: string[] = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      for (const cl of codeLines) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: cl || ' ', font: 'Courier New', size: 19 })],
            shading: { fill: 'F2F2F2' },
            spacing: { before: 0, after: 0 },
          })
        );
      }
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const map = [
        HeadingLevel.HEADING_1,
        HeadingLevel.HEADING_2,
        HeadingLevel.HEADING_3,
        HeadingLevel.HEADING_4,
      ];
      children.push(
        new Paragraph({
          heading: map[level - 1],
          children: [new TextRun({ text: stripMd(heading[2]), bold: true })],
          spacing: { before: 240, after: 120 },
        })
      );
      i++;
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      children.push(
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'CCCCCC', space: 8 } },
          spacing: { before: 120, after: 240 },
          children: [],
        })
      );
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      children.push(
        new Paragraph({ children: inlineToRuns(bullet[1]), bullet: { level: 0 }, spacing: { after: 60 } })
      );
      i++;
      continue;
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      children.push(
        new Paragraph({ children: inlineToRuns(`${numbered[1]}. ${stripMd(numbered[2])}`), spacing: { after: 60 } })
      );
      i++;
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      children.push(
        new Paragraph({
          children: inlineToRuns(quote[1], { italic: true }),
          indent: { left: 480 },
          border: { left: { style: BorderStyle.SINGLE, size: 12, color: '999999', space: 12 } },
          spacing: { after: 80 },
        })
      );
      i++;
      continue;
    }

    if (line.trim() === '') {
      children.push(new Paragraph({ children: [], spacing: { after: 80 } }));
      i++;
      continue;
    }

    children.push(new Paragraph({ children: inlineToRuns(line), spacing: { after: 120 } }));
    i++;
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: 'Calibri', size: 22 } },
      },
    },
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            heading: HeadingLevel.TITLE,
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: title, bold: true })],
            spacing: { after: 240 },
          }),
          ...children,
        ],
      },
    ],
  });

  return Buffer.from(await Packer.toBuffer(doc));
}

// ─── Documents: PDF (HTML → PDF via Playwright chromium) ─────────────────────

let chromiumPathCache: string | null | undefined;

function findChromiumExecutable(): string | null {
  if (chromiumPathCache !== undefined) return chromiumPathCache;
  const roots = [path.join(os.homedir(), '.cache', 'ms-playwright'), '/root/.cache/ms-playwright'];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of ['chromium_headless_shell-1200', 'chromium-1200']) {
      for (const bin of [
        path.join(root, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(root, entry, 'chrome-linux64', 'chrome'),
        path.join(root, entry, 'chrome-linux', 'chrome'),
      ]) {
        if (existsSync(bin)) {
          chromiumPathCache = bin;
          return bin;
        }
      }
    }
  }
  chromiumPathCache = null;
  return null;
}

const PRINT_CSS = `
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; line-height: 1.65;
           max-width: 800px; margin: 0 auto; padding: 48px 40px; font-size: 11.5pt; }
    h1, h2, h3, h4 { font-family: 'Helvetica Neue', Arial, sans-serif; line-height: 1.25; color: #111; }
    h1 { font-size: 24pt; margin: 0 0 18pt; } h2 { font-size: 16pt; margin: 22pt 0 8pt; }
    h3 { font-size: 13pt; margin: 18pt 0 6pt; }
    p { margin: 0 0 10pt; } ul, ol { margin: 0 0 12pt 22pt; } li { margin-bottom: 4pt; }
    blockquote { border-left: 3px solid #bbb; margin: 12pt 0; padding: 4pt 14pt; color: #444; font-style: italic; }
    code { font-family: 'Courier New', monospace; background: #f4f4f4; padding: 1px 4px; border-radius: 3px; font-size: 10pt; }
    pre { background: #f6f6f6; border: 1px solid #e4e4e4; border-radius: 6px; padding: 10pt 12pt; overflow: hidden; }
    pre code { background: none; padding: 0; font-size: 9pt; line-height: 1.45; }
    table { border-collapse: collapse; width: 100%; margin: 12pt 0; }
    th, td { border: 1px solid #ccc; padding: 6pt 8pt; text-align: left; font-size: 10.5pt; }
    th { background: #f0f0f0; } hr { border: none; border-top: 1px solid #ccc; margin: 18pt 0; }
    img { max-width: 100%; }
  </style>`;

/** Renders a standalone HTML document to PDF using the cached Playwright chromium. */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const executablePath = findChromiumExecutable();
  if (!executablePath) {
    throw new Error('PDF renderer unavailable: no chromium binary found on this machine.');
  }
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage();
    const withPrint = /<head[^>]*>/i.test(html)
      ? html.replace(/<head([^>]*)>/i, `<head$1>${PRINT_CSS}`)
      : `<html><head>${PRINT_CSS}</head><body>${html}</body></html>`;
    await page.setContent(withPrint, { waitUntil: 'load', timeout: 30_000 });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '12mm', bottom: '14mm', left: '12mm', right: '12mm' } });
    await page.close();
    return Buffer.from(pdf);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ─── Artifact storage ────────────────────────────────────────────────────────

export const ARTIFACT_DIR = path.join(process.cwd(), 'db', 'uploads');

export async function writeArtifactFile(artifactId: string, buffer: Buffer): Promise<{ storagePath: string; size: number }> {
  await mkdir(ARTIFACT_DIR, { recursive: true });
  const storagePath = path.join(ARTIFACT_DIR, artifactId);
  await writeFile(storagePath, buffer);
  return { storagePath, size: buffer.byteLength };
}

export async function readArtifactFile(storagePath: string): Promise<Buffer | null> {
  try {
    return await readFile(storagePath);
  } catch {
    return null;
  }
}

export async function removeArtifactFile(storagePath: string): Promise<void> {
  try {
    await unlink(storagePath);
  } catch {
    // already gone
  }
}
