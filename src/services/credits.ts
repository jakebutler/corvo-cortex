import type { Env, LLMProvider } from '../types';
import { ledgerIdForProvider } from '../durable-objects/credit-ledger';

export interface CreditBalance {
  balance: number;
  available: number;
  reserved: number;
  currency: 'USD' | 'credits';
  lastUpdated: string;
  configured: boolean;
  exhausted: boolean;
}

export interface CreditReservation {
  ok: boolean;
  reservationId?: string;
  available?: number;
  reason?: 'exhausted' | 'insufficient' | 'unconfigured' | 'error';
}

export interface OpenRouterCreditSnapshot {
  totalCredits: number;
  totalUsage: number;
  remainingCredits: number;
  syncedAt: string;
}

const OPENROUTER_CREDITS_CACHE_KEY = 'credits:openrouter:snapshot';
const OPENROUTER_CREDITS_SYNC_TTL_MS = 60_000;

const LEDGER_PROVIDERS: LLMProvider[] = [
  'anthropic-direct',
  'openai-direct',
  'z-ai-pro',
  'openrouter',
  'minimax',
  'fireworks',
  'digitalocean'
];

function ledgerRequestInit(path: string, body: unknown): Request {
  return new Request(`https://credit-ledger${path}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

export async function getCreditBalance(env: Env, provider: LLMProvider): Promise<CreditBalance> {
  if (!env.CREDIT_LEDGER) {
    return {
      balance: 0,
      available: 0,
      reserved: 0,
      currency: 'USD',
      lastUpdated: new Date().toISOString(),
      configured: false,
      exhausted: false
    };
  }
  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  const response = await stub.fetch(new Request('https://credit-ledger/balance', { method: 'GET' }));
  const payload = await response.json() as Partial<CreditBalance>;
  return {
    balance: payload.balance ?? 0,
    available: payload.available ?? payload.balance ?? 0,
    reserved: payload.reserved ?? 0,
    currency: payload.currency ?? 'USD',
    lastUpdated: payload.lastUpdated ?? new Date().toISOString(),
    configured: payload.configured ?? false,
    exhausted: payload.exhausted ?? false
  };
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
  const response = await stub.fetch(ledgerRequestInit('/deduct', { cost }));

  if (!response.ok) {
    return { ok: false };
  }

  const balance = await response.json() as CreditBalance;
  return { ok: true, balance };
}

export async function reserveCredits(
  env: Env,
  provider: LLMProvider,
  amount: number
): Promise<CreditReservation> {
  if (!env.CREDIT_LEDGER) {
    return { ok: false, reason: 'unconfigured' };
  }

  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  let response: Response;
  try {
    response = await stub.fetch(ledgerRequestInit('/reserve', { amount }));
  } catch {
    return { ok: false, reason: 'error' };
  }

  if (response.status === 402) {
    let payload: { error?: string } = {};
    try {
      payload = await response.json() as { error?: string };
    } catch {
      payload = {};
    }
    return {
      ok: false,
      reason: payload.error === 'Provider credits exhausted' ? 'exhausted' : 'insufficient'
    };
  }

  if (!response.ok) {
    return { ok: false, reason: 'error' };
  }

  const payload = await response.json() as { reservationId?: string; available?: number };
  if (!payload.reservationId) {
    return { ok: false, reason: 'error' };
  }

  return { ok: true, reservationId: payload.reservationId, available: payload.available };
}

export async function settleCredits(
  env: Env,
  provider: LLMProvider,
  reservationId: string,
  actualCost: number
): Promise<{ ok: boolean; balance?: CreditBalance }> {
  if (!env.CREDIT_LEDGER) {
    return { ok: false };
  }

  const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
  let response: Response;
  try {
    response = await stub.fetch(ledgerRequestInit('/settle', { reservationId, actualCost }));
  } catch {
    return { ok: false };
  }

  if (!response.ok) {
    return { ok: false };
  }

  const balance = await response.json() as CreditBalance;
  return { ok: true, balance };
}

export async function releaseCreditsReservation(
  env: Env,
  provider: LLMProvider,
  reservationId: string
): Promise<void> {
  try {
    await settleCredits(env, provider, reservationId, 0);
  } catch {
    // Reservation TTL will reclaim it if the ledger is unreachable.
  }
}

export async function markProviderCreditsExhausted(env: Env, provider: LLMProvider): Promise<void> {
  if (!env.CREDIT_LEDGER) return;
  try {
    const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
    await stub.fetch(ledgerRequestInit('/markExhausted', {}));
  } catch {
    // Best-effort only; routing can still fallback on live upstream errors.
  }
}

export async function clearProviderExhaustion(env: Env, provider: LLMProvider): Promise<void> {
  if (!env.CREDIT_LEDGER) return;
  try {
    const stub = env.CREDIT_LEDGER.get(env.CREDIT_LEDGER.idFromName(ledgerIdForProvider(provider)));
    await stub.fetch(ledgerRequestInit('/clearExhausted', {}));
  } catch {
    // Best-effort recovery; the exhaustion TTL is the fallback.
  }
}

export async function clearAllProviderExhaustion(env: Env): Promise<void> {
  await Promise.all(LEDGER_PROVIDERS.map((provider) => clearProviderExhaustion(env, provider)));
}

const STRONG_BILLING_SIGNALS = ['insufficient credit', 'insufficient funds', 'payment required'];
const EXHAUSTION_CONFIRMATIONS_REQUIRED = 3;
const EXHAUSTION_CONFIRMATION_WINDOW_MS = 60_000;

const exhaustionConfirmations = new Map<LLMProvider, { count: number; firstAt: number }>();

export function resetCreditExhaustionTracking(provider: LLMProvider): void {
  exhaustionConfirmations.delete(provider);
}

export function isCreditExhaustionResponse(provider: LLMProvider, status: number, errorText: string): boolean {
  if (status === 402) {
    exhaustionConfirmations.delete(provider);
    return true;
  }

  if (status !== 400 && status !== 403 && status !== 429) {
    return false;
  }

  const normalized = errorText.toLowerCase();
  const isStrongBillingSignal = STRONG_BILLING_SIGNALS.some((signal) => normalized.includes(signal));
  if (!isStrongBillingSignal) {
    exhaustionConfirmations.delete(provider);
    return false;
  }

  const now = Date.now();
  const existing = exhaustionConfirmations.get(provider);
  if (!existing || now - existing.firstAt > EXHAUSTION_CONFIRMATION_WINDOW_MS) {
    exhaustionConfirmations.set(provider, { count: 1, firstAt: now });
    return false;
  }

  existing.count += 1;
  return existing.count >= EXHAUSTION_CONFIRMATIONS_REQUIRED;
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
