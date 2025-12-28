import { MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { createTelemetryService } from '../services/telemetry';

declare module 'hono' {
  type ContextVariableMap = Variables;
}

/**
 * Request metadata for telemetry
 */
interface TelemetryMetadata {
  startTime: number;
  provider: string;
  model: string;
  input: unknown;
}

/**
 * Telemetry middleware
 * Tracks all LLM requests to LangFuse asynchronously
 */
export const telemetryMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const startTime = Date.now();
  const client = c.get('client');

  // Store telemetry metadata
  const metadata: TelemetryMetadata = {
    startTime,
    provider: '',
    model: '',
    input: null
  };

  c.set('telemetry', metadata);

  // Wait for request to complete
  await next();

  // Only track successful requests (non-error responses)
  if (c.res.status >= 400) {
    return;
  }

  const telemetry = c.get('telemetry');

  if (!telemetry?.provider || !telemetry.model) {
    return;
  }

  // Create telemetry service and log the request asynchronously
  c.executionCtx.waitUntil((async () => {
    try {
      const telemetryService = createTelemetryService(c.env);

      // Get usage data from response if available
      const output = c.get('responseData') as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } } | undefined;
      const usage = output?.usage;

      await telemetryService.createTrace({
        name: 'llm-completion',
        appId: client.appId,
        provider: telemetry.provider,
        model: telemetry.model,
        input: telemetry.input,
        output: output,
        startTime: telemetry.startTime,
        endTime: Date.now(),
        usage: usage ? {
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0
        } : undefined
      });

      // Log structured event
      telemetryService.logEvent({
        event: 'llm_request',
        appId: client.appId,
        provider: telemetry.provider,
        model: telemetry.model,
        metadata: {
          duration: Date.now() - telemetry.startTime,
          status: c.res.status,
          cost: usage ? telemetryService.estimateCost({
            provider: telemetry.provider,
            model: telemetry.model,
            promptTokens: usage.prompt_tokens || 0,
            completionTokens: usage.completion_tokens || 0
          }) : 0
        }
      });
    } catch (error) {
      console.error('Telemetry logging failed:', error);
    }
  })());
};

/**
 * Update telemetry metadata helper
 * Can be called from route handlers to set provider/model info
 */
export function updateTelemetryMetadata(
  c: { get: (key: string) => unknown; set: (key: string, value: unknown) => void },
  provider: string,
  model: string,
  input: unknown
): void {
  const existing = c.get('telemetry') as TelemetryMetadata | undefined;
  const metadata: TelemetryMetadata = {
    startTime: existing?.startTime || Date.now(),
    provider,
    model,
    input
  };
  c.set('telemetry', metadata);
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
