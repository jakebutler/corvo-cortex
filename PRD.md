Here is the finalized **Product Requirements Document (PRD)** for Corvo Cortex v2. You can copy this Markdown content and save it directly to your Google Drive as `Corvo_Cortex_PRD.md`.

---

# **PRD: Corvo Cortex (AI Gateway)**

**Version:** 2.2 | **Status:** Draft | **Owner:** CTO | **Date:** December 28, 2025

## **1. Executive Summary**

**Corvo Cortex** is a serverless AI Gateway and Smart Router acting as the central nervous system for all Corvo Labs applications. It decouples frontend applications from specific LLM providers, manages authentication via app-specific API keys, intelligently routes traffic to all apps to prioritize free credits (OpenAI, Anthropic, Z.ai), provides centralized cost telemetry, and includes per-client rate limiting and streaming support.

### **v2.2 Changes**
- Added streaming as MVP requirement
- Added per-client rate limiting with configurable quotas
- Added configurable fallback strategy (fail-fast vs. OpenRouter)
- Removed Daytona from provider list
- Added retry logic with exponential backoff
- Added circuit breaker pattern for provider health
- Added request/response validation with Zod

## **2. System Architecture**

### **High-Level Flow**

1. **Client App** (e.g., Kinisi) requests `POST /v1/chat/completions`.
2. **Corvo Cortex** (Cloudflare Worker) intercepts the request.
3. **Auth Layer:** Validates `Authorization: Bearer <sk-app-key>` against Cloudflare KV.
4. **Rate Limit Layer:** Checks per-client quotas (requests/minute, tokens/minute).
5. **Validation Layer:** Validates request schema using Zod.
6. **Routing Layer:**
   * **Direct Rule:** If model matches a specific provider strategy (e.g., "claude-3-5" + credits available) -> Route to Provider.
   * **Z.ai Rule:** If model is "glm-*" or provider is "z-ai" -> Route to Z.ai Pro.
   * **Fallback Rule:** If direct credits exhausted, check client's `fallbackStrategy`:
     - `openrouter`: Route to OpenRouter (paid)
     - `fail-fast`: Return 402 Payment Required with clear error
7. **Proxy Layer:** Forwards request with retry logic (exponential backoff, max 3 attempts).
8. **Streaming Layer:** If `stream: true`, pipes `ReadableStream` to client; otherwise returns full response.
9. **Telemetry Layer:** Logs request metadata, cost, and latency to **LangFuse** asynchronously.

### **Circuit Breaker**

Each provider maintains a health state tracked in Cloudflare Durable Objects:
- **Closed**: Normal operation (requests pass through)
- **Open**: Provider failing (fail-fast for 60 seconds)
- **Half-Open**: Test request sent to check recovery

## **3. API Documentation**

### **Base URL**

`https://corvo-cortex.corvolabs.workers.dev`

### **Authentication**

All requests must include the **API Key** assigned to the specific client application.

* **Header:** `Authorization: Bearer sk-corvo-<app_name>-<random_string>`

---

### **3.1 Get Available Models**

Returns a curated list of models recommended for Corvo apps, plus the system defaults.

* **Endpoint:** `GET /v1/models`
* **Response:**
```json
{
  "object": "list",
  "data": [
    { "id": "gpt-4o", "provider": "openai", "name": "GPT-4o (Reasoning)" },
    { "id": "claude-3-5-sonnet", "provider": "anthropic", "name": "Claude 3.5 Sonnet (Coding)" },
    { "id": "glm-4-plus", "provider": "z-ai", "name": "GLM-4 (Creative)" }
  ],
  "defaults": {
    "system_default": "gpt-4o",
    "client_default": "claude-3-5-sonnet" // Specific to the calling app
  }
}

```



### **3.2 Chat Completions**

Standard OpenAI-compatible endpoint for generating text/chat responses.

* **Endpoint:** `POST /v1/chat/completions`
* **Request Body:**
* `model` (string, optional): The ID of the model to use. If omitted, uses the `client_default`.
* `messages` (array): List of message objects (`{ role: "user", content: "..." }`).
* `temperature` (float, optional): Sampling temperature.
* `stream` (boolean, optional): Whether to stream back partial progress.


* **Behavior:**
* **Specific Routing:** If you request `gpt-4o` and we have OpenAI credits, it goes to OpenAI.
* **OpenRouter Pass-through:** If you request a model ID *not* in our curated list (e.g., `liquid/lfm-40b`), Cortex automatically routes it to OpenRouter.


* **Response:** Standard OpenAI Chat Completion JSON object.

---

## **4. Data Model (Cloudflare KV)**

### **Namespace: `CORTEX_CLIENTS`**

Used for Authentication and App-specific configuration.

* **Key:** `sk-corvo-kinisi-8823`
* **Value:**
```json
{
  "appId": "kinisi",
  "name": "Kinisi Mobile",
  "defaultModel": "claude-3-5-sonnet",
  "allowZai": true,
  "fallbackStrategy": "openrouter",
  "rateLimit": {
    "requestsPerMinute": 100,
    "tokensPerMinute": 50000
  }
}
```

**Rate Limit Tracking Keys:**
* **Key:** `ratelimit:{apiKey}:{minute}` (e.g., `ratelimit:sk-corvo-kinisi-8823:202512281430`)
* **Value:** `{ "requests": 45, "tokens": 125000 }`
* **TTL:** 120 seconds (2 minutes for safety buffer)

### **Namespace: `CORTEX_CONFIG`**

Used for System-wide configuration.

* **Key:** `MODELS_LIST`
* **Value:** JSON object containing the array of curated models returned by `/v1/models`.

### **Durable Objects: Circuit Breaker State**

* **Class:** `CircuitBreaker`
* **State per Provider:**
```javascript
{
  provider: "anthropic-direct",
  state: "closed", // "closed" | "open" | "half-open"
  failureCount: 0,
  lastFailureTime: null,
  nextAttemptTime: null
}
```

## **5. Technical Implementation**

**Stack:** Cloudflare Workers, Hono, Zod, LangFuse, Durable Objects.

### **Dependencies**
```json
{
  "dependencies": {
    "hono": "^4.0.0",
    "zod": "^3.22.0",
    "langfuse": "^3.0.0"
  }
}
```

### **Architecture Overview**

```typescript
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { Langfuse } from 'langfuse';

// Bindings (Cloudflare Workers environment)
type Bindings = {
  CORTEX_CLIENTS: KVNamespace;
  CORTEX_CONFIG: KVNamespace;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  ZAI_API_KEY: string;
  OPENROUTER_API_KEY: string;
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  CIRCUIT_BREAKER: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();
app.use('*', cors());

// Request schema validation
const chatCompletionSchema = z.object({
  model: z.string().optional(),
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.string()
  })),
  temperature: z.number().min(0).max(2).optional(),
  stream: z.boolean().optional().default(false),
  max_tokens: z.number().optional()
});

// AUTH + RATE LIMIT MIDDLEWARE
app.use('*', async (c, next) => {
  // 1. Auth
  const apiKey = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!apiKey) return c.json({ error: 'Unauthorized: Missing API key' }, 401);

  const clientData = await c.env.CORTEX_CLIENTS.get(apiKey, { type: 'json' });
  if (!clientData) return c.json({ error: 'Invalid API Key' }, 401);

  // 2. Rate Limit Check
  const minute = Math.floor(Date.now() / 60000);
  const rateLimitKey = `ratelimit:${apiKey}:${minute}`;
  const currentUsage = await c.env.CORTEX_CLIENTS.get(rateLimitKey, { type: 'json' })
    ?? { requests: 0, tokens: 0 };

  if (currentUsage.requests >= (clientData.rateLimit?.requestsPerMinute ?? 100)) {
    return c.json({ error: 'Rate limit exceeded: Too many requests' }, 429);
  }

  c.set('client', clientData);
  c.set('rateLimitKey', rateLimitKey);
  c.set('currentUsage', currentUsage);
  await next();
});

// RATE LIMIT UPDATE MIDDLEWARE (after request)
app.use('*', async (c, next) => {
  await next();

  // Increment rate limit counters
  const rateLimitKey = c.get('rateLimitKey');
  const currentUsage = c.get('currentUsage');
  const body = c.get('requestBody');
  const estimatedTokens = JSON.stringify(body?.messages ?? []).length * 1.3; // rough estimate

  await c.env.CORTEX_CLIENTS.put(rateLimitKey, JSON.stringify({
    requests: currentUsage.requests + 1,
    tokens: Math.floor(currentUsage.tokens + estimatedTokens)
  }), { expirationTtl: 120 });
});

// CIRCUIT BREAKER DURABLE OBJECT
export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount = 0;
  private failureThreshold = 5;
  private lastFailureTime: number | null = null;
  private openTimeout = 60000; // 60 seconds

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const provider = url.searchParams.get('provider') ?? 'unknown';

    // Check if circuit should attempt reset
    if (this.state === 'open' && this.lastFailureTime &&
        Date.now() - this.lastFailureTime > this.openTimeout) {
      this.state = 'half-open';
    }

    // Fail fast if circuit is open
    if (this.state === 'open') {
      return new Response(
        JSON.stringify({ error: 'Service temporarily unavailable due to failures' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Attempt request
    const response = await fetch(request);

    if (!response.ok) {
      this.failureCount++;
      this.lastFailureTime = Date.now();

      if (this.failureCount >= this.failureThreshold) {
        this.state = 'open';
      }
    } else if (this.state === 'half-open') {
      this.state = 'closed';
      this.failureCount = 0;
    }

    return response;
  }
}

// RETRY LOGIC WITH EXPONENTIAL BACKOFF
async function fetchWithRetry(url: string, options: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || response.status < 500) {
        return response;
      }
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
    }

    const delay = Math.pow(2, attempt) * 100 + Math.random() * 100; // 100ms, 300ms, 700ms
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw new Error('Max retries exceeded');
}

// STREAMING HELPER
async function streamResponse(response: Response): Promise<Response> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Response('No response body', { status: 500 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    }
  });
}

// ROUTING LOGIC
app.post('/v1/chat/completions', async (c) => {
  const body = await c.req.json();
  c.set('requestBody', body); // for rate limiting

  // Validate request
  const validationResult = chatCompletionSchema.safeParse(body);
  if (!validationResult.success) {
    return c.json({ error: 'Invalid request', details: validationResult.error }, 400);
  }

  const client = c.get('client');
  const model = body.model || client.defaultModel;

  let url, key, provider;

  // 1. Z.ai Pro
  if (model.includes('glm') || body.provider === 'z-ai') {
    url = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
    key = c.env.ZAI_API_KEY;
    provider = 'z-ai-pro';
  }
  // 2. Anthropic (Credit Burn)
  else if (model.includes('claude') && c.env.CREDITS_ANTHROPIC === 'true') {
    url = 'https://api.anthropic.com/v1/messages';
    key = c.env.ANTHROPIC_API_KEY;
    provider = 'anthropic-direct';
  }
  // 3. OpenAI (Credit Burn)
  else if (model.includes('gpt') && c.env.CREDITS_OPENAI === 'true') {
    url = 'https://api.openai.com/v1/chat/completions';
    key = c.env.OPENAI_API_KEY;
    provider = 'openai-direct';
  }
  // 4. Fallback Strategy
  else {
    if (client.fallbackStrategy === 'fail-fast') {
      return c.json({
        error: 'Payment Required',
        message: 'Direct credits exhausted. Fail-fast policy enabled.'
      }, 402);
    }
    // Default: OpenRouter fallback
    url = 'https://openrouter.ai/api/v1/chat/completions';
    key = c.env.OPENROUTER_API_KEY;
    provider = 'openrouter';
  }

  // Build request options
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${key}`
  };

  if (provider === 'anthropic-direct') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  }

  // EXECUTE REQUEST WITH RETRY
  const response = await fetchWithRetry(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  // Handle streaming
  if (body.stream) {
    return streamResponse(response);
  }

  const data = await response.json();

  // TELEMETRY (LangFuse) - async, non-blocking
  const langfuse = new Langfuse({
    publicKey: c.env.LANGFUSE_PUBLIC_KEY,
    secretKey: c.env.LANGFUSE_SECRET_KEY,
    baseUrl: 'https://cloud.langfuse.com'
  });
  c.executionCtx.waitUntil(
    langfuse.trace({
      name: 'llm-generation',
      metadata: { app: client.appId, provider, model },
      input: body,
      output: data
    }).shutdownAsync()
  );

  return c.json(data);
});

// MODELS ENDPOINT
app.get('/v1/models', async (c) => {
  const client = c.get('client');
  const modelsConfig = await c.env.CORTEX_CONFIG.get('MODELS_LIST', { type: 'json' });

  return c.json({
    object: 'list',
    data: modelsConfig?.data ?? [],
    defaults: {
      system_default: 'gpt-4o',
      client_default: client.defaultModel
    }
  });
});

export default app;
```

## **6. FAQ**

**Q1: Can I use models that aren't in the "Curated List"?**
**A:** Yes. The Curated List (`GET /v1/models`) is just a recommendation helper for your frontend UI. If your client app sends a `model` string that Cortex doesn't recognize (e.g., `mistralai/mistral-large`), Cortex will default to the **OpenRouter** fallback path. If OpenRouter supports that model string, it will work.

**Q2: Does Corvo Cortex remember the conversation history (Context/Memory)?**
**A:** No. Corvo Cortex is a **stateless** gateway. It passes the `messages` array you send it directly to the LLM provider.

* **Recommendation:** Your Client Apps (Kinisi, Primal Marc) should manage their own conversation state/history in their own databases (Convex/Supabase).
* **Future Upgrade:** For advanced, persistent long-term memory across different sessions (User Memory), we recommend integrating **Mem0 (mem0.ai)**. This would likely sit *alongside* Cortex or be integrated as a middleware step in v3.

**Q3: How does streaming work?**
**A:** Streaming is fully supported in MVP. Set `stream: true` in your request and Corvo Cortex will pipe the upstream provider's SSE stream directly to your client via a `ReadableStream`. This maintains low latency and real-time response chunks.

**Q4: How do we track cost per app?**
**A:** Costs are tracked in **LangFuse**. Each request is tagged with the `appId` (retrieved from the API Key in KV). You can view the LangFuse dashboard to see "Kinisi spent $4.50 this month" vs "Primal Marc spent $0.20".

**Q5: What happens when rate limits are exceeded?**
**A:** When a client exceeds their configured `requestsPerMinute` or `tokensPerMinute` quota, Corvo Cortex returns HTTP 429 (Too Many Requests) with a clear error message. The rate limit window resets every minute.

**Q6: How does the circuit breaker work?**
**A:** Each provider (Anthropic, OpenAI, Z.ai, OpenRouter) has a circuit breaker that tracks failures. After 5 consecutive failures, the circuit "opens" and returns 503 (Service Unavailable) for 60 seconds, allowing the provider to recover. The circuit then enters "half-open" state to test recovery before fully closing.

**Q7: What is the difference between "fail-fast" and "openrouter" fallback strategies?**
**A:** These are per-client configurations for handling credit exhaustion:
* **`fail-fast`**: Returns HTTP 402 (Payment Required) - prevents unexpected costs
* **`openrouter`**: Transparently routes to OpenRouter (paid) - ensures continuous service but costs money