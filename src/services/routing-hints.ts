import {
  requestPrioritySchema,
  requestRoleSchema,
  routingProviderSchema,
  routingStageSchema,
  routingStrategySchema
} from '../schemas/routing-hints';
import type { KinisiRoutingHints, RoutingProvider } from '../types';

export const KINISI_HEADER_NAMES = [
  'x-kinisi-llm-stage',
  'x-kinisi-routing-strategy',
  'x-kinisi-provider-prefer',
  'x-kinisi-provider-allow',
  'x-kinisi-provider-block',
  'x-kinisi-request-priority',
  'x-kinisi-max-latency-ms',
  'x-kinisi-request-role',
  'x-kinisi-model'
] as const;

const DEFAULT_PROVIDER_ORDER: RoutingProvider[] = ['fireworks', 'openrouter'];

export function parseKinisiRoutingHints(headers: Headers): KinisiRoutingHints {
  const enabled = hasAnyKinisiHeader(headers);

  const stage = routingStageSchema.safeParse(headers.get('x-kinisi-llm-stage') ?? '').success
    ? (headers.get('x-kinisi-llm-stage') as KinisiRoutingHints['stage'])
    : 'week_n';

  const strategy = routingStrategySchema.safeParse(headers.get('x-kinisi-routing-strategy') ?? '').success
    ? (headers.get('x-kinisi-routing-strategy') as KinisiRoutingHints['strategy'])
    : 'balanced';

  const requestPriority = requestPrioritySchema.safeParse(headers.get('x-kinisi-request-priority') ?? '').success
    ? (headers.get('x-kinisi-request-priority') as KinisiRoutingHints['requestPriority'])
    : 'normal';

  const requestRole = requestRoleSchema.safeParse(headers.get('x-kinisi-request-role') ?? '').success
    ? (headers.get('x-kinisi-request-role') as KinisiRoutingHints['requestRole'])
    : 'primary';

  const parsedProviderPrefer = parseProviderCsv(headers.get('x-kinisi-provider-prefer'));
  const providerPrefer = parsedProviderPrefer || DEFAULT_PROVIDER_ORDER;
  const providerAllow = parseProviderCsv(headers.get('x-kinisi-provider-allow'));
  const providerBlock = parseProviderCsv(headers.get('x-kinisi-provider-block'));

  const maxLatencyMs = parsePositiveInt(headers.get('x-kinisi-max-latency-ms'));
  const requestedModel = normalizeText(headers.get('x-kinisi-model'));

  return {
    enabled,
    stage,
    strategy,
    providerPrefer,
    providerPreferExplicit: !!parsedProviderPrefer,
    providerAllow,
    providerBlock,
    requestPriority,
    maxLatencyMs,
    requestRole,
    requestedModel
  };
}

export function resolveRequestedModel(hints: KinisiRoutingHints, bodyModel?: string): string | undefined {
  return hints.requestedModel || bodyModel;
}

function hasAnyKinisiHeader(headers: Headers): boolean {
  return KINISI_HEADER_NAMES.some((headerName) => normalizeText(headers.get(headerName)) !== undefined);
}

function parseProviderCsv(value: string | null): RoutingProvider[] | undefined {
  const raw = normalizeText(value);
  if (!raw) return undefined;

  const providers: RoutingProvider[] = [];
  const seen = new Set<RoutingProvider>();

  for (const token of raw.split(',')) {
    const normalizedToken = token.trim().toLowerCase();
    const parsed = routingProviderSchema.safeParse(normalizedToken);
    if (!parsed.success) continue;

    const provider = parsed.data;
    if (seen.has(provider)) continue;
    seen.add(provider);
    providers.push(provider);
  }

  return providers.length ? providers : undefined;
}

function normalizeText(value: string | null): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : undefined;
}

function parsePositiveInt(value: string | null): number | undefined {
  const normalized = normalizeText(value);
  if (!normalized) return undefined;
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}
