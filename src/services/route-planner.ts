import type { RoutePolicyEntry, RoutingPolicy } from '../schemas/routing-policy';
import { resolveRequestedModel } from './routing-hints';
import { resolvePolicyRouteChain } from './routing-policy';
import type {
  KinisiRoutingHints,
  RequestPriority,
  RequestRole,
  RoutingProvider,
  RoutingStage,
  RoutingStrategy
} from '../types';

export interface PlannedRouteCandidate {
  provider: RoutingProvider;
  model: string;
  modelProfile: RoutePolicyEntry['modelProfile'];
}

export interface RoutePlan {
  routeId: string;
  stage: RoutingStage;
  strategy: RoutingStrategy;
  requestPriority: RequestPriority;
  requestRole: RequestRole;
  model?: string;
  candidates: PlannedRouteCandidate[];
  constraintsIgnored: boolean;
  hedge: {
    enabled: boolean;
    delayMs: number;
  };
  retryPolicy: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
  maxLatencyMs: number;
}

export function buildRoutePlan(
  policy: RoutingPolicy,
  hints: KinisiRoutingHints,
  bodyModel?: string
): RoutePlan {
  const routeChain = resolvePolicyRouteChain(policy, hints.stage, hints.strategy);
  const requestedModel = resolveRequestedModel(hints, bodyModel);

  const baseCandidates = routeChain.map((entry) => buildCandidate(policy, entry, requestedModel));
  const constrainedCandidates = applyProviderConstraints(baseCandidates, hints);

  const hasConstraints = Boolean((hints.providerAllow && hints.providerAllow.length) || (hints.providerBlock && hints.providerBlock.length));
  const constraintsIgnored = hasConstraints && constrainedCandidates.length === 0;

  const selectedCandidates = applyProviderPreference(
    constrainedCandidates.length > 0 ? constrainedCandidates : baseCandidates,
    hints
  );

  const retryPolicy = policy.retryPolicies[hints.strategy]
    || policy.retryPolicies.balanced
    || { maxRetries: 1, baseDelayMs: 100, maxDelayMs: 1000 };
  const maxLatencyMs = hints.maxLatencyMs
    || policy.latencyBudgetsMs[hints.stage]
    || policy.latencyBudgetsMs.week_n
    || 8000;

  return {
    routeId: createRouteId(),
    stage: hints.stage,
    strategy: hints.strategy,
    requestPriority: hints.requestPriority,
    requestRole: hints.requestRole,
    model: requestedModel,
    candidates: selectedCandidates,
    constraintsIgnored,
    hedge: {
      enabled: isHedgeEnabled(policy, hints),
      delayMs: policy.hedge.delayMs
    },
    retryPolicy,
    maxLatencyMs
  };
}

function buildCandidate(
  policy: RoutingPolicy,
  entry: RoutePolicyEntry,
  requestedModel?: string
): PlannedRouteCandidate {
  return {
    provider: entry.provider,
    model: requestedModel
      || policy.modelProfiles[entry.modelProfile]
      || policy.modelProfiles.safe_json_model
      || 'gpt-5-mini',
    modelProfile: entry.modelProfile
  };
}

function applyProviderConstraints(
  candidates: PlannedRouteCandidate[],
  hints: KinisiRoutingHints
): PlannedRouteCandidate[] {
  let filtered = [...candidates];

  if (hints.providerAllow && hints.providerAllow.length > 0) {
    const allowSet = new Set(hints.providerAllow);
    filtered = filtered.filter(candidate => allowSet.has(candidate.provider));
  }

  if (hints.providerBlock && hints.providerBlock.length > 0) {
    const blockSet = new Set(hints.providerBlock);
    filtered = filtered.filter(candidate => !blockSet.has(candidate.provider));
  }

  return filtered;
}

function applyProviderPreference(
  candidates: PlannedRouteCandidate[],
  hints: KinisiRoutingHints
): PlannedRouteCandidate[] {
  if (!hints.providerPreferExplicit) {
    return candidates;
  }

  const priority = new Map<RoutingProvider, number>();
  hints.providerPrefer.forEach((provider, index) => {
    priority.set(provider, index);
  });

  return [...candidates].sort((left, right) => {
    const leftPriority = priority.get(left.provider);
    const rightPriority = priority.get(right.provider);

    if (leftPriority === undefined && rightPriority === undefined) return 0;
    if (leftPriority === undefined) return 1;
    if (rightPriority === undefined) return -1;
    return leftPriority - rightPriority;
  });
}

function isHedgeEnabled(policy: RoutingPolicy, hints: KinisiRoutingHints): boolean {
  if (hints.requestRole !== 'primary') {
    return false;
  }

  if (hints.stage === 'week_n' && hints.strategy === 'speed') {
    return policy.hedge.week_n_speed;
  }

  if (hints.stage === 'week_1' && hints.strategy === 'speed') {
    return policy.hedge.week_1_speed;
  }

  return false;
}

function createRouteId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
