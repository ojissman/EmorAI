import type { ApiKey, Conversation, Folder, Message, UsageRecord } from '@prisma/client';
import type {
  MessageAttachment,
  SerializedApiKey,
  SerializedConversation,
  SerializedFolder,
  SerializedMessage,
  SerializedUsageRecord,
  WebSource,
} from '@/lib/types';

export function serializeMessage(row: Message): SerializedMessage {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role as SerializedMessage['role'],
    content: row.content,
    modelId: row.modelId,
    servedModel: row.servedModel,
    reasoning: row.reasoning,
    webSearch: row.webSearch,
    sources: (row.sources as WebSource[] | null) ?? null,
    attachments: (row.attachments as MessageAttachment[] | null) ?? null,
    status: row.status,
    errorText: row.errorText,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    latencyMs: row.latencyMs,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeConversation(row: Conversation, messageCount?: number): SerializedConversation {
  return {
    id: row.id,
    title: row.title,
    pinned: row.pinned,
    modelId: row.modelId,
    folderId: row.folderId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastMessageAt: row.lastMessageAt.toISOString(),
    ...(messageCount !== undefined ? { messageCount } : {}),
  };
}

export function serializeFolder(row: Folder): SerializedFolder {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeApiKey(row: ApiKey): SerializedApiKey {
  const scopes = Array.isArray(row.scopes)
    ? (row.scopes as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const allowedModels = Array.isArray(row.allowedModels)
    ? (row.allowedModels as unknown[]).filter((m): m is string => typeof m === 'string')
    : null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: scopes.length > 0 ? scopes : ['chat', 'tools', 'vision', 'media', 'models', 'usage'],
    rateLimitPerMin: row.rateLimitPerMin ?? null,
    monthlyRequestLimit: row.monthlyRequestLimit ?? null,
    monthlyTokenLimit: row.monthlyTokenLimit ?? null,
    allowedModels,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    requestCount: row.requestCount,
  };
}

export function serializeUsageRecord(row: UsageRecord & { apiKey?: { name: string } | null }): SerializedUsageRecord {
  return {
    id: row.id,
    source: row.source,
    protocol: row.protocol ?? null,
    endpoint: row.endpoint ?? null,
    statusCode: row.statusCode ?? null,
    requestId: row.requestId ?? null,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKey?.name ?? null,
    conversationId: row.conversationId,
    modelId: row.modelId,
    servedModel: row.servedModel,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    latencyMs: row.latencyMs,
    success: row.success,
    errorText: row.errorText,
    createdAt: row.createdAt.toISOString(),
  };
}
