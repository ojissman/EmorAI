// ─── Provider adapter registry ───────────────────────────────────────────────
// Maps a provider account (DB row) to its adapter implementation and resolves
// decrypted execution credentials — server-side only. Adding a provider means
// adding one adapter + one entry here; nothing else in the app changes.

import { db } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { zaiAdapter } from './zai';
import { openAiCompatAdapter, selfHostedAdapter } from './openai-compat';
import { anthropicCompatAdapter } from './anthropic-compat';
import type { AIProviderAdapter, AdapterContext } from './types';

export type { AIProviderAdapter, AdapterContext, UpstreamModel, ProviderValidationResult, ProviderHealth } from './types';
export type { StreamChatOptions, StreamEvent, CompleteChatResult } from './types';

const ADAPTERS: Record<string, AIProviderAdapter> = {
  zai: zaiAdapter,
  openai: openAiCompatAdapter,
  anthropic: anthropicCompatAdapter,
  'self-hosted': selfHostedAdapter,
};

/** All registered provider types (admin UI + validation use this). */
export function registeredProviderTypes(): string[] {
  return Object.keys(ADAPTERS);
}

export function getAdapterByType(providerType: string): AIProviderAdapter | null {
  return ADAPTERS[providerType] ?? null;
}

/** Builds the execution context for a provider account row (decrypts credentials). */
export function adapterContextForAccount(account: {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string | null;
  apiKeyEnc: string | null;
  credentialMode: string;
}): AdapterContext {
  let apiKey: string | null = null;
  if (account.credentialMode === 'stored' && account.apiKeyEnc) {
    // Throws if the master key is unavailable — fail securely, never plaintext.
    apiKey = decryptSecret(account.apiKeyEnc);
  }
  return {
    accountId: account.id,
    accountName: account.name,
    providerType: account.providerType,
    apiKey,
    baseUrl: account.baseUrl,
  };
}

/** Loads an account row from the DB and builds its adapter context. */
export async function loadAccountContext(accountId: string): Promise<{ ctx: AdapterContext; adapter: AIProviderAdapter } | null> {
  const account = await db.providerAccount.findUnique({ where: { id: accountId } });
  if (!account) return null;
  const adapter = getAdapterByType(account.providerType);
  if (!adapter) return null;
  return { ctx: adapterContextForAccount(account), adapter };
}
