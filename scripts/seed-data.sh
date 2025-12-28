#!/bin/bash

# Corvo Cortex - Seed Initial Data Script

set -e

echo "🌱 Seeding Initial Data for Corvo Cortex"
echo "======================================"
echo ""

# Get namespace IDs (update these with actual values)
CLIENTS_NAMESPACE_ID="${CLIENTS_NAMESPACE_ID:-your_clients_namespace_id}"
CONFIG_NAMESPACE_ID="${CONFIG_NAMESPACE_ID:-your_config_namespace_id}"

echo "📋 Adding client configuration..."
echo ""

# Add Kinisi client
echo "Adding Kinisi Mobile client..."
wrangler kv:key put --namespace-id="$CLIENTS_NAMESPACE_ID" "sk-corvo-kinisi-a1b2c3d4e5f6" '{
  "appId": "kinisi",
  "name": "Kinisi Mobile",
  "defaultModel": "claude-3-5-sonnet",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}' --env production

echo "✅ Kinisi client added"
echo ""

# Add models list
echo "📋 Adding models list configuration..."
wrangler kv:key put --namespace-id="$CONFIG_NAMESPACE_ID" "MODELS_LIST" '{
  "data": [
    { "id": "gpt-4o", "provider": "openai", "name": "GPT-4o (Reasoning)" },
    { "id": "claude-3-5-sonnet", "provider": "anthropic", "name": "Claude 3.5 Sonnet (Coding)" },
    { "id": "glm-4-plus", "provider": "z-ai", "name": "GLM-4 (Creative)" },
    { "id": "gpt-4o-mini", "provider": "openai", "name": "GPT-4o Mini (Fast)" },
    { "id": "claude-3-haiku", "provider": "anthropic", "name": "Claude 3 Haiku (Economical)" }
  ]
}' --env production

echo "✅ Models list configuration added"
echo ""

echo "✅ Initial data seeded successfully!"
echo ""
echo "To add more clients, use:"
echo "wrangler kv:key put --namespace-id=$CLIENTS_NAMESPACE_ID \"sk-corvo-<app>-<random>\" '{...}' --env production"
