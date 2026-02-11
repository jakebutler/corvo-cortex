import type { Env } from '../types';

export const DEFAULT_LANGFUSE_BASE_URL = 'https://us.cloud.langfuse.com';
const INGEST_PATH = '/api/public/ingestion';

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
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
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
