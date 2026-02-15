export interface CorvoCortexHeaderInput {
  provider?: string;
  model?: string;
  routeId?: string;
  fallbackUsed?: boolean;
  hedgeUsed?: boolean;
  cacheHit?: boolean | 'unknown';
  ttftMs?: number;
  latencyMs?: number;
}

export const CORVO_CORTEX_HEADER_KEYS = {
  provider: 'x-corvo-cortex-provider',
  model: 'x-corvo-cortex-model',
  routeId: 'x-corvo-cortex-route-id',
  fallbackUsed: 'x-corvo-cortex-fallback-used',
  hedgeUsed: 'x-corvo-cortex-hedge-used',
  cacheHit: 'x-corvo-cortex-cache-hit',
  ttftMs: 'x-corvo-cortex-ttft-ms',
  latencyMs: 'x-corvo-cortex-latency-ms'
} as const;

export function buildCorvoCortexHeaders(input: CorvoCortexHeaderInput): Record<string, string> {
  return {
    [CORVO_CORTEX_HEADER_KEYS.provider]: normalizeText(input.provider),
    [CORVO_CORTEX_HEADER_KEYS.model]: normalizeText(input.model),
    [CORVO_CORTEX_HEADER_KEYS.routeId]: normalizeText(input.routeId),
    [CORVO_CORTEX_HEADER_KEYS.fallbackUsed]: normalizeBoolean(input.fallbackUsed),
    [CORVO_CORTEX_HEADER_KEYS.hedgeUsed]: normalizeBoolean(input.hedgeUsed),
    [CORVO_CORTEX_HEADER_KEYS.cacheHit]: normalizeCacheHit(input.cacheHit),
    [CORVO_CORTEX_HEADER_KEYS.ttftMs]: normalizeNumber(input.ttftMs),
    [CORVO_CORTEX_HEADER_KEYS.latencyMs]: normalizeNumber(input.latencyMs)
  };
}

function normalizeText(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : 'unknown';
}

function normalizeBoolean(value: boolean | undefined): string {
  if (value === undefined) return 'unknown';
  return value ? 'true' : 'false';
}

function normalizeCacheHit(value: boolean | 'unknown' | undefined): string {
  if (value === undefined || value === 'unknown') return 'unknown';
  return value ? 'true' : 'false';
}

function normalizeNumber(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 'unknown';
  }
  return String(Math.max(0, Math.round(value)));
}
