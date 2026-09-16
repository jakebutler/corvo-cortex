#!/bin/bash

# Corvo Cortex - Seed Initial Data Script

set -e

echo "🌱 Seeding Initial Data for Corvo Cortex"
echo "======================================"
echo ""

# Get namespace IDs (update these with actual values)
CLIENTS_NAMESPACE_ID="${CLIENTS_NAMESPACE_ID:-your_clients_namespace_id}"
CONFIG_NAMESPACE_ID="${CONFIG_NAMESPACE_ID:-your_config_namespace_id}"

# Generate a fresh API key at seed time; never reuse a committed sample key.
KINISI_KEY="sk-corvo-kinisi-$(openssl rand -hex 12)"
KINISI_KEY_MASKED="${KINISI_KEY:0:14}…${KINISI_KEY: -4}"

echo "📋 Adding client configuration..."
echo ""

# Add Kinisi client
echo "Adding Kinisi Mobile client (key ${KINISI_KEY_MASKED})..."
npx wrangler kv key put --namespace-id="$CLIENTS_NAMESPACE_ID" "$KINISI_KEY" '{
  "appId": "kinisi",
  "name": "Kinisi Mobile",
  "defaultModel": "claude-3-5-sonnet",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}' --env production --remote

echo "✅ Kinisi client added"
echo ""
umask 077
KEY_FILE="kinisi-api-key.txt"
echo "$KINISI_KEY" > "$KEY_FILE"
echo "🔑 The full API key was NOT printed. It was written locally to ./${KEY_FILE} (chmod 600)."
echo "   Store it in the client's secret manager now, then delete the file."
echo ""
echo "📋 Adding models list configuration..."
npx wrangler kv key put --namespace-id="$CONFIG_NAMESPACE_ID" "MODELS_LIST" '{
  "data": [
    { "id": "gpt-4o", "provider": "openai", "name": "GPT-4o (Reasoning)" },
    { "id": "claude-3-5-sonnet", "provider": "anthropic", "name": "Claude 3.5 Sonnet (Coding)" },
    { "id": "glm-4-plus", "provider": "z-ai", "name": "GLM-4 (Creative)" },
    { "id": "gpt-4o-mini", "provider": "openai", "name": "GPT-4o Mini (Fast)" },
    { "id": "claude-3-haiku", "provider": "anthropic", "name": "Claude 3 Haiku (Economical)" }
  ]
}' --env production --remote

echo "✅ Models list configuration added"
echo ""

echo "✅ Initial data seeded successfully!"
echo ""
echo "To add more clients, use:"
echo "wrangler kv key put --namespace-id=$CLIENTS_NAMESPACE_ID \"sk-corvo-<app>-<random>\" '{...}' --env production --remote"
