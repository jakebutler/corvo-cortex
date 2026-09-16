import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/types';

const refreshAllModelCatalogs = vi.fn();
const syncOpenRouterCredits = vi.fn();
const syncDigitalOceanBalance = vi.fn();

vi.mock('../../src/services/models-catalog', () => ({
  refreshAllModelCatalogs
}));

vi.mock('../../src/services/digitalocean', () => ({
  syncDigitalOceanBalance
}));

vi.mock('../../src/services/credits', () => ({
  syncOpenRouterCredits
}));

describe('index scheduled handler', () => {
  beforeEach(() => {
    refreshAllModelCatalogs.mockReset();
    syncOpenRouterCredits.mockReset();
    syncDigitalOceanBalance.mockReset();
    refreshAllModelCatalogs.mockResolvedValue(undefined);
    syncOpenRouterCredits.mockResolvedValue(null);
    syncDigitalOceanBalance.mockResolvedValue(null);
  });

  it('refreshes model catalogs and syncs OpenRouter credits on cron', async () => {
    const module = await import('../../src/index');
    const worker = module.default as { scheduled: (event: unknown, env: Env, ctx: unknown) => Promise<void> };
    const env = {} as Env;

    await worker.scheduled({}, env, {});

    expect(refreshAllModelCatalogs).toHaveBeenCalledWith(env, ['openai', 'anthropic', 'z-ai', 'minimax', 'openrouter', 'fireworks', 'gemini', 'digitalocean']);
    expect(syncOpenRouterCredits).toHaveBeenCalledWith(env);
    expect(syncDigitalOceanBalance).toHaveBeenCalledWith(env);
  });

  it('warns when the synced DigitalOcean balance is below the watchdog threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const module = await import('../../src/index');
    const worker = module.default as { scheduled: (event: unknown, env: Env, ctx: unknown) => Promise<void> };
    syncDigitalOceanBalance.mockResolvedValue({ balance: 42.5, syncedAt: new Date().toISOString() });

    const env = {
      CORTEX_CONFIG: { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
      ENVIRONMENT: 'test'
    } as unknown as Env;

    await worker.scheduled({}, env, {});

    const watchdogLines = warnSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('do-balance-watchdog'))
      .map((line) => JSON.parse(line) as { balance: number });

    expect(watchdogLines.length).toBe(1);
    expect(watchdogLines[0].balance).toBe(42.5);
    warnSpy.mockRestore();
  });
});
