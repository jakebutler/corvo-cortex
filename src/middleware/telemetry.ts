import { MiddlewareHandler } from 'hono';
import type { Env, Variables, LLMProvider } from '../types';
import { createTelemetryService } from '../services/telemetry';
import { estimateCostFromUsage } from '../services/pricing';

/**
 * Request metadata for telemetry
 */
interface TelemetryMetadata {
  startTime: number;
  provider: string;
  model: string;
  input: unknown;
  completion: Promise<void>;
  deferCompletion: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * Telemetry middleware
 * Tracks all LLM requests to Langfuse asynchronously.
 * Tracing is fail-open and must never block user responses.
 */
export const telemetryMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const startTime = Date.now();

  // Store telemetry metadata
  const metadata: TelemetryMetadata = {
    startTime,
    provider: 'unresolved',
    model: 'unknown',
    input: c.get('requestBody') ?? null,
    completion: Promise.resolve(),
    deferCompletion: false,
    metadata: {}
  };

  c.set('telemetry', metadata);

  // Wait for request to complete
  await next();

  const telemetry = c.get('telemetry');
  if (!telemetry) {
    return;
  }

  // Create telemetry trace asynchronously and also await completion once.
  // This guarantees ingestion even if runtime waitUntil scheduling is unreliable.
  const traceTask = (async () => {
    try {
      await telemetry.completion;

      const client = c.get('client');
      const telemetryService = createTelemetryService(c.env);

      let output = c.get('responseData') as unknown;
      if (output === undefined) {
        output = await extractResponseData(c.res);
      }

      const usage = getUsageFromContext(c) ?? getUsageFromOutput(output);
      let costUsd: number | undefined;

      if (usage && isKnownProvider(telemetry.provider)) {
        costUsd = await estimateCostFromUsage({
          env: c.env,
          provider: telemetry.provider,
          model: telemetry.model,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0
        });
      }

      await telemetryService.createTrace({
        name: 'llm-request',
        appId: client?.appId || 'unknown-app',
        provider: telemetry.provider,
        model: telemetry.model,
        input: telemetry.input,
        output: output,
        error: c.res.status >= 400 ? getErrorMessage(output) : undefined,
        statusCode: c.res.status,
        startTime: telemetry.startTime,
        endTime: Date.now(),
        costUsd,
        metadata: {
          environment: c.env.ENVIRONMENT,
          ...(telemetry.metadata || {})
        },
        usage: usage ? {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0
        } : undefined
      });
    } catch (error) {
      console.error('Telemetry logging failed:', error);
    }
  })();

  c.executionCtx.waitUntil(traceTask);
  if (!telemetry.deferCompletion) {
    await traceTask;
  }
};

/**
 * Update telemetry metadata helper
 * Can be called from route handlers to set provider/model info
 */
export function updateTelemetryMetadata(
  c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  provider: string,
  model: string,
  input: unknown,
  extraMetadata?: Record<string, unknown>
): void {
  const existing = c.get('telemetry') as TelemetryMetadata | undefined;
  const nextMetadata: TelemetryMetadata = {
    startTime: existing?.startTime || Date.now(),
    provider: provider || existing?.provider || 'unresolved',
    model: model || existing?.model || 'unknown',
    input: input ?? existing?.input ?? null,
    completion: existing?.completion || Promise.resolve(),
    deferCompletion: existing?.deferCompletion || false,
    metadata: {
      ...(existing?.metadata || {}),
      ...(extraMetadata || {})
    }
  };
  c.set('telemetry', nextMetadata);
}

/**
 * Store response data for telemetry
 */
export function storeResponseData(
  c: { set: (key: string, value: unknown) => void },
  data: unknown
): void {
  c.set('responseData', data);
}

/**
 * Store token usage extracted from streaming or non-streaming responses.
 */
export function storeTelemetryUsage(
  c: { set: (key: string, value: unknown) => void },
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
): void {
  c.set('telemetryUsage', usage);
}

/**
 * Set a completion promise for telemetry finalization.
 * Used by streaming responses to delay trace flush until stream completion.
 */
export function setTelemetryCompletion(
  c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  completion: Promise<void>
): void {
  const existing = c.get('telemetry') as TelemetryMetadata | undefined;
  const metadata: TelemetryMetadata = {
    startTime: existing?.startTime || Date.now(),
    provider: existing?.provider || 'unresolved',
    model: existing?.model || 'unknown',
    input: existing?.input ?? null,
    completion,
    deferCompletion: true,
    metadata: existing?.metadata || {}
  };
  c.set('telemetry', metadata);
}

function isKnownProvider(provider: string): provider is LLMProvider {
  const knownProviders = new Set<LLMProvider>([
    'anthropic-direct',
    'openai-direct',
    'z-ai-pro',
    'openrouter',
    'minimax',
    'fireworks'
  ]);
  return knownProviders.has(provider as LLMProvider);
}

function getUsageFromContext(
  c: { get: (key: string) => unknown }
): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
  return c.get('telemetryUsage') as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;
}

function getUsageFromOutput(
  output: unknown
): { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined {
  if (!output || typeof output !== 'object') {
    return undefined;
  }

  const outputRecord = output as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  const usage = outputRecord.usage;
  if (!usage || typeof usage !== 'object') {
    return undefined;
  }

  return usage;
}

async function extractResponseData(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    return undefined;
  }

  try {
    const responseClone = response.clone();
    if (contentType.includes('application/json')) {
      return await responseClone.json();
    }

    const text = await responseClone.text();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function getErrorMessage(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output;
  }

  if (!output || typeof output !== 'object') {
    return undefined;
  }

  const outputRecord = output as { error?: unknown; details?: unknown; message?: unknown };
  const errorValue = outputRecord.error || outputRecord.details || outputRecord.message;
  if (typeof errorValue === 'string') {
    return errorValue;
  }

  if (errorValue !== undefined) {
    return JSON.stringify(errorValue);
  }

  return undefined;
}
