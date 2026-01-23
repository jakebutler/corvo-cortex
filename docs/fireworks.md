# Fireworks Integration

This document describes how Corvo Cortex integrates with Fireworks.ai and how to configure it safely.

## Overview
- Fireworks is treated as an OpenAI-compatible provider for `/v1/chat/completions`.
- Fireworks-native `/v1/responses` is proxied as a separate endpoint.
- Fireworks is preferred when it has credits and the requested model exists in the Fireworks catalog.

## Endpoints
- Chat completions: `POST /v1/chat/completions`
- Responses: `POST /v1/responses`

Corvo routes to Fireworks when:
- The Fireworks model catalog includes the requested model, and
- Fireworks has available credits.

If Fireworks has insufficient credits, Corvo falls back to the next provider and indicates the fallback via response headers.

## Response Headers
When a provider is selected, Corvo adds headers to the response:
- `X-Corvo-Provider`
- `X-Corvo-Fallback` (`true` or `false`)
- `X-Corvo-Fallback-Reason` (e.g., `insufficient_credits`)

## Model Catalog
Fireworks model IDs are stored in KV as a cached catalog.

- KV key: `models:fireworks`
- Value shape:
  ```json
  {
    "updatedAt": "2026-01-23T00:00:00Z",
    "models": ["accounts/fireworks/models/...", "..."]
  }
  ```

The catalog is refreshed weekly via a cron trigger. The refresh attempts to use a Fireworks model API if available; otherwise it falls back to scraping the Fireworks model list page.

## Pricing
Pricing is stored in KV and used for both telemetry and credit deductions.

- KV key: `pricing:fireworks`
- Value shape:
  ```json
  {
    "accounts/fireworks/models/llama-v3p1-8b-instruct": { "input": 0.30, "output": 1.20 },
    "default": { "input": 1.0, "output": 2.0 }
  }
  ```

Corvo always uses the **uncached input** price for deductions.

## Credits
Credits are tracked globally per provider via a Durable Object ledger.

- Currency: `USD` or `credits`
- Deductions occur only for successful responses.
- If insufficient credits, Fireworks is skipped and a fallback provider is used.

## Safe Setup: Fireworks API Key
Never paste or store API keys in code or docs. Use Wrangler secrets instead.

1) Add the Fireworks key to your local environment:
```bash
wrangler secret put FIREWORKS_API_KEY
```

2) Enter the key when prompted.

3) Verify the secret exists (optional):
```bash
wrangler secret list
```

This keeps the key out of source control and allows local or deployed testing.

## Local Testing Notes
- Run the worker locally:
  ```bash
  npm run dev
  ```
- Ensure the Fireworks secret is available in your Wrangler environment.
- Use a Fireworks model ID in the request to trigger routing.

