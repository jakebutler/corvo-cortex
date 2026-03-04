#!/usr/bin/env bash

# Corvo Cortex - KV Namespace Creation Script

set -euo pipefail

extract_id() {
  # Wrangler prints config snippets like: id = "abc123..."
  echo "$1" | sed -n 's/.*id = "\(.*\)".*/\1/p' | head -n 1
}

echo "🗄️  Creating KV Namespaces for Corvo Cortex"
echo "==========================================="
echo ""

echo "📋 Creating CORTEX_CLIENTS namespace..."
CLIENTS_OUTPUT=$(npx wrangler kv namespace create CORTEX_CLIENTS --env production)
CLIENTS_ID=$(extract_id "$CLIENTS_OUTPUT")
echo "✅ CORTEX_CLIENTS namespace created"
echo "   ID: $CLIENTS_ID"
echo ""

echo "📋 Creating CORTEX_CLIENTS preview namespace..."
CLIENTS_PREVIEW_OUTPUT=$(npx wrangler kv namespace create CORTEX_CLIENTS_PREVIEW --env production --preview)
CLIENTS_PREVIEW_ID=$(extract_id "$CLIENTS_PREVIEW_OUTPUT")
echo "✅ CORTEX_CLIENTS preview namespace created"
echo "   Preview ID: $CLIENTS_PREVIEW_ID"
echo ""

echo "📋 Creating CORTEX_CONFIG namespace..."
CONFIG_OUTPUT=$(npx wrangler kv namespace create CORTEX_CONFIG --env production)
CONFIG_ID=$(extract_id "$CONFIG_OUTPUT")
echo "✅ CORTEX_CONFIG namespace created"
echo "   ID: $CONFIG_ID"
echo ""

echo "📋 Creating CORTEX_CONFIG preview namespace..."
CONFIG_PREVIEW_OUTPUT=$(npx wrangler kv namespace create CORTEX_CONFIG_PREVIEW --env production --preview)
CONFIG_PREVIEW_ID=$(extract_id "$CONFIG_PREVIEW_OUTPUT")
echo "✅ CORTEX_CONFIG preview namespace created"
echo "   Preview ID: $CONFIG_PREVIEW_ID"
echo ""

echo "⚠️  IMPORTANT: Update wrangler.toml with these namespace IDs:"
echo ""
cat <<EOF
[[env.production.kv_namespaces]]
binding = "CORTEX_CLIENTS"
id = "$CLIENTS_ID"
preview_id = "$CLIENTS_PREVIEW_ID"

[[env.production.kv_namespaces]]
binding = "CORTEX_CONFIG"
id = "$CONFIG_ID"
preview_id = "$CONFIG_PREVIEW_ID"
EOF

echo ""
echo "✅ KV namespaces created successfully!"
echo ""
echo "Next steps:"
echo "1. Update wrangler.toml with the namespace IDs above"
echo "2. Seed initial data: ./scripts/seed-data.sh"
echo "3. Deploy to production: npm run deploy"
