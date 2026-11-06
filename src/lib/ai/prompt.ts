import { imageDataUri } from '@/lib/files';
import type { Message, FileMetadata } from '@prisma/client';
import type { MessageAttachment, ProviderContentPart, ProviderMessage, WebSource } from '@/lib/types';

const BASE_SYSTEM = `You are EmorAI, an intelligent, precise and warm AI assistant.
- Format answers in clean Markdown: headings, lists, tables and fenced code blocks with language tags.
- Be direct. Lead with the answer, then supporting detail.
- When you are uncertain, say so honestly instead of inventing facts.
- For code, include brief explanations and working, complete examples.`;

type MessageWithFiles = Message & { _files?: FileMetadata[] };

function attachmentList(attachments: unknown): MessageAttachment[] {
  return Array.isArray(attachments) ? (attachments as MessageAttachment[]) : [];
}

function withBaseSystem(custom: string): string {
  const now = new Date();
  const dateLine = `Current date: ${now.toISOString().slice(0, 10)} (UTC).`;
  if (custom && custom.trim()) {
    return `${BASE_SYSTEM}\n\n${dateLine}\n\nOperator's custom instructions (highest priority):\n${custom.trim()}`;
  }
  return `${BASE_SYSTEM}\n\n${dateLine}`;
}

function formatWebSearchBlock(sources: WebSource[]): string {
  const lines = sources.map((s, i) => `[${i + 1}] ${s.name} — ${s.url}\n${s.snippet}`);
  return `Web search results for the user's latest question (cite them as [n] where used):\n\n${lines.join('\n\n')}`;
}

function textPart(text: string): ProviderContentPart {
  return { type: 'text', text };
}

function imagePart(dataUri: string): ProviderContentPart {
  return { type: 'image_url', image_url: { url: dataUri } };
}

/**
 * Builds the provider message array from persisted history + attachments +
 * optional web-search results. Vision models receive image data URIs for the
 * newest message; older attachments are represented textually to keep the
 * context compact.
 */
export async function buildProviderMessages(args: {
  history: MessageWithFiles[];
  systemInstructions: string;
  vision: boolean;
  webSearchSources?: WebSource[];
  documentTextCharLimit?: number;
}): Promise<ProviderMessage[]> {
  const { history, systemInstructions, vision, webSearchSources } = args;
  const docLimit = args.documentTextCharLimit ?? 24_000;
  const messages: ProviderMessage[] = [{ role: 'system', content: withBaseSystem(systemInstructions) }];

  const lastIndex = history.length - 1;

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    const isNewest = i === lastIndex;
    const attachments = attachmentList(msg.attachments);
    let text = msg.content ?? '';

    // Web search context is attached to the newest user message only.
    if (isNewest && msg.role === 'user' && webSearchSources && webSearchSources.length > 0) {
      text = `${text}\n\n---\n${formatWebSearchBlock(webSearchSources)}`;
    }

    // Document text extraction is injected for the newest message only.
    const docs = attachments.filter((a) => a.kind === 'document');
    if (docs.length > 0) {
      if (isNewest) {
        for (const doc of docs) {
          const meta = msg._files?.find((f) => f.id === doc.id);
          const text2 = meta?.extractedText;
          if (text2) {
            text = `${text}\n\n--- Attached document: ${doc.name} ---\n${text2.slice(0, docLimit)}\n--- End of document ---`;
          } else {
            text = `${text}\n\n[Document attached: ${doc.name}]`;
          }
        }
      } else {
        text = `${text}\n\n[Documents attached: ${docs.map((d) => d.name).join(', ')}]`;
      }
    }

    // Images: newest message on a vision-capable model gets real image parts.
    const images = attachments.filter((a) => a.kind === 'image');
    if (msg.role === 'user' && images.length > 0) {
      if (isNewest && vision) {
        const parts: ProviderContentPart[] = [textPart(text)];
        for (const img of images) {
          const uri = await imageDataUri(img.id);
          if (uri) parts.push(imagePart(uri));
          else parts.push(textPart(`[Image could not be loaded: ${img.name}]`));
        }
        messages.push({ role: 'user', content: parts });
        continue;
      }
      text = `${text}\n\n[Images attached: ${images.map((d) => d.name).join(', ')}${vision ? '' : ' — vision is not enabled for this model'}]`;
    }

    messages.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: text });
  }

  return messages;
}
