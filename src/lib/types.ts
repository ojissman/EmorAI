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

export type ModelCategory = 'emorai' | 'provider';

export type ModelLifecycle = 'draft' | 'preview' | 'active' | 'deprecated' | 'retired';

export type ModelPricing = {
  inputPerMTok: number;
  outputPerMTok: number;
  currency: string;
};

export type ModelInfo = {
  id: string;
  modelId: string;
  displayName: string;
  description: string;
  provider: string;
  // Category A (official unified family) vs Category B (upstream provider model)
  category: ModelCategory;
  lifecycle: ModelLifecycle;
  // EmorAI product generation, e.g. "5.3" (null for provider models)
  generation: string | null;
  pricing: ModelPricing | null;
  capabilities: ModelCapabilities;
  freeTier: boolean;
  enabled: boolean;
  sortOrder: number;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  aliases: string[];
  streamSupported: boolean;
  lastCheckedAt: string | null;
  lastStatus: ModelStatus | null;
  lastServedModel: string | null;
  lastError: string | null;
};

// Routing strategy for the intelligent router. 'balanced' blends priority,
// health and weight; 'priority' is pure configured order; 'cost' prefers the
// lowest admin-configured route weight (the honest cost proxy — pricing
// metadata is admin-configured only and never invented); 'performance'
// prefers the lowest recently *measured* execution latency per route.
export type RoutingStrategyName = 'balanced' | 'priority' | 'cost' | 'performance';

export const ROUTING_STRATEGIES: RoutingStrategyName[] = ['balanced', 'priority', 'cost', 'performance'];

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
  routingStrategy: RoutingStrategyName;
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
  scopes: string[];
  rateLimitPerMin: number | null;
  monthlyRequestLimit: number | null;
  monthlyTokenLimit: number | null;
  allowedModels: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  requestCount: number;
};

export type SerializedUsageRecord = {
  id: string;
  source: string;
  protocol: string | null;
  endpoint: string | null;
  statusCode: number | null;
  requestId: string | null;
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

export type ProviderToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type ProviderMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ProviderContentPart[];
  // assistant messages may carry tool calls (OpenAI function-calling protocol)
  tool_calls?: ProviderToolCall[];
  // tool responses reference the originating call
  tool_call_id?: string;
};

export type ProviderTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

// ─── Artifacts (Agent + Studio outputs) ──────────────────────────────────────

export type ArtifactKind = 'website' | 'webapp' | 'blog' | 'document' | 'image' | 'video' | 'audio';

export type ArtifactFile = {
  path: string;
  content: string;
  entry?: boolean;
};

export type SerializedArtifact = {
  id: string;
  kind: ArtifactKind;
  title: string;
  description: string;
  prompt: string | null;
  modelId: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  mime: string | null;
  size: number | null;
  error: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  // detail-only fields
  files?: ArtifactFile[];
  providerTaskId?: string;
};

// ─── Agent runner SSE protocol ───────────────────────────────────────────────

export type AgentStep = {
  id: string;
  label: string;
  status: 'running' | 'done' | 'failed';
  detail?: string;
};

export type AgentPlan = {
  title: string;
  description: string;
  pages: string[];
  features: string[];
};

export type AgentRunEvent =
  | { type: 'step'; step: AgentStep }
  | { type: 'plan'; plan: AgentPlan }
  | { type: 'file-start'; path: string }
  | { type: 'file-delta'; path: string; delta: string }
  | { type: 'file-done'; path: string }
  | { type: 'artifact'; artifact: SerializedArtifact }
  | { type: 'error'; message: string; code?: string }
  | { type: 'done' };

export type AgentTemplate = 'website' | 'webapp' | 'blog' | 'landing' | 'custom';

// ─── Voice ───────────────────────────────────────────────────────────────────

export type TranscribeResponse = { text: string };
