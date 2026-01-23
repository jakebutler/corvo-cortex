import type { LLMProvider } from '../types';

interface CreditLedgerState {
  balance: number;
  currency: 'USD' | 'credits';
  lastUpdated: string;
  configured: boolean;
}

interface AdjustRequest {
  delta: number;
  currency?: 'USD' | 'credits';
}

interface SetRequest {
  balance: number;
  currency: 'USD' | 'credits';
}

interface DeductRequest {
  cost: number;
}

const STATE_KEY = 'credit-ledger-state';

export class CreditLedger {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/balance') {
      const current = await this.getState();
      return this.json(current);
    }

    if (method === 'POST' && url.pathname === '/set') {
      const body = await request.json() as SetRequest;
      if (typeof body.balance !== 'number' || !body.currency) {
        return this.json({ error: 'Invalid payload' }, 400);
      }

    const updated: CreditLedgerState = {
      balance: body.balance,
      currency: body.currency,
      lastUpdated: new Date().toISOString(),
      configured: true
    };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(updated);
    }

    if (method === 'POST' && url.pathname === '/adjust') {
      const body = await request.json() as AdjustRequest;
      if (typeof body.delta !== 'number') {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getState();
    const updated: CreditLedgerState = {
      balance: current.balance + body.delta,
      currency: body.currency || current.currency,
      lastUpdated: new Date().toISOString(),
      configured: true
    };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(updated);
    }

    if (method === 'POST' && url.pathname === '/deduct') {
      const body = await request.json() as DeductRequest;
      if (typeof body.cost !== 'number') {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getState();
      if (current.balance < body.cost) {
        return this.json({ error: 'Insufficient credits' }, 402);
      }

    const updated: CreditLedgerState = {
      balance: current.balance - body.cost,
      currency: current.currency,
      lastUpdated: new Date().toISOString(),
      configured: true
    };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(updated);
    }

    return this.json({ error: 'Not found' }, 404);
  }

  private async getState(): Promise<CreditLedgerState> {
    const stored = await this.state.storage.get<CreditLedgerState>(STATE_KEY);
    return stored || {
      balance: 0,
      currency: 'USD',
      lastUpdated: new Date().toISOString(),
      configured: false
    };
  }

  private json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

export function ledgerIdForProvider(provider: LLMProvider): string {
  return `credit-ledger:${provider}`;
}
