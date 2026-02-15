import type { Env, RoutingStage, RoutingStrategy } from '../types';
import type { RoutePolicyEntry, RoutingPolicy } from '../schemas/routing-policy';
import { routingPolicySchema } from '../schemas/routing-policy';

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  version: 'v1',
  enabled: true,
  modelProfiles: {
    fast_json_model: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
    balanced_json_model: 'openai/gpt-5-mini',
    quality_json_model: 'openai/gpt-5',
    safe_json_model: 'openai/gpt-5-mini'
  },
  matrix: {
    week_1: {
      speed: [
        { provider: 'fireworks', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ],
      balanced: [
        { provider: 'openrouter', modelProfile: 'balanced_json_model' },
        { provider: 'fireworks', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ],
      quality: [
        { provider: 'openrouter', modelProfile: 'quality_json_model' },
        { provider: 'fireworks', modelProfile: 'quality_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ]
    },
    week_n: {
      speed: [
        { provider: 'fireworks', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ],
      balanced: [
        { provider: 'fireworks', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'balanced_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ],
      quality: [
        { provider: 'openrouter', modelProfile: 'quality_json_model' },
        { provider: 'fireworks', modelProfile: 'quality_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ]
    },
    refine_week_1: {
      balanced: [
        { provider: 'openrouter', modelProfile: 'balanced_json_model' },
        { provider: 'fireworks', modelProfile: 'fast_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ],
      quality: [
        { provider: 'openrouter', modelProfile: 'quality_json_model' },
        { provider: 'fireworks', modelProfile: 'quality_json_model' },
        { provider: 'openrouter', modelProfile: 'safe_json_model' }
      ]
    }
  },
  hedge: {
    week_n_speed: true,
    week_1_speed: false,
    delayMs: 300
  },
  retryPolicies: {
    speed: {
      maxRetries: 1,
      baseDelayMs: 50,
      maxDelayMs: 300
    },
    balanced: {
      maxRetries: 2,
      baseDelayMs: 80,
      maxDelayMs: 1000
    },
    quality: {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 1500
    }
  },
  latencyBudgetsMs: {
    week_1: 45000,
    week_n: 8000,
    refine_week_1: 30000
  }
};

export function getRoutingPolicyConfigKey(env: Env): string {
  return `routing:kinisi-hints:${env.ENVIRONMENT || 'development'}`;
}

export async function getRoutingPolicy(env: Env): Promise<RoutingPolicy> {
  if (!env.CORTEX_CONFIG || typeof env.CORTEX_CONFIG.get !== 'function') {
    return DEFAULT_ROUTING_POLICY;
  }

  const key = getRoutingPolicyConfigKey(env);
  const raw = await env.CORTEX_CONFIG.get(key, { type: 'json' }) as unknown;
  if (!raw) {
    return DEFAULT_ROUTING_POLICY;
  }

  const parsed = routingPolicySchema.safeParse(raw);
  if (!parsed.success) {
    return DEFAULT_ROUTING_POLICY;
  }

  return parsed.data;
}

export function resolvePolicyRouteChain(
  policy: RoutingPolicy,
  stage: RoutingStage,
  strategy: RoutingStrategy
): RoutePolicyEntry[] {
  const defaultWeekNMatrix = DEFAULT_ROUTING_POLICY.matrix.week_n || { balanced: [] };
  const weekNMatrix = policy.matrix.week_n || defaultWeekNMatrix;
  const stageMatrix = resolveStageMatrix(policy, stage, weekNMatrix);
  const exact = resolveStrategyChain(stageMatrix, strategy);
  if (exact && exact.length > 0) {
    return exact;
  }

  const balanced = stageMatrix?.balanced;
  if (balanced && balanced.length > 0) {
    return balanced;
  }

  return weekNMatrix.balanced || defaultWeekNMatrix.balanced || [];
}

function resolveStageMatrix(
  policy: RoutingPolicy,
  stage: RoutingStage,
  fallback: NonNullable<RoutingPolicy['matrix']['week_n']>
) {
  switch (stage) {
    case 'week_1':
      return policy.matrix.week_1 || fallback;
    case 'refine_week_1':
      return policy.matrix.refine_week_1 || fallback;
    case 'week_n':
    default:
      return policy.matrix.week_n || fallback;
  }
}

function resolveStrategyChain(
  stageMatrix: NonNullable<RoutingPolicy['matrix']['week_n']>,
  strategy: RoutingStrategy
) {
  switch (strategy) {
    case 'speed':
      return stageMatrix.speed;
    case 'quality':
      return stageMatrix.quality;
    case 'balanced':
    default:
      return stageMatrix.balanced;
  }
}
