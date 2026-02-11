#!/bin/bash

# Corvo Cortex - Production Secrets Setup Script
# This script helps configure secrets for production deployment

set -e

echo "🔧 Corvo Cortex v2.2 - Production Secrets Setup"
echo "============================================"
echo ""

# Check if user is logged in to Cloudflare
echo "📋 Checking Cloudflare authentication..."
wrangler whoami || {
  echo "❌ Not authenticated. Please run: wrangler login"
  exit 1
}

echo "✅ Authenticated as Cloudflare user"
echo ""

# Set secrets
echo "🔐 Setting production secrets..."
echo ""

echo "📌 Anthropic API Key:"
wrangler secret put ANTHROPIC_API_KEY --env production
echo ""

echo "📌 OpenAI API Key:"
wrangler secret put OPENAI_API_KEY --env production
echo ""

echo "📌 Z.ai API Key:"
wrangler secret put ZAI_API_KEY --env production
echo ""

echo "📌 OpenRouter API Key:"
wrangler secret put OPENROUTER_API_KEY --env production
echo ""

echo "📌 LangFuse Public Key:"
wrangler secret put LANGFUSE_PUBLIC_KEY --env production
echo ""

echo "📌 LangFuse Secret Key:"
wrangler secret put LANGFUSE_SECRET_KEY --env production
echo ""

echo "✅ All secrets configured successfully!"
echo ""
echo "📌 Ensure LANGFUSE_BASE_URL is set in wrangler.toml vars (recommended: https://us.cloud.langfuse.com)"
echo ""
echo "Next steps:"
echo "1. Create KV namespaces: ./scripts/create-kv-namespaces.sh"
echo "2. Deploy to production: npm run deploy"
