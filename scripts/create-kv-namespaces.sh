#!/bin/bash

# Corvo Cortex - KV Namespace Creation Script

set -e

echo "🗄️  Creating KV Namespaces for Corvo Cortex"
echo "==========================================="
echo ""

echo "📋 Creating CORTEX_CLIENTS namespace..."
CLIENTS_OUTPUT=$(wrangler kv:namespace create CORTEX_CLIENTS --env production)
CLIENTS_ID=$(echo "$CLIENTS_OUTPUT" | grep -oP 'id = \K.*?(?=\s)' || echo "")
echo "✅ CORTEX_CLIENTS namespace created"
echo "   ID: $CLIENTS_ID"
echo ""

echo "📋 Creating CORTEX_CONFIG namespace..."
CONFIG_OUTPUT=$(wrangler kv:namespace create CORTEX_CONFIG --env production)
CONFIG_ID=$(echo "$CONFIG_OUTPUT" | grep -oP 'id = \K.*?(?=\s)' || echo "")
echo "✅ CORTEX_CONFIG namespace created"
echo "   ID: $CONFIG_ID"
echo ""

echo "⚠️  IMPORTANT: Update wrangler.toml with these namespace IDs:"
echo ""
echo "[env.production.kv_namespaces]]
binding = \"CORTEX_CLIENTS\"
id = \"$CLIENTS_ID\"
preview_id = \"$CLIENTS_ID-preview\""

[[env.production.kv_namespaces]]
binding = \"CORTEX_CONFIG\"
id = \"$CONFIG_ID\"
preview_id = \"$CONFIG_ID-preview\""
"

echo ""
echo "✅ KV namespaces created successfully!"
echo ""
echo "Next steps:"
echo "1. Update wrangler.toml with the namespace IDs above"
echo "2. Seed initial data: ./scripts/seed-data.sh"
echo "3. Deploy to production: npm run deploy"
