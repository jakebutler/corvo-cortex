import { describe, expect, it } from 'vitest';
import {
  createFailureResult,
  createSuccessResult,
  executeRoutePlan
} from '../../../src/services/route-executor';
import type { RoutePlan } from '../../../src/services/route-planner';

function createHedgePlan(overrides?: Partial<RoutePlan>): RoutePlan {
  return {
    routeId: 'route-hedge',
    stage: 'week_n',
    strategy: 'speed',
    requestPriority: 'normal',
    requestRole: 'primary',
    model: 'gpt-5-mini',
    candidates: [
      { provider: 'fireworks', model: 'model-a', modelProfile: 'fast_json_model' },
      { provider: 'openrouter', model: 'model-b', modelProfile: 'fast_json_model' },
      { provider: 'openrouter', model: 'model-c', modelProfile: 'safe_json_model' }
    ],
    constraintsIgnored: false,
    hedge: { enabled: true, delayMs: 25 },
    retryPolicy: { maxRetries: 0, baseDelayMs: 1, maxDelayMs: 10 },
    maxLatencyMs: 5000,
    ...overrides
  };
}

describe('executeRoutePlan hedging', () => {
  it('returns first schema-valid winner and marks hedge used', async () => {
    const plan = createHedgePlan();

    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate, context) => {
        if (context.role === 'primary') {
          await new Promise(resolve => setTimeout(resolve, 80));
        }

        if (candidate.provider === 'openrouter') {
          return createSuccessResult({
            provider: candidate.provider,
            model: candidate.model,
            payload: { answer: 'hedge-wins' }
          });
        }

        return createFailureResult('timeout', 'primary too slow', false);
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hedgeUsed).toBe(true);
    expect(result.winner.provider).toBe('openrouter');
    expect(result.winner.role).toBe('hedge');
  });

  it('does not hedge for non-primary request roles', async () => {
    const plan = createHedgePlan({ requestRole: 'hedge' });

    let seenHedgeRole = false;
    const result = await executeRoutePlan({
      plan,
      attempt: async (_candidate, context) => {
        if (context.role === 'hedge') {
          seenHedgeRole = true;
        }
        return createFailureResult('upstream_5xx', 'failed', false);
      }
    });

    expect(result.ok).toBe(false);
    expect(seenHedgeRole).toBe(false);
  });

  it('aborts the losing leg once a winner emerges', async () => {
    const plan = createHedgePlan();
    const legSignals: Record<string, { aborted: boolean }> = {};
    let primaryStarted = false;
    let primaryResolved = false;

    const result = await executeRoutePlan({
      plan,
      attempt: async (candidate, context) => {
        legSignals[candidate.provider] = context.signal as unknown as { aborted: boolean };

        if (candidate.provider === 'fireworks') {
          // Primary stays in flight past the hedge delay, then wins.
          await new Promise(resolve => setTimeout(resolve, 80));
          primaryResolved = true;
          return createSuccessResult({
            provider: candidate.provider,
            model: candidate.model,
            payload: { answer: 'primary-wins' }
          });
        }

        // Hedge hangs until aborted.
        while (!(context.signal as unknown as { aborted: boolean }).aborted) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        return createFailureResult('timeout', 'hedge aborted', true);
      }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.winner.provider).toBe('fireworks');
    expect(primaryResolved).toBe(true);
    expect(legSignals['openrouter']?.aborted).toBe(true);
  });
});
