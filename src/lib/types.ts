// EmorAI — shared types used by server routes and client UI.

export type ModelCapabilities = {
  chat: boolean;
  reasoning: boolean;
  vision: boolean;
  files: boolean;
  webSearch: boolean;
  tools: boolean;
  json: boolean;
};

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  chat: true,
  reasoning: false,
  vision: false,
  files: false,
  webSearch: true,
  tools: false,
  json: false,
};

export type ModelStatus = 'ok' | 'error';

export type ModelInfo = {
  id: string;
  modelId: string;
  displayName: string;
  description: string;
  provider: string;
  capabilities: ModelCapabilities;
  freeTier: boolean;
  enabled: boolean;
  sortOrder: number;
  lastCheckedAt: string | null;
  lastStatus: ModelStatus | null;
  lastServedModel: string | null;
  lastError: string | null;
};

export type AppSettings = {
  defaultModelId: string;
  systemInstructions: string;
  temperature: number;
  maxTokens: number;
  streamEnabled: boolean;
  contextMessageLimit: number;
  apiRateLimitPerMin: number;
  dashboardRateLimitPerMin: number;
  titleGeneration: boolean;
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type WebSource = {
  url: string;
  name: string;
  snippet: string;
  host_name: string;
};

export type MessageAttachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: 'image' | 'document';
};

// Role of a chat participant
export type ChatRole = 'user' | 'assistant' | 'system';

// ─── EmorAI dashboard chat SSE protocol (server → client) ───────────────────

export type ChatStreamEvent =
  | { type: 'start'; conversationId: string; userMessageId: string; assistantMessageId: string; modelId: string }
  | { type: 'served-model'; modelId: string; servedModel: string | null }
  | { type: 'delta'; content: string }
  | { type: 'reasoning'; content: string }
  | { type: 'sources'; sources: WebSource[] }
  | { type: 'title'; title: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; message: SerializedMessage }
  | { type: 'error'; code: string; message: string };

// ─── Serialized DB rows sent to the client ──────────────────────────────────

export type SerializedMessage = {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: string;
  modelId: string | null;
  servedModel: string | null;
  reasoning: string | null;
  webSearch: boolean;
  sources: WebSource[] | null;
  attachments: MessageAttachment[] | null;
  status: string;
  errorText: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  latencyMs: number | null;
  createdAt: string;
};

export type SerializedConversation = {
  id: string;
  title: string;
  pinned: boolean;
  modelId: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount?: number;
};

export type SerializedFolder = {
  id: string;
  name: string;
  color: string | null;
  createdAt: string;
};

export type SerializedApiKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  requestCount: number;
};

export type SerializedUsageRecord = {
  id: string;
  source: string;
  apiKeyId: string | null;
  apiKeyName: string | null;
  conversationId: string | null;
  modelId: string;
  servedModel: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number | null;
  success: boolean;
  errorText: string | null;
  createdAt: string;
};

// ─── Provider-level message format (OpenAI-compatible) ──────────────────────

export type ProviderContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ProviderMessage = {
  role: ChatRole;
  content: string | ProviderContentPart[];
};
