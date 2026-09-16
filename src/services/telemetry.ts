import type { Env, TelemetryMode } from '../types';

export const DEFAULT_LANGFUSE_BASE_URL = 'https://us.cloud.langfuse.com';
const INGEST_PATH = '/api/public/ingestion';

const REDACTIONS_CONFIG_KEY = 'config:telemetry-redactions';
const REDACTIONS_CACHE_TTL_MS = 60_000;
const MAX_PAYLOAD_CHARS = 50_000;
const REDACTED = '[REDACTED]';

const DEFAULT_REDACTION_PATTERNS: string[] = [
  'sk-[A-Za-z0-9_-]{8,}',
  'Bearer [A-Za-z0-9._~+/-]+=?',
  'x-api-key["\\s:=]+[A-Za-z0-9_-]{8,}'
];

let redactionCache: { patterns: RegExp[]; loadedAt: number } | null = null;

export async function getRedactionPatterns(env: Env): Promise<RegExp[]> {
  const now = Date.now();
  if (redactionCache && now - redactionCache.loadedAt < REDACTIONS_CACHE_TTL_MS) {
    return redactionCache.patterns;
  }

  let sources = DEFAULT_REDACTION_PATTERNS;
  try {
    const configured = env.CORTEX_CONFIG
      ? await env.CORTEX_CONFIG.get(REDACTIONS_CONFIG_KEY, { type: 'json' }) as unknown
      : null;
    if (Array.isArray(configured)) {
      const valid = configured
        .filter((entry): entry is string => typeof entry === 'string')
        .filter(source => isSafeRegex(source));
      if (valid.length > 0) {
        sources = valid;
      }
    }
  } catch {
    // fall back to built-in patterns
  }

  const patterns = sources
    .map(source => {
      try {
        // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
        // eslint-disable-next-line security/detect-non-literal-regexp
        return new RegExp(source, 'g');
      } catch {
        return null;
      }
    })
    .filter((pattern): pattern is RegExp => pattern !== null);

  redactionCache = { patterns, loadedAt: now };
  return patterns;
}

export function resetRedactionCacheForTests(): void {
  redactionCache = null;
}

function isSafeRegex(source: string): boolean {
  if (source.length > 256) return false;
  try {
    // nosemgrep: javascript.lang.security.audit.non-literal-regexp.non-literal-regexp
    // eslint-disable-next-line security/detect-non-literal-regexp
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

export function redactPayload(value: unknown, patterns: RegExp[], depth = 0): unknown {
  if (depth > 24) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') {
    let redacted = value;
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      redacted = redacted.replace(pattern, REDACTED);
    }
    return redacted;
  }
  if (Array.isArray(value)) {
    return value.map(item => redactPayload(item, patterns, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
      // eslint-disable-next-line security/detect-object-injection
      result[key] = redactPayload(source[key], patterns, depth + 1);
    }
    return result;
  }
  return value;
}

export function truncatePayload(value: unknown, maxChars = MAX_PAYLOAD_CHARS): unknown {
  if (value === undefined || value === null) return value;
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return { truncated: true, preview: String(value).slice(0, maxChars) };
  }
  if (serialized.length <= maxChars) return value;
  return {
    truncated: true,
    originalChars: serialized.length,
    preview: serialized.slice(0, maxChars)
  };
}

export function resolveTelemetryMode(mode: unknown): TelemetryMode {
  return mode === 'metadata' || mode === 'off' ? mode : 'full';
}

interface TraceUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface CreateTraceParams {
  name: string;
  appId: string;
  provider: string;
  model: string;
  input: unknown;
  output?: unknown;
  error?: string;
  statusCode: number;
  metadata?: Record<string, unknown>;
  startTime: number;
  endTime: number;
  costUsd?: number;
  usage?: TraceUsage;
}

interface LangfuseIngestionResponse {
  successes?: Array<{ id: string; status: number }>;
  errors?: Array<{ id?: string; message?: string }>;
}

/**
 * Telemetry service for Langfuse integration.
 * Uses direct ingestion API calls to avoid runtime differences across environments.
 */
export class TelemetryService {
  private static warnedMissingKeys = false;
  private static warnedDefaultBaseUrl = false;
  private readonly env: Env;

  constructor(env: Env) {
    this.env = env;
  }

  private resolveBaseUrl(): string {
    const configured = this.env.LANGFUSE_BASE_URL?.trim();
    if (configured) {
      return configured.replace(/\/+$/, '');
    }

    if (!TelemetryService.warnedDefaultBaseUrl) {
      TelemetryService.warnedDefaultBaseUrl = true;
      console.warn(
        `LANGFUSE_BASE_URL is not set. Falling back to ${DEFAULT_LANGFUSE_BASE_URL}.`
      );
    }

    return DEFAULT_LANGFUSE_BASE_URL;
  }

  private getAuthHeader(): string | null {
    const publicKey = this.env.LANGFUSE_PUBLIC_KEY;
    const secretKey = this.env.LANGFUSE_SECRET_KEY;

    if (!publicKey || !secretKey) {
      if (!TelemetryService.warnedMissingKeys) {
        TelemetryService.warnedMissingKeys = true;
        console.warn('Langfuse credentials are missing. Tracing is disabled for this isolate.');
      }
      return null;
    }

    return `Basic ${encodeBase64(`${publicKey}:${secretKey}`)}`;
  }

  async createTrace(params: CreateTraceParams): Promise<void> {
    const authHeader = this.getAuthHeader();
    if (!authHeader) {
      return;
    }

    try {
      const nowIso = new Date().toISOString();
      const traceId = createId();
      const generationId = createId();
      const durationMs = Math.max(params.endTime - params.startTime, 0);

      const ingestionPayload = {
        batch: [
          {
            id: createId(),
            type: 'trace-create',
            timestamp: nowIso,
            body: {
              id: traceId,
              timestamp: nowIso,
              name: params.name,
              input: params.input,
              output: params.output,
              metadata: {
                appId: params.appId,
                provider: params.provider,
                model: params.model,
                statusCode: params.statusCode,
                durationMs,
                costUsd: params.costUsd,
                error: params.error,
                ...params.metadata
              }
            }
          },
          {
            id: createId(),
            type: 'generation-create',
            timestamp: nowIso,
            body: {
              id: generationId,
              traceId,
              parentObservationId: null,
              name: 'provider-call',
              model: params.model,
              input: params.input,
              output: params.output,
              startTime: new Date(params.startTime).toISOString(),
              endTime: new Date(params.endTime).toISOString(),
              metadata: {
                appId: params.appId,
                provider: params.provider,
                statusCode: params.statusCode,
                error: params.error
              },
              usage: params.usage
                ? {
                  input: params.usage.promptTokens,
                  output: params.usage.completionTokens,
                  total: params.usage.totalTokens
                }
                : undefined
            }
          }
        ]
      };

      const response = await fetch(`${this.resolveBaseUrl()}${INGEST_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': authHeader
        },
        body: JSON.stringify(ingestionPayload)
      });

      if (!response.ok && response.status !== 207) {
        console.error('Langfuse ingestion failed:', response.status);
        return;
      }

      const result = await response.json() as LangfuseIngestionResponse;
      if (result.errors && result.errors.length > 0) {
        console.error('Langfuse ingestion returned errors:', result.errors);
      }
    } catch (error) {
      console.error('Langfuse trace creation failed:', error);
    }
  }
}

function createId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createTelemetryService(env: Env): TelemetryService {
  return new TelemetryService(env);
}

function encodeBase64(value: string): string {
  // eslint-disable-next-line no-undef
  return btoa(value);
}
