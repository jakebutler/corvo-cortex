import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../src/types';

const refreshAllModelCatalogs = vi.fn();
const syncOpenRouterCredits = vi.fn();

vi.mock('../../src/services/models-catalog', () => ({
  refreshAllModelCatalogs
}));

vi.mock('../../src/services/credits', () => ({
  syncOpenRouterCredits
}));

describe('index scheduled handler', () => {
  beforeEach(() => {
    refreshAllModelCatalogs.mockReset();
    syncOpenRouterCredits.mockReset();
    refreshAllModelCatalogs.mockResolvedValue(undefined);
    syncOpenRouterCredits.mockResolvedValue(null);
  });

  it('refreshes model catalogs and syncs OpenRouter credits on cron', async () => {
    const module = await import('../../src/index');
    const worker = module.default as { scheduled: (event: unknown, env: Env, ctx: unknown) => Promise<void> };
    const env = {} as Env;

    await worker.scheduled({}, env, {});

    expect(refreshAllModelCatalogs).toHaveBeenCalledWith(env);
    expect(syncOpenRouterCredits).toHaveBeenCalledWith(env);
  });
});
