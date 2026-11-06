'use client';

// Tiny localStorage-backed store for the Playground API key.
// Keys are hashed server-side, so the plaintext lives only in this browser.
// Shared by the Playground and Usage panels via useSyncExternalStore.

const KEY_STORAGE = 'emor.playground.key';

const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Client snapshot for useSyncExternalStore. Returns a stable string. */
export function getPlaygroundKey(): string {
  try {
    return window.localStorage.getItem(KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

/** Subscribe to same-tab writes and cross-tab `storage` events. */
export function subscribePlaygroundKey(listener: () => void): () => void {
  window.addEventListener('storage', listener);
  listeners.add(listener);
  return () => {
    window.removeEventListener('storage', listener);
    listeners.delete(listener);
  };
}

/** Server snapshot (hydration-safe empty value). */
export function getPlaygroundKeyServerSnapshot(): string {
  return '';
}

export function storePlaygroundKey(key: string): void {
  try {
    if (key) window.localStorage.setItem(KEY_STORAGE, key);
    else window.localStorage.removeItem(KEY_STORAGE);
  } catch {
    // storage unavailable (private mode etc.) — nothing sensible to do
  }
  notify();
}

export function clearPlaygroundKey(): void {
  storePlaygroundKey('');
}
