import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROUTING_POLICY,
  getRoutingPolicy,
  getRoutingPolicyConfigKey,
  resolvePolicyRouteChain
} from '../../../src/services/routing-policy';
import { createMockEnv, createMockKV } from '../../mocks/env';

describe('routing policy', () => {
  it('uses environment-scoped config key', () => {
    const env = createMockEnv({ ENVIRONMENT: 'staging' });
    expect(getRoutingPolicyConfigKey(env)).toBe('routing:kinisi-hints:staging');
  });

  it('returns default policy when no KV policy exists', async () => {
    const env = createMockEnv({
      CORTEX_CONFIG: createMockKV(),
      ENVIRONMENT: 'test'
    });

    const policy = await getRoutingPolicy(env);

    expect(policy.version).toBe(DEFAULT_ROUTING_POLICY.version);
    expect(resolvePolicyRouteChain(policy, 'week_n', 'balanced')).toHaveLength(3);
  });

  it('returns kv policy when valid override exists', async () => {
    const key = 'routing:kinisi-hints:staging';
    const env = createMockEnv({
      ENVIRONMENT: 'staging',
      CORTEX_CONFIG: createMockKV({
        [key]: {
          ...DEFAULT_ROUTING_POLICY,
          version: 'override-v1',
          modelProfiles: {
            ...DEFAULT_ROUTING_POLICY.modelProfiles,
            fast_json_model: 'accounts/fireworks/models/override'
          }
        }
      })
    });

    const policy = await getRoutingPolicy(env);

    expect(policy.version).toBe('override-v1');
    expect(policy.modelProfiles.fast_json_model).toBe('accounts/fireworks/models/override');
  });

  it('falls back to default when kv policy is invalid', async () => {
    const key = 'routing:kinisi-hints:dev';
    const env = createMockEnv({
      ENVIRONMENT: 'dev',
      CORTEX_CONFIG: createMockKV({
        [key]: {
          version: 5,
          matrix: null
        }
      })
    });

    const policy = await getRoutingPolicy(env);

    expect(policy.version).toBe(DEFAULT_ROUTING_POLICY.version);
    expect(policy.enabled).toBe(true);
  });

  it('maps unspecified stage/strategy combos to balanced defaults', async () => {
    const env = createMockEnv();
    const policy = await getRoutingPolicy(env);

    const speedRoute = resolvePolicyRouteChain(policy, 'refine_week_1', 'speed');
    const balancedRoute = resolvePolicyRouteChain(policy, 'refine_week_1', 'balanced');

    expect(speedRoute).toEqual(balancedRoute);
  });
});
