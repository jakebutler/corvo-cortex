import { describe, it, expect } from 'vitest';
import { CreditLedger } from '../../../src/durable-objects/credit-ledger';

function createMockDoState(): DurableObjectState {
    const store = new Map<string, unknown>();
    return {
        storage: {
            get: async <T>(key: string) => store.get(key) as T,
            put: async (key: string, value: unknown) => {
                store.set(key, value);
            },
            delete: async (key: string) => {
                store.delete(key);
            }
        }
    } as unknown as DurableObjectState;
}

async function seedBalance(ledger: CreditLedger, balance: number): Promise<void> {
    await ledger.fetch(new Request('https://credit-ledger/set', {
        method: 'POST',
        body: JSON.stringify({ balance, currency: 'USD' })
    }));
}

async function getBalance(ledger: CreditLedger): Promise<{
    balance: number; available: number; reserved: number; exhausted: boolean;
}> {
    const response = await ledger.fetch(new Request('https://credit-ledger/balance'));
    return await response.json() as {
        balance: number; available: number; reserved: number; exhausted: boolean;
    };
}

function reserve(ledger: CreditLedger, amount: number, ttlMs?: number): Promise<Response> {
    return ledger.fetch(new Request('https://credit-ledger/reserve', {
        method: 'POST',
        body: JSON.stringify(ttlMs ? { amount, ttlMs } : { amount })
    }));
}

async function settle(ledger: CreditLedger, reservationId: string, actualCost: number): Promise<Response> {
    return ledger.fetch(new Request('https://credit-ledger/settle', {
        method: 'POST',
        body: JSON.stringify({ reservationId, actualCost })
    }));
}

describe('CreditLedger durable object', () => {
    it('caps concurrent reservations at the available floor', async () => {
        const ledger = new CreditLedger(createMockDoState());
        await seedBalance(ledger, 1.0);

        const results = await Promise.all(
            Array.from({ length: 10 }, () => reserve(ledger, 0.25))
        );

        const okResults = results.filter((r) => r.status === 200);
        const declined = results.filter((r) => r.status === 402);

        expect(okResults.length).toBe(4);
        expect(declined.length).toBe(6);

        const balance = await getBalance(ledger);
        expect(balance.reserved).toBeCloseTo(1.0, 6);
        expect(balance.available).toBeCloseTo(0, 6);
        expect(balance.balance).toBeCloseTo(1.0, 6);
    });

    it('settles actual costs and releases reservations without going below the floor via reserve', async () => {
        const ledger = new CreditLedger(createMockDoState());
        await seedBalance(ledger, 1.0);

        const reserveResponse = await reserve(ledger, 0.2);
        const { reservationId } = await reserveResponse.json() as { reservationId: string };

        await settle(ledger, reservationId, 0.05);

        const balance = await getBalance(ledger);
        expect(balance.balance).toBeCloseTo(0.95, 6);
        expect(balance.reserved).toBe(0);
        expect(balance.available).toBeCloseTo(0.95, 6);
    });

    it('blocks reservations while exhausted and recovers after clearExhausted', async () => {
        const ledger = new CreditLedger(createMockDoState());
        await seedBalance(ledger, 5.0);

        await ledger.fetch(new Request('https://credit-ledger/markExhausted', {
            method: 'POST',
            body: JSON.stringify({})
        }));

        let exhausted = await getBalance(ledger);
        expect(exhausted.exhausted).toBe(true);
        expect(exhausted.balance).toBeCloseTo(5.0, 6);

        const declined = await reserve(ledger, 0.1);
        expect(declined.status).toBe(402);
        const declinedPayload = await declined.json() as { error: string };
        expect(declinedPayload.error).toBe('Provider credits exhausted');

        await ledger.fetch(new Request('https://credit-ledger/clearExhausted', { method: 'POST', body: '{}' }));

        exhausted = await getBalance(ledger);
        expect(exhausted.exhausted).toBe(false);

        const accepted = await reserve(ledger, 0.1);
        expect(accepted.status).toBe(200);
    });

    it('releases stale reservations after their TTL expires', async () => {
        const ledger = new CreditLedger(createMockDoState());
        await seedBalance(ledger, 1.0);

        const first = await reserve(ledger, 0.9, 10);
        expect(first.status).toBe(200);

        const during = await reserve(ledger, 0.2);
        expect(during.status).toBe(402);

        await new Promise((resolve) => setTimeout(resolve, 30));

        const after = await reserve(ledger, 0.5);
        expect(after.status).toBe(200);

        const balance = await getBalance(ledger);
        expect(balance.reserved).toBeCloseTo(0.5, 6);
    });

    it('clears exhaustion and floors when an admin sets the balance', async () => {
        const ledger = new CreditLedger(createMockDoState());
        await seedBalance(ledger, 0);
        await ledger.fetch(new Request('https://credit-ledger/markExhausted', {
            method: 'POST',
            body: JSON.stringify({})
        }));

        await seedBalance(ledger, 10.0);

        const balance = await getBalance(ledger);
        expect(balance.balance).toBeCloseTo(10.0, 6);
        expect(balance.exhausted).toBe(false);
    });
});
