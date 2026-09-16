import type { LLMProvider } from '../types';

interface CreditLedgerState {
  balance: number;
  currency: 'USD' | 'credits';
  lastUpdated: string;
  configured: boolean;
  reserved: number;
  exhaustedUntil: number | null;
}

interface Reservation {
  amount: number;
  expiresAt: number;
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

interface ReserveRequest {
  amount: number;
  ttlMs?: number;
}

interface SettleRequest {
  reservationId: string;
  actualCost: number;
}

interface MarkExhaustedRequest {
  ttlMs?: number;
}

const STATE_KEY = 'credit-ledger-state';
const RESERVATIONS_KEY = 'credit-ledger-reservations';
const DEFAULT_RESERVATION_TTL_MS = 600_000;
const DEFAULT_EXHAUSTION_TTL_MS = 900_000;

export class CreditLedger {
  private state: DurableObjectState;
  private queue: Promise<unknown>;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.queue = Promise.resolve();
  }

  async fetch(request: Request): Promise<Response> {
    const result = this.queue.then(() => this.handle(request));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'GET' && url.pathname === '/balance') {
      const current = await this.getLiveState();
      return this.json(this.toBalanceView(current));
    }

    if (method === 'POST' && url.pathname === '/set') {
      const body = await request.json() as SetRequest;
      if (typeof body.balance !== 'number' || !body.currency) {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getLiveState();
      const updated: CreditLedgerState = {
        ...current,
        balance: body.balance,
        currency: body.currency,
        lastUpdated: new Date().toISOString(),
        configured: true,
        exhaustedUntil: null
      };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(this.toBalanceView(updated));
    }

    if (method === 'POST' && url.pathname === '/adjust') {
      const body = await request.json() as AdjustRequest;
      if (typeof body.delta !== 'number') {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getLiveState();
      const updated: CreditLedgerState = {
        ...current,
        balance: current.balance + body.delta,
        currency: body.currency || current.currency,
        lastUpdated: new Date().toISOString(),
        configured: true
      };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(this.toBalanceView(updated));
    }

    if (method === 'POST' && url.pathname === '/deduct') {
      const body = await request.json() as DeductRequest;
      if (typeof body.cost !== 'number') {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getLiveState();
      if (current.balance - current.reserved < body.cost) {
        return this.json({ error: 'Insufficient credits' }, 402);
      }

      const updated: CreditLedgerState = {
        ...current,
        balance: current.balance - body.cost,
        lastUpdated: new Date().toISOString(),
        configured: true
      };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(this.toBalanceView(updated));
    }

    if (method === 'POST' && url.pathname === '/reserve') {
      const body = await request.json() as ReserveRequest;
      if (typeof body.amount !== 'number' || body.amount < 0) {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getLiveState();
      const now = Date.now();

      if (current.exhaustedUntil !== null && current.exhaustedUntil > now) {
        return this.json({
          error: 'Provider credits exhausted',
          exhaustedUntil: current.exhaustedUntil
        }, 402);
      }

      const available = current.balance - current.reserved;
      if (available < body.amount) {
        return this.json({
          error: 'Insufficient credits',
          available
        }, 402);
      }

      const reservations = await this.getReservations();
      const reservationId = createReservationId();
      const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0
        ? body.ttlMs
        : DEFAULT_RESERVATION_TTL_MS;
      // eslint-disable-next-line security/detect-object-injection
      reservations[reservationId] = { amount: body.amount, expiresAt: now + ttlMs };

      const updated: CreditLedgerState = {
        ...current,
        reserved: current.reserved + body.amount,
        lastUpdated: new Date().toISOString(),
        configured: true
      };

      await this.state.storage.put(STATE_KEY, updated);
      await this.state.storage.put(RESERVATIONS_KEY, reservations);

      return this.json({
        ok: true,
        reservationId,
        amount: body.amount,
        available: updated.balance - updated.reserved
      });
    }

    if (method === 'POST' && url.pathname === '/settle') {
      const body = await request.json() as SettleRequest;
      if (typeof body.reservationId !== 'string' || typeof body.actualCost !== 'number') {
        return this.json({ error: 'Invalid payload' }, 400);
      }

      const current = await this.getLiveState();
      const reservations = await this.getReservations();
      const reservation = reservations[body.reservationId];

      if (reservation) {
        delete reservations[body.reservationId];
        await this.state.storage.put(RESERVATIONS_KEY, reservations);
      }

      const updated: CreditLedgerState = {
        ...current,
        balance: current.balance - body.actualCost,
        reserved: Math.max(current.reserved - (reservation?.amount ?? 0), 0),
        exhaustedUntil: null,
        lastUpdated: new Date().toISOString(),
        configured: true
      };

      await this.state.storage.put(STATE_KEY, updated);

      return this.json({
        ok: true,
        reservationFound: Boolean(reservation),
        ...this.toBalanceView(updated)
      });
    }

    if (method === 'POST' && url.pathname === '/markExhausted') {
      let body: Partial<MarkExhaustedRequest> = {};
      try {
        body = await request.json() as Partial<MarkExhaustedRequest>;
      } catch {
        body = {};
      }
      const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0
        ? body.ttlMs
        : DEFAULT_EXHAUSTION_TTL_MS;

      const current = await this.getLiveState();
      const updated: CreditLedgerState = {
        ...current,
        exhaustedUntil: Date.now() + ttlMs,
        lastUpdated: new Date().toISOString()
      };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(this.toBalanceView(updated));
    }

    if (method === 'POST' && url.pathname === '/clearExhausted') {
      const current = await this.getLiveState();
      const updated: CreditLedgerState = {
        ...current,
        exhaustedUntil: null,
        lastUpdated: new Date().toISOString()
      };

      await this.state.storage.put(STATE_KEY, updated);
      return this.json(this.toBalanceView(updated));
    }

    return this.json({ error: 'Not found' }, 404);
  }

  private async getLiveState(): Promise<CreditLedgerState> {
    let current = await this.getState();
    const now = Date.now();

    const reservations = await this.getReservations();
    let staleReserved = 0;
    for (const [id, reservation] of Object.entries(reservations)) {
      if (reservation.expiresAt <= now) {
        staleReserved += reservation.amount;
        // eslint-disable-next-line security/detect-object-injection
        delete reservations[id];
      }
    }

    if (current.exhaustedUntil !== null && current.exhaustedUntil <= now) {
      current = { ...current, exhaustedUntil: null };
      await this.state.storage.put(STATE_KEY, current);
    }

    if (staleReserved > 0) {
      current = { ...current, reserved: Math.max(current.reserved - staleReserved, 0) };
      await this.state.storage.put(STATE_KEY, current);
      await this.state.storage.put(RESERVATIONS_KEY, reservations);
    }

    return current;
  }

  private async getState(): Promise<CreditLedgerState> {
    const stored = await this.state.storage.get<CreditLedgerState>(STATE_KEY);
    return stored || {
      balance: 0,
      currency: 'USD',
      lastUpdated: new Date().toISOString(),
      configured: false,
      reserved: 0,
      exhaustedUntil: null
    };
  }

  private async getReservations(): Promise<Record<string, Reservation>> {
    const stored = await this.state.storage.get<Record<string, Reservation>>(RESERVATIONS_KEY);
    return stored || {};
  }

  private toBalanceView(state: CreditLedgerState) {
    return {
      balance: state.balance,
      available: state.balance - state.reserved,
      reserved: state.reserved,
      currency: state.currency,
      lastUpdated: state.lastUpdated,
      configured: state.configured,
      exhausted: state.exhaustedUntil !== null && state.exhaustedUntil > Date.now()
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

function createReservationId(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }
  return `res-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
