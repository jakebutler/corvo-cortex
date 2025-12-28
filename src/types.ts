/**
 * Cloudflare Workers Environment Bindings
 */

// Client configuration from KV
export interface ClientConfig {
  appId: string;
  name: string;
  defaultModel: string;
  allowZai: boolean;
  fallbackStrategy: 'openrouter' | 'fail-fast';
  rateLimit: {
    requestsPerMinute: number;
    tokensPerMinute: number;
  };
}

// Rate limit usage tracking
export interface RateLimitUsage {
  requests: number;
  tokens: number;
}

// Model configuration
export interface ModelInfo {
  id: string;
  provider: string;
  name: string;
}

// Models list response
export interface ModelsListResponse {
  object: 'list';
  data: ModelInfo[];
  defaults: {
    system_default: string;
    client_default: string;
  };
}

// Environment bindings for Cloudflare Workers
export interface Env {
  // KV Namespaces
  CORTEX_CLIENTS: KVNamespace;
  CORTEX_CONFIG: KVNamespace;

  // API Keys (secrets)
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY: string;
  ZAI_API_KEY: string;
  OPENROUTER_API_KEY: string;

  // LangFuse (secrets)
  LANGFUSE_PUBLIC_KEY: string;
  LANGFUSE_SECRET_KEY: string;
  LANGFUSE_BASE_URL?: string;

  // Credit flags (set via wrangler variable)
  CREDITS_ANTHROPIC?: string;
  CREDITS_OPENAI?: string;

  // Durable Objects
  CIRCUIT_BREAKER: DurableObjectNamespace;

  // Environment variables
  ENVIRONMENT: string;
}

// Provider types
export type LLMProvider = 'anthropic-direct' | 'openai-direct' | 'z-ai-pro' | 'openrouter';

// Circuit breaker state
export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerState {
  provider: LLMProvider;
  state: CircuitState;
  failureCount: number;
  lastFailureTime: number | null;
  nextAttemptTime: number | null;
}

// Hono context extensions
export interface Variables {
  client: ClientConfig;
  rateLimitKey: string;
  currentUsage: RateLimitUsage;
  requestBody: unknown;
  telemetry?: {
    startTime: number;
    provider: string;
    model: string;
    input: unknown;
  };
  responseData?: unknown;
}
