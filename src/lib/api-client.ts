// Typed fetch helpers for the EmorAI dashboard API.

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `Request failed with status ${res.status}`;
  let code = 'http_error';
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
  } catch {
    // non-JSON error
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, body?: unknown) =>
    request<T>(url, { method: 'POST', body: body === undefined ? '{}' : JSON.stringify(body) }),
  put: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  patch: <T>(url: string, body?: unknown) => request<T>(url, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(url: string) => request<T>(url, { method: 'DELETE' }),
  upload: async <T>(url: string, formData: FormData): Promise<T> => {
    const res = await fetch(url, { method: 'POST', body: formData });
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as T;
  },
};

// ─── Artifacts & Studio ──────────────────────────────────────────────────────

export const artifactUrls = {
  file: (id: string) => `/api/artifacts/${id}/file`,
  preview: (id: string, subpath?: string) =>
    subpath ? `/api/artifacts/${id}/preview/${subpath}` : `/api/artifacts/${id}/preview`,
  zip: (id: string) => `/api/artifacts/${id}/zip`,
};

export type ArtifactListResponse = { artifacts: SerializedArtifactSummary[] };

export type SerializedArtifactSummary = {
  id: string;
  kind: string;
  title: string;
  status: string;
  mime: string | null;
  size: number | null;
  createdAt: string;
};

// ─── Voice ───────────────────────────────────────────────────────────────────

export async function transcribeAudioClient(base64: string): Promise<string> {
  const res = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio: base64 }),
  });
  if (!res.ok) throw await parseError(res);
  const data = (await res.json()) as { text: string };
  return data.text;
}

export async function fetchSpeech(text: string, voice?: string, speed?: number): Promise<Blob> {
  const res = await fetch('/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed }),
  });
  if (!res.ok) throw await parseError(res);
  return await res.blob();
}
