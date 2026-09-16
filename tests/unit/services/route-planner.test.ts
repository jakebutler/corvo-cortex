import { describe, expect, it } from 'vitest';
import { buildRoutePlan } from '../../../src/services/route-planner';
import { DEFAULT_ROUTING_POLICY } from '../../../src/services/routing-policy';
import type { KinisiRoutingHints } from '../../../src/types';

const baseHints: KinisiRoutingHints = {
  enabled: true,
  stage: 'week_n',
  strategy: 'speed',
  providerPrefer: ['fireworks', 'openrouter'],
  providerPreferExplicit: false,
  requestPriority: 'normal',
  requestRole: 'primary'
};

describe('buildRoutePlan', () => {
  it('uses x-kinisi-model over body model', () => {
    const plan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      requestedModel: 'gpt-5-mini'
    }, 'gpt-5');

    expect(plan.model).toBe('gpt-5-mini');
    expect(plan.candidates[0].model).toBe('gpt-5-mini');
  });

  it('respects explicit provider preference order', () => {
    const plan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      stage: 'week_1',
      strategy: 'balanced',
      providerPrefer: ['fireworks', 'openrouter'],
      providerPreferExplicit: true
    });

    expect(plan.candidates[0].provider).toBe('fireworks');
  });

  it('applies allow and block filters when they leave at least one candidate', () => {
    const plan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      providerAllow: ['openrouter'],
      providerBlock: ['fireworks']
    });

    expect(plan.candidates.every(candidate => candidate.provider === 'openrouter')).toBe(true);
    expect(plan.constraintsIgnored).toBe(false);
  });

  it('ignores conflicting constraints that eliminate all routes', () => {
    const plan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      providerAllow: ['fireworks'],
      providerBlock: ['fireworks']
    });

    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.constraintsIgnored).toBe(true);
  });

  it('maps unspecified combos to balanced defaults', () => {
    const speedPlan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      stage: 'refine_week_1',
      strategy: 'speed'
    });

    const balancedPlan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      stage: 'refine_week_1',
      strategy: 'balanced'
    });

    expect(speedPlan.candidates).toEqual(balancedPlan.candidates);
  });

  it('enables hedge only for week_n speed primary requests', () => {
    const enabledPlan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      stage: 'week_n',
      strategy: 'speed',
      requestRole: 'primary'
    });
    expect(enabledPlan.hedge.enabled).toBe(true);

    const disabledPlan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
      ...baseHints,
      stage: 'week_n',
      strategy: 'speed',
      requestRole: 'hedge'
    });
    expect(disabledPlan.hedge.enabled).toBe(false);
  });

  describe('policy model allowlist (#15)', () => {
    const allowlistPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      allowedModels: ['gpt-5-mini', 'glm-*']
    };

    it('honors a pinned model inside the policy allowlist', () => {
      const plan = buildRoutePlan(allowlistPolicy, {
        ...baseHints,
        requestedModel: 'glm-5.3-flash'
      });

      expect(plan.model).toBe('glm-5.3-flash');
      expect(plan.candidates[0].model).toBe('glm-5.3-flash');
      expect(plan.pinRejected).toBeUndefined();
    });

    it('falls back to the policy profile for a pinned model outside the allowlist (default)', () => {
      const plan = buildRoutePlan(allowlistPolicy, {
        ...baseHints,
        requestedModel: 'openai/gpt-5-pro'
      });

      expect(plan.model).toBeUndefined();
      expect(plan.candidates[0].model).toBe(allowlistPolicy.modelProfiles.fast_json_model);
      expect(plan.pinRejected).toBeUndefined();
    });

    it('marks the pin as rejected when allowClientModelPinning is false', () => {
      const strictPolicy = {
        ...allowlistPolicy,
        allowClientModelPinning: false
      };

      const plan = buildRoutePlan(strictPolicy, {
        ...baseHints,
        requestedModel: 'openai/gpt-5-pro'
      });

      expect(plan.pinRejected).toBe(true);
    });

    it('keeps honoring allowed pins when allowClientModelPinning is false', () => {
      const strictPolicy = {
        ...allowlistPolicy,
        allowClientModelPinning: false
      };

      const plan = buildRoutePlan(strictPolicy, {
        ...baseHints,
        requestedModel: 'gpt-5-mini'
      });

      expect(plan.model).toBe('gpt-5-mini');
      expect(plan.pinRejected).toBeUndefined();
    });

    it('allows all pins when no policy allowlist is configured (backward compatible)', () => {
      const plan = buildRoutePlan(DEFAULT_ROUTING_POLICY, {
        ...baseHints,
        requestedModel: 'whatever-expensive-model'
      });

      expect(plan.model).toBe('whatever-expensive-model');
      expect(plan.pinRejected).toBeUndefined();
    });
  });
});
