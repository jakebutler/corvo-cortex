import { Langfuse } from 'langfuse';
import type { Env } from '../types';

/**
 * Telemetry service for LangFuse integration
 */
export class TelemetryService {
  private langfuse: Langfuse | null = null;
  private publicKey: string;
  private secretKey: string;
  private baseUrl: string;

  constructor(env: Env) {
    this.publicKey = env.LANGFUSE_PUBLIC_KEY;
    this.secretKey = env.LANGFUSE_SECRET_KEY;
    this.baseUrl = env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com';

    // Initialize LangFuse client
    this.langfuse = new Langfuse({
      publicKey: this.publicKey,
      secretKey: this.secretKey,
      baseUrl: this.baseUrl
    });
  }

  /**
   * Create a trace for an LLM request
   */
  async createTrace(params: {
    name: string;
    appId: string;
    provider: string;
    model: string;
    input: unknown;
    output?: unknown;
    metadata?: Record<string, unknown>;
    startTime?: number;
    endTime?: number;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }): Promise<void> {
    if (!this.langfuse) {
      return;
    }

    try {
      const trace = this.langfuse.trace({
        name: params.name,
        metadata: {
          appId: params.appId,
          provider: params.provider,
          model: params.model,
          ...params.metadata
        }
      });

      // Create a generation span
      await trace.generation({
        model: params.model,
        input: params.input,
        output: params.output,
        usage: params.usage ? {
          input: params.usage.promptTokens,
          output: params.usage.completionTokens,
          total: params.usage.totalTokens
        } : undefined,
        startTime: params.startTime ? new Date(params.startTime) : undefined,
        endTime: params.endTime ? new Date(params.endTime) : undefined
      });

      // Flush asynchronously (non-blocking)
      this.langfuse.flushAsync();
    } catch (error) {
      // Log error but don't block the request
      console.error('LangFuse trace creation failed:', error);
    }
  }

  /**
   * Estimate cost for a request based on provider and model
   */
  estimateCost(params: {
    provider: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
  }): number {
    // Pricing per million tokens (as of 2024)
    const pricing: Record<string, Record<string, { input: number; output: number }>> = {
      'anthropic-direct': {
        'claude-3-5-sonnet': { input: 3.0, output: 15.0 },
        'claude-3-haiku': { input: 0.25, output: 1.25 },
        'claude-3-opus': { input: 15.0, output: 75.0 }
      },
      'openai-direct': {
        'gpt-4o': { input: 2.5, output: 10.0 },
        'gpt-4o-mini': { input: 0.15, output: 0.60 },
        'gpt-4-turbo': { input: 10.0, output: 30.0 }
      },
      'z-ai-pro': {
        'glm-4-plus': { input: 0.5, output: 0.5 },
        'glm-4': { input: 0.1, output: 0.1 }
      },
      'openrouter': {
        'default': { input: 1.0, output: 1.0 }
      }
    };

    // Get pricing for provider/model
    let modelPricing = pricing[params.provider]?.[params.model];

    // Fallback to default pricing if model not found
    if (!modelPricing) {
      if (params.provider === 'openrouter') {
        modelPricing = pricing['openrouter']['default'];
      } else {
        // Estimate default pricing
        modelPricing = { input: 1.0, output: 2.0 };
      }
    }

    const inputCost = (params.promptTokens / 1_000_000) * modelPricing.input;
    const outputCost = (params.completionTokens / 1_000_000) * modelPricing.output;

    return inputCost + outputCost;
  }

  /**
   * Log a structured event
   */
  logEvent(params: {
    event: string;
    appId: string;
    provider?: string;
    model?: string;
    metadata?: Record<string, unknown>;
  }): void {
    const logEntry = {
      timestamp: new Date().toISOString(),
      ...params
    };

    console.log(JSON.stringify(logEntry));
  }

  /**
   * Shutdown the LangFuse client
   */
  async shutdown(): Promise<void> {
    if (this.langfuse) {
      await this.langfuse.shutdownAsync();
    }
  }
}

/**
 * Create a telemetry service instance
 */
export function createTelemetryService(env: Env): TelemetryService {
  return new TelemetryService(env);
}
