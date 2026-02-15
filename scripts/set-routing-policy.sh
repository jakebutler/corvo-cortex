#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-production}"
POLICY_FILE="${2:-}"

if [[ -z "$POLICY_FILE" ]]; then
  echo "Usage: $0 <env> <policy-json-file>"
  echo "Example: $0 staging ./routing-policy.json"
  exit 1
fi

if [[ ! -f "$POLICY_FILE" ]]; then
  echo "Policy file not found: $POLICY_FILE"
  exit 1
fi

KEY="routing:kinisi-hints:${ENV_NAME}"

echo "Uploading routing policy to key: ${KEY} (env: ${ENV_NAME})"
wrangler kv key put --binding CORTEX_CONFIG "$KEY" --path "$POLICY_FILE" --env "$ENV_NAME"

echo "Done."
