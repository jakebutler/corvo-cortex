import type { Env, LLMProvider } from '../types';
import { ledgerIdForProvider } from '../durable-objects/credit-ledger';

export interface CreditBalance {
  balance: number;
  currency: 'USD' | 'credits';
  lastUpdated: string;
  configured: boolean;
}

export interface OpenRouterCreditSnapshot {
  totalCredits: number;
  totalUsage: number;
  remainingCredits: number;
  syncedAt: string;
}

const OPENROUTER_CREDITS_CACHE_KEY = 'credits:openrouter:snapshot';
const OPENROUTER_CREDITS_SYNC_TTL_MS = 60_000;

export async function getCreditBalance(env: Env, provider: LLMProvider): Promise<CreditBalance> {
  if (!env.CREDIT_LEDGER) {
    return {
      balance: 0,
      currency: 'USD',
      lastUpdated: new Date().toISOString(),
      configured: false
    };
  }
  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  const response = await stub.fetch(new Request('https://credit-ledger/balance', { method: 'GET' }));
  return await response.json() as CreditBalance;
}

export async function setCreditBalance(env: Env, provider: LLMProvider, balance: number, currency: 'USD' | 'credits'): Promise<CreditBalance> {
  if (!env.CREDIT_LEDGER) {
    throw new Error('Credit ledger not configured');
  }
  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  const response = await stub.fetch(new Request('https://credit-ledger/set', {
    method: 'POST',
    body: JSON.stringify({ balance, currency })
  }));
  return await response.json() as CreditBalance;
}

export async function adjustCreditBalance(env: Env, provider: LLMProvider, delta: number, currency?: 'USD' | 'credits'): Promise<CreditBalance> {
  if (!env.CREDIT_LEDGER) {
    throw new Error('Credit ledger not configured');
  }
  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  const response = await stub.fetch(new Request('https://credit-ledger/adjust', {
    method: 'POST',
    body: JSON.stringify({ delta, currency })
  }));
  return await response.json() as CreditBalance;
}

export async function deductCredits(env: Env, provider: LLMProvider, cost: number): Promise<{ ok: boolean; balance?: CreditBalance }>{
  if (!env.CREDIT_LEDGER) {
    return { ok: false };
  }
  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  const response = await stub.fetch(new Request('https://credit-ledger/deduct', {
    method: 'POST',
    body: JSON.stringify({ cost })
  }));

  if (!response.ok) {
    return { ok: false };
  }

  const balance = await response.json() as CreditBalance;
  return { ok: true, balance };
}

export async function markProviderCreditsExhausted(env: Env, provider: LLMProvider): Promise<void> {
  try {
    await setCreditBalance(env, provider, 0, 'USD');
  } catch {
    // Best-effort only; routing can still fallback on live upstream errors.
  }
}

export function isCreditExhaustionResponse(status: number, errorText: string): boolean {
  if (status === 402) {
    return true;
  }

  if (status !== 400 && status !== 403 && status !== 429) {
    return false;
  }

  const normalized = errorText.toLowerCase();
  return normalized.includes('insufficient credit')
    || normalized.includes('insufficient funds')
    || normalized.includes('credit balance')
    || normalized.includes('quota')
    || normalized.includes('billing')
    || normalized.includes('payment required');
}

export async function syncOpenRouterCreditsIfStale(env: Env): Promise<OpenRouterCreditSnapshot | null> {
  const cachedRaw = await env.CORTEX_CONFIG.get(OPENROUTER_CREDITS_CACHE_KEY, { type: 'json' }) as
    | { syncedAt?: string; totalCredits?: number; totalUsage?: number; remainingCredits?: number }
    | null;
  const syncedAtMs = cachedRaw?.syncedAt ? Date.parse(cachedRaw.syncedAt) : Number.NaN;

  if (Number.isFinite(syncedAtMs) && (Date.now() - syncedAtMs) < OPENROUTER_CREDITS_SYNC_TTL_MS) {
    return {
      totalCredits: cachedRaw?.totalCredits ?? 0,
      totalUsage: cachedRaw?.totalUsage ?? 0,
      remainingCredits: cachedRaw?.remainingCredits ?? 0,
      syncedAt: cachedRaw?.syncedAt || new Date().toISOString()
    };
  }

  return await syncOpenRouterCredits(env);
}

export async function syncOpenRouterCredits(env: Env): Promise<OpenRouterCreditSnapshot | null> {
  const provisioningKey = env.OPENROUTER_PROVISIONING_API_KEY || env.OPENROUTER_API_KEY;
  if (!provisioningKey) {
    return null;
  }

  let response: Response;
  try {
    response = await fetch('https://openrouter.ai/api/v1/credits', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${provisioningKey}`
      }
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const payload = await response.json() as {
    data?: { total_credits?: number; total_usage?: number };
  };

  const totalCredits = Number(payload?.data?.total_credits ?? 0);
  const totalUsage = Number(payload?.data?.total_usage ?? 0);
  if (!Number.isFinite(totalCredits) || !Number.isFinite(totalUsage)) {
    return null;
  }

  const remainingCredits = Math.max(totalCredits - totalUsage, 0);
  const syncedAt = new Date().toISOString();

  try {
    await setCreditBalance(env, 'openrouter', remainingCredits, 'credits');
  } catch {
    // If ledger write fails, still persist snapshot for observability.
  }

  const snapshot: OpenRouterCreditSnapshot = {
    totalCredits,
    totalUsage,
    remainingCredits,
    syncedAt
  };

  await env.CORTEX_CONFIG.put(OPENROUTER_CREDITS_CACHE_KEY, JSON.stringify(snapshot));
  return snapshot;
}
