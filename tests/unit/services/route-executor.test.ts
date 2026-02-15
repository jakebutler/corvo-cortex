import { describe, expect, it } from 'vitest';
import {
  createFailureResult,
  createSuccessResult,
  executeRoutePlan
} from '../../../src/services/route-executor';
import type { RoutePlan } from '../../../src/services/route-planner';

function createPlan(overrides?: Partial<RoutePlan>): RoutePlan {
  return {
    routeId: 'route-1',
    stage: 'week_n',
    strategy: 'speed',
    requestPriority: 'normal',
    requestRole: 'primary',
    model: 'gpt-5-mini',
    candidates: [
      { provider: 'fireworks', model: 'model-a', modelProfile: 'fast_json_model' },
      { provider: 'openrouter', model: 'model-b', modelProfile: 'safe_json_model' }
    ],
    constraintsIgnored: false,
    hedge: { enabled: false, delayMs: 250 },
    retryPolicy: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 10 },
    maxLatencyMs: 5000,
    ...overrides
  };
}

describe('executeRoutePlan', () => {
  it('returns first successful candidate without fallback', async () => {
    const plan = createPlan();

    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate) => createSuccessResult({
        provider: candidate.provider,
        model: candidate.model,
        payload: { answer: 'ok' }
      })
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallbackUsed).toBe(false);
    expect(result.winner.provider).toBe('fireworks');
  });

  it('falls back when the first candidate fails terminally', async () => {
    const plan = createPlan();

    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate) => {
        if (candidate.provider === 'fireworks') {
          return createFailureResult('upstream_5xx', 'fireworks down', false);
        }
        return createSuccessResult({
          provider: candidate.provider,
          model: candidate.model,
          payload: { answer: 'fallback-ok' }
        });
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fallbackUsed).toBe(true);
    expect(result.winner.provider).toBe('openrouter');
  });

  it('retries retryable failures up to configured maxRetries', async () => {
    const plan = createPlan({
      retryPolicy: { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 }
    });

    let attemptCount = 0;
    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate) => {
        if (candidate.provider !== 'fireworks') {
          return createSuccessResult({
            provider: candidate.provider,
            model: candidate.model,
            payload: { answer: 'fallback-ok' }
          });
        }

        attemptCount += 1;
        if (attemptCount < 3) {
          return createFailureResult('timeout', 'timed out', true);
        }

        return createSuccessResult({
          provider: candidate.provider,
          model: candidate.model,
          payload: { answer: 'eventual-ok' }
        });
      }
    });

    expect(result.ok).toBe(true);
    expect(attemptCount).toBe(3);
  });

  it('returns route_exhausted with reason codes when all candidates fail', async () => {
    const plan = createPlan();

    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate) => {
        if (candidate.provider === 'fireworks') {
          return createFailureResult('upstream_5xx', 'provider failed', false);
        }
        return createFailureResult('schema_invalid', 'invalid schema', false);
      }
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errorClass).toBe('route_exhausted');
    expect(result.reasonCodes).toContain('upstream_5xx');
    expect(result.reasonCodes).toContain('schema_invalid');
  });
});
