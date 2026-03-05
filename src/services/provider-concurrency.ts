import type { Env, LLMProvider } from '../types';

const CONCURRENCY_NAMESPACE = 'provider-concurrency-global';

const ZAI_MODEL_CONCURRENCY_LIMITS = new Map<string, number>([
  ['glm-4.6', 3],
  ['glm-4.6v-flashx', 3],
  ['glm-4.7', 5],
  ['glm-image', 1],
  ['glm-4.5', 10],
  ['glm-4.6v', 10],
  ['glm-4.7-flash', 1],
  ['glm-4.7-flashx', 3],
  ['glm-ocr', 1],
  ['glm-5', 3],
  ['glm-4-plus', 20],
  ['glm-4.5v', 10],
  ['glm-4.6v-flash', 1],
  ['autoglm-phone-multilingual', 5],
  ['glm-4.5-air', 5],
  ['glm-4.5-airx', 5],
  ['glm-4.5-flash', 2],
  ['glm-4-32b-0414-128k', 15],
  ['cogview-4-250304', 5],
  ['glm-asr-2512', 5],
  ['viduq1-text', 5],
  ['viduq1-image', 5],
  ['viduq1-start-end', 5],
  ['vidu2-image', 5],
  ['vidu2-start-end', 5],
  ['vidu2-reference', 5],
  ['cogvideox-3', 1]
]);

interface AcquireResponse {
  acquired: boolean;
  leaseId?: string;
  limit?: number;
  inFlight?: number;
}

export interface ProviderConcurrencyLease {
  leaseId: string;
  provider: LLMProvider;
  model: string;
  limit: number;
}

export type ProviderConcurrencyAcquireResult =
  | { allowed: true; lease?: ProviderConcurrencyLease }
  | { allowed: false; limit: number; inFlight: number };

export async function acquireProviderConcurrencyLease(
  env: Env,
  provider: LLMProvider,
  model: string
): Promise<ProviderConcurrencyAcquireResult> {
  if (provider !== 'z-ai-pro') {
    return { allowed: true };
  }

  const limit = getZaiModelConcurrencyLimit(model);
  if (!limit || !env.PROVIDER_CONCURRENCY) {
    return { allowed: true };
  }

  try {
    const stub = env.PROVIDER_CONCURRENCY.get(
      env.PROVIDER_CONCURRENCY.idFromName(CONCURRENCY_NAMESPACE)
    );

    const response = await stub.fetch(
      new Request('https://provider-concurrency/acquire', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          model: normalizeModelName(model),
          limit
        })
      })
    );

    const payload = await response.json() as AcquireResponse;
    if (!response.ok || !payload.acquired || !payload.leaseId) {
      if (response.status === 429 || payload.acquired === false) {
        return {
          allowed: false,
          limit: payload.limit ?? limit,
          inFlight: payload.inFlight ?? limit
        };
      }

      console.warn('Provider concurrency acquire failed, failing open for z-ai-pro.');
      return { allowed: true };
    }

    return {
      allowed: true,
      lease: {
        leaseId: payload.leaseId,
        provider,
        model: normalizeModelName(model),
        limit: payload.limit ?? limit
      }
    };
  } catch (error) {
    console.warn(
      'Provider concurrency acquire failed, failing open for z-ai-pro:',
      error instanceof Error ? error.message : String(error)
    );
    return { allowed: true };
  }
}

export async function releaseProviderConcurrencyLease(
  env: Env,
  lease?: ProviderConcurrencyLease
): Promise<void> {
  if (!lease || !env.PROVIDER_CONCURRENCY) {
    return;
  }

  try {
    const stub = env.PROVIDER_CONCURRENCY.get(
      env.PROVIDER_CONCURRENCY.idFromName(CONCURRENCY_NAMESPACE)
    );
    await stub.fetch(
      new Request('https://provider-concurrency/release', {
        method: 'POST',
        body: JSON.stringify({ leaseId: lease.leaseId })
      })
    );
  } catch (error) {
    console.warn(
      'Provider concurrency release failed for z-ai-pro:',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export function getZaiModelConcurrencyLimit(model: string): number | undefined {
  const normalized = normalizeModelName(model);
  return ZAI_MODEL_CONCURRENCY_LIMITS.get(normalized);
}

function normalizeModelName(model: string): string {
  return model.trim().toLowerCase();
}
