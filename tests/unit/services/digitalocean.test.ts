import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    isExcludedFromDigitalOcean,
    mapDigitalOceanModel,
    resolveDigitalOceanModel,
    fetchDigitalOceanModels,
    syncDigitalOceanBalance,
    getDigitalOceanModelMapping,
    DEFAULT_DIGITALOCEAN_MODEL_MAPPING
} from '../../../src/services/digitalocean';
import { createMockEnv, createMockKV } from '../../mocks/env';
import { setCreditBalance, getCreditBalance } from '../../../src/services/credits';
import type { Env } from '../../../src/types';

const originalFetch = globalThis.fetch;

function createDoEnv(overrides: Partial<Env> = {}): Env {
    return createMockEnv({
        DIGITAL_OCEAN_MODEL_ACCESS_KEY: 'do-access-key',
        CREDITS_DIGITALOCEAN: 'true',
        ...overrides
    });
}

describe('mapDigitalOceanModel', () => {
    it('maps glm models to glm-5.3-flash via prefix', () => {
        expect(mapDigitalOceanModel('glm-4.7', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('glm-5.3-flash');
        expect(mapDigitalOceanModel('glm-5.3-flash', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('glm-5.3-flash');
    });

    it('supports exact entries so flash requests are not upgraded to the quality slug', () => {
        expect(mapDigitalOceanModel('glm-5.3', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('glm-5.3');
        expect(mapDigitalOceanModel('GLM-5.3', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('glm-5.3');
    });

    it('maps llama, deepseek, and mistral families', () => {
        expect(mapDigitalOceanModel('llama-4', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('llama-4-maverick');
        expect(mapDigitalOceanModel('deepseek-v3', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('deepseek-v4.1-flash');
        expect(mapDigitalOceanModel('mistral-large', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('mistral-3-14B');
    });

    it('returns undefined for unmapped models', () => {
        expect(mapDigitalOceanModel('qwen3.8-max', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBeUndefined();
    });

    it('NEVER maps OpenAI or Anthropic families to DO (hard exclusion, not KV-overridable)', () => {
        for (const model of ['gpt-4o', 'gpt-5.2', 'gpt-oss-120b', 'openai-gpt-oss-120b', 'o3', 'o4-mini', 'claude-sonnet-4-6', 'claude-opus-4-6', 'OpenAI/gpt-4o', 'anthropic/claude-sonnet-4-6']) {
            expect(mapDigitalOceanModel(model, DEFAULT_DIGITALOCEAN_MODEL_MAPPING), model).toBeUndefined();
            expect(isExcludedFromDigitalOcean(model), model).toBe(true);
        }
    });

    it('hard exclusion cannot be bypassed via KV mapping overrides', () => {
        const hostile = [{ match: 'gpt-', model: 'glm-5.3-flash' }, { match: 'claude', model: 'glm-5.3' }];
        expect(mapDigitalOceanModel('gpt-4o', hostile)).toBeUndefined();
        expect(mapDigitalOceanModel('claude-sonnet-4-6', hostile)).toBeUndefined();
    });

    it('strips vendor prefixes before matching', () => {
        expect(mapDigitalOceanModel('meta-llama/llama-4', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('llama-4-maverick');
    });

    it('is case-insensitive', () => {
        expect(mapDigitalOceanModel('GLM-4.7', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('glm-5.3-flash');
    });
});

describe('getDigitalOceanModelMapping', () => {
    it('uses defaults when no KV config exists', async () => {
        const env = createDoEnv({ CORTEX_CONFIG: createMockKV() });
        expect(await getDigitalOceanModelMapping(env)).toEqual(DEFAULT_DIGITALOCEAN_MODEL_MAPPING);
    });

    it('honours a KV override without a code change', async () => {
        const env = createDoEnv({
            CORTEX_CONFIG: createMockKV({
                'routing:digitalocean-models': [{ match: 'glm-', model: 'glm-5.3' }]
            })
        });

        const mappings = await getDigitalOceanModelMapping(env);
        expect(mappings).toEqual([{ match: 'glm-', model: 'glm-5.3' }]);
        expect(mapDigitalOceanModel('glm-4.7', mappings)).toBe('glm-5.3');
    });
});

describe('resolveDigitalOceanModel', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('bootstraps the catalog lazily on first use and routes identity matches', async () => {
        const env = createDoEnv({ CORTEX_CONFIG: createMockKV() });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [{ id: 'glm-5.3-flash' }, { id: 'qwen3.8-max' }]
        }), { status: 200 }));

        // Identity: qwen3.8-max has no mapping entry but exists in the DO catalog.
        expect(await resolveDigitalOceanModel(env, 'qwen3.8-max')).toBe('qwen3.8-max');
        expect(await resolveDigitalOceanModel(env, 'glm-4.7')).toBe('glm-5.3-flash');

        const stored = await env.CORTEX_CONFIG.get('models:digitalocean', { type: 'json' }) as { models: Array<{ id: string }> };
        expect(stored.models.map((m) => m.id).sort()).toEqual(['glm-5.3-flash', 'qwen3.8-max']);
    });

    it('trusts the mapping when catalog bootstrap is unavailable (no key / DO failure)', async () => {
        const env = createDoEnv({ CORTEX_CONFIG: createMockKV(), DIGITAL_OCEAN_MODEL_ACCESS_KEY: undefined });
        globalThis.fetch = vi.fn();

        expect(await resolveDigitalOceanModel(env, 'glm-4.7')).toBe('glm-5.3-flash');
        expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects mapped models absent from the current catalog (deprecation churn guard)', async () => {
        const env = createDoEnv({
            CORTEX_CONFIG: createMockKV({
                'models:digitalocean': {
                    updatedAt: new Date().toISOString(),
                    models: [{ id: 'glm-5.3-flash', provider: 'digitalocean' }]
                }
            })
        });

        expect(await resolveDigitalOceanModel(env, 'llama-4')).toBeUndefined();
        expect(await resolveDigitalOceanModel(env, 'glm-4.7')).toBe('glm-5.3-flash');
    });

    it('exclusion wins over identity matches in the catalog', async () => {
        const env = createDoEnv({
            CORTEX_CONFIG: createMockKV({
                'models:digitalocean': {
                    updatedAt: new Date().toISOString(),
                    models: [{ id: 'gpt-5.2', provider: 'digitalocean' }, { id: 'claude-sonnet-4-6', provider: 'digitalocean' }]
                }
            })
        });

        expect(await resolveDigitalOceanModel(env, 'gpt-5.2')).toBeUndefined();
        expect(await resolveDigitalOceanModel(env, 'claude-sonnet-4-6')).toBeUndefined();
    });
});

describe('fetchDigitalOceanModels', () => {
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('parses the /v1/models API response into records', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            data: [{ id: 'glm-5.3-flash', owned_by: 'zai' }, { id: 'llama-4-maverick' }]
        }), { status: 200 }));

        const models = await fetchDigitalOceanModels(createDoEnv());

        expect(models).toHaveLength(2);
        expect(models[0]).toMatchObject({ id: 'glm-5.3-flash', provider: 'digitalocean' });
    });

    it('returns no models when the key is missing or the API fails', async () => {
        globalThis.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
        expect(await fetchDigitalOceanModels(createDoEnv({ DIGITAL_OCEAN_MODEL_ACCESS_KEY: undefined }))).toEqual([]);
        expect(await fetchDigitalOceanModels(createDoEnv())).toEqual([]);
    });
});

describe('syncDigitalOceanBalance', () => {
    beforeEach(() => {
        globalThis.fetch = originalFetch;
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('no-ops when the balance token is not configured', async () => {
        const env = createDoEnv({ DIGITAL_OCEAN_BALANCE_TOKEN: undefined });
        expect(await syncDigitalOceanBalance(env)).toBeNull();
    });

    it('syncs the account balance into the digitalocean ledger', async () => {
        const env = createDoEnv({ DIGITAL_OCEAN_BALANCE_TOKEN: 'dop_v1_test' });
        globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ balance: '482.13' }), { status: 200 }));

        const snapshot = await syncDigitalOceanBalance(env);

        expect(snapshot).toMatchObject({ balance: 482.13 });
        const ledger = await getCreditBalance(env, 'digitalocean');
        expect(ledger.configured).toBe(true);
        expect(ledger.balance).toBeCloseTo(482.13, 6);
    });

    it('returns null on API failure without touching the ledger', async () => {
        const env = createDoEnv({ DIGITAL_OCEAN_BALANCE_TOKEN: 'dop_v1_test' });
        await setCreditBalance(env, 'digitalocean', 10, 'USD');

        globalThis.fetch = vi.fn().mockResolvedValue(new Response('denied', { status: 403 }));

        expect(await syncDigitalOceanBalance(env)).toBeNull();
        const ledger = await getCreditBalance(env, 'digitalocean');
        expect(ledger.balance).toBeCloseTo(10, 6);
    });
});
