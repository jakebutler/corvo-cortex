#!/bin/bash

# Configuration
NAMESPACE_ID="8607bc102781438a8e1ea9d481a5a12b" # From wrangler.toml [env.production.kv_namespaces] CORTEX_CLIENTS
API_KEY="${KINISI_API_KEY}"

if [ -z "$API_KEY" ]; then
  echo "❌ Error: KINISI_API_KEY environment variable is not set."
  echo "Usage: KINISI_API_KEY=your_key ./scripts/provision-kinisi.sh"
  exit 1
fi
APP_NAME="Kinisi"

echo "🚀 Provisioning '$APP_NAME' in Production..."
echo "Namespace ID: $NAMESPACE_ID"
echo "API Key: $API_KEY"

# Define Client Config
# Note: Rate limits set to 1000/min requests and 1M/min tokens for production readiness
JSON_CONFIG='{
  "appId": "kinisi",
  "name": "Kinisi",
  "defaultModel": "claude-3-5-sonnet",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 1000,
    "tokensPerMinute": 1000000
  }
}'

echo "Running wrangler kv:key put..."
wrangler kv:key put --namespace-id="$NAMESPACE_ID" "$API_KEY" "$JSON_CONFIG" --env production

echo ""
echo "✅ Credentials Provisioned!"
echo "---------------------------------------------------"
echo "App Name: $APP_NAME"
echo "API Key:  $API_KEY"
echo "Endpoint: https://cortex.corvolabs.com/v1/chat/completions"
echo "---------------------------------------------------"
