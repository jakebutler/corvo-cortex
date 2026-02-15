#!/usr/bin/env bash
set -euo pipefail

ENV_NAME="${1:-production}"
KEY="routing:kinisi-hints:${ENV_NAME}"

echo "Deleting routing policy key: ${KEY} (env: ${ENV_NAME})"
wrangler kv key delete --binding CORTEX_CONFIG "$KEY" --env "$ENV_NAME"

echo "Done. Corvo Cortex will use built-in default routing policy for ${ENV_NAME}."
