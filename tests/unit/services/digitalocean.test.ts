import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
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

    it('maps llama, deepseek, mistral, and gpt-oss families', () => {
        expect(mapDigitalOceanModel('llama-4', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('llama-4-maverick');
        expect(mapDigitalOceanModel('deepseek-v3', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('deepseek-v4.1-flash');
        expect(mapDigitalOceanModel('mistral-large', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('mistral-3-14B');
        expect(mapDigitalOceanModel('openai-gpt-oss-20b', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBe('openai-gpt-oss-120b');
    });

    it('returns undefined for unmapped models', () => {
        expect(mapDigitalOceanModel('gpt-4o', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBeUndefined();
        expect(mapDigitalOceanModel('claude-sonnet-4-6', DEFAULT_DIGITALOCEAN_MODEL_MAPPING)).toBeUndefined();
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
    it('trusts the mapping when no catalog has been fetched yet (bootstrap)', async () => {
        const env = createDoEnv({ CORTEX_CONFIG: createMockKV() });
        expect(await resolveDigitalOceanModel(env, 'glm-4.7')).toBe('glm-5.3-flash');
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
