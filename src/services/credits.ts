import type { Env, LLMProvider } from '../types';
import { ledgerIdForProvider } from '../durable-objects/credit-ledger';

export interface CreditBalance {
  balance: number;
  currency: 'USD' | 'credits';
  lastUpdated: string;
  configured: boolean;
}

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
