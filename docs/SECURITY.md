# EmorAI — Security Notes

## Credential handling
- **Upstream provider keys**: stored AES-256-GCM encrypted
  (`src/lib/crypto.ts`), master key derived via scrypt from
  `EMORAI_MASTER_KEY` (env only — never in DB or source control).
- If the master key is absent, credential storage **fails securely**:
  the Providers API refuses stored-credential accounts rather than keeping
  plaintext. The UI shows a banner explaining how to enable it.
- Rotation: `PATCH /api/providers/[id]` with a new `apiKey` re-encrypts at
  rest; `clearApiKey` removes the secret.
- Display: only a masked hint (first/last 4 chars + length) ever reaches
  the browser; ciphertext and plaintext never leave the server.

## Customer API keys (pre-existing, unchanged)
- `emr_…` keys stored as SHA-256 hashes; plaintext shown once at creation.
- Scopes, monthly limits, per-key rate limits, model allowlists enforced on
  every gateway request.

## Routing security
- Provider accounts never receive EmorAI customer keys; execution uses the
  account's own decrypted credential server-side only.
- Route eligibility requires enabled route + enabled account + non-error
  health + decryptable credentials — a stale DB row never becomes routable.
- Failover only on retryable errors before first output token (no
  duplicated user-visible output or billing).

## Request-path protections (pre-existing, preserved)
- Origin/CSRF guard on dashboard mutations (`src/proxy.ts`), `/api/v1/*`
  exempt by design (token-authenticated, CORS-open for API clients).
- Per-IP rate limiting; request validation via zod on every endpoint;
  secret redaction in logs (errors sanitized to message text).

## Honest-by-design guarantees
- No fabricated capabilities: route capability subsets are admin-verified;
  requests needing an unverified capability are routed elsewhere or rejected.
- No fabricated pricing: `pricing` is null until an admin configures it;
  unknown cost is never treated as zero.
- Served-model transparency: responses disclose the upstream model that
  actually served the request (`x-emorai-served-model`, `model` field,
  `emorai_requested_model` extension).
