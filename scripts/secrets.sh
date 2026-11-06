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
    tar -C "$ROOT" -czf "$STAGING/bundle.tar.gz" .env db/custom.db db/uploads
    openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt \
      -in "$STAGING/bundle.tar.gz" -out "$BUNDLE" \
      -pass env:EMORAI_SECRET_PASSPHRASE
    chmod 600 "$BUNDLE"
    echo "Encrypted bundle written: secrets/emorai-secrets.tar.gz.enc"
    ;;
  decrypt)
    [ -f "$BUNDLE" ] || { echo "No bundle at $BUNDLE" >&2; exit 1; }
    openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" \
      -in "$BUNDLE" -out "$STAGING/bundle.tar.gz" \
      -pass env:EMORAI_SECRET_PASSPHRASE
    tar -C "$ROOT" -xzf "$STAGING/bundle.tar.gz"
    echo "Secrets restored: .env, db/custom.db, db/uploads/"
    ;;
  *)
    echo "Usage: $0 {encrypt|decrypt}" >&2
    exit 1
    ;;
esac
