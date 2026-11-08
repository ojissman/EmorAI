#!/usr/bin/env bash
#
# EmorAI secrets manager.
#
# Bundles every sensitive file of this install into one AES-256-CBC
# encrypted archive (PBKDF2 key derivation, 600k iterations) so the
# public repository never contains raw secrets or personal data.
#
# Encrypted bundle : secrets/emorai-secrets.tar.gz.enc
# Covers           : .env, db/custom.db, db/uploads/
#
# The passphrase is NEVER stored in this repository.
# Provide it via environment variable (or you will be prompted):
#
#   export EMORAI_SECRET_PASSPHRASE='...'
#   ./scripts/secrets.sh encrypt   # rebuild the bundle from local files
#   ./scripts/secrets.sh decrypt   # restore local files from the bundle
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUNDLE="$ROOT/secrets/emorai-secrets.tar.gz.enc"
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

ITER=600000

# Passphrase via env var or interactive prompt (never written to disk).
if [ -z "${EMORAI_SECRET_PASSPHRASE:-}" ]; then
  read -rsp "EmorAI secrets passphrase: " EMORAI_SECRET_PASSPHRASE
  echo >&2
  export EMORAI_SECRET_PASSPHRASE
fi

case "${1:-}" in
  encrypt)
    mkdir -p "$ROOT/secrets"
    # Normalize modes first so the archive always restores clean:
    # .env secret-only, db readable, uploads dir traversable.
    [ -f "$ROOT/.env" ] && chmod 600 "$ROOT/.env" || true
    [ -f "$ROOT/db/custom.db" ] && chmod 644 "$ROOT/db/custom.db" || true
    if [ -d "$ROOT/db/uploads" ]; then
      chmod 755 "$ROOT/db/uploads"
      find "$ROOT/db/uploads" -type f -exec chmod 644 {} + 2>/dev/null || true
    fi
    tar -C "$ROOT" -czf "$STAGING/bundle.tar.gz" .env db/custom.db db/uploads
    openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt \
      -in "$STAGING/bundle.tar.gz" -out "$BUNDLE" \
      -pass env:EMORAI_SECRET_PASSPHRASE
    # 644 on ciphertext keeps git mode-stable; plaintext never touches disk outside staging.
    chmod 644 "$BUNDLE"
    echo "Encrypted bundle written: secrets/emorai-secrets.tar.gz.enc"
    ;;
  decrypt)
    [ -f "$BUNDLE" ] || { echo "No bundle at $BUNDLE" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" \
      -in "$BUNDLE" -out "$STAGING/bundle.tar.gz" \
      -pass env:EMORAI_SECRET_PASSPHRASE
    tar -C "$ROOT" -xzf "$STAGING/bundle.tar.gz"
    # Mode-safe restore: dirs traversable, files private/readable.
    # (Works even when the caller is root and the archive carries odd modes.)
    chmod 600 "$ROOT/.env" 2>/dev/null || true
    chmod 644 "$ROOT/db/custom.db" 2>/dev/null || true
    if [ -d "$ROOT/db/uploads" ]; then
      chmod 755 "$ROOT/db/uploads"
      find "$ROOT/db/uploads" -type f -exec chmod 644 {} + 2>/dev/null || true
    fi
    if [ "$(id -u)" = "0" ]; then chown -R z:z "$ROOT/.env" "$ROOT/db" 2>/dev/null || true; fi
    echo "Secrets restored: .env, db/custom.db, db/uploads/"
    echo "NOTE: restart the dev server (bun run dev) so it opens the restored database."
    ;;
  *)
    echo "Usage: $0 {encrypt|decrypt}" >&2
    exit 1
    ;;
esac
