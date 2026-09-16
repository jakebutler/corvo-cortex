import { describe, it, expect, beforeEach } from 'vitest';
import {
    isCreditExhaustionResponse,
    resetCreditExhaustionTracking,
    reserveCredits,
    settleCredits,
    markProviderCreditsExhausted,
    clearAllProviderExhaustion,
    getCreditBalance,
    setCreditBalance
} from '../../../src/services/credits';
import { createMockEnv } from '../../mocks/env';

describe('isCreditExhaustionResponse', () => {
    beforeEach(() => {
        resetCreditExhaustionTracking('anthropic-direct');
        resetCreditExhaustionTracking('openai-direct');
        resetCreditExhaustionTracking('minimax');
    });

    it('treats explicit 402 as credit exhaustion immediately', () => {
        expect(isCreditExhaustionResponse('anthropic-direct', 402, 'some error')).toBe(true);
    });

    it('does not treat a 400 mentioning quota as credit exhaustion', () => {
        expect(
            isCreditExhaustionResponse('anthropic-direct', 400, 'quota exceeded for input length')
        ).toBe(false);
        expect(
            isCreditExhaustionResponse('anthropic-direct', 400, 'billing cycle context limit')
        ).toBe(false);
        expect(
            isCreditExhaustionResponse('anthropic-direct', 400, 'credit balance is low')
        ).toBe(false);
    });

    it('requires 3 consecutive confirmed billing responses to flag exhaustion', () => {
        const provider = 'openai-direct';

        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(true);
    });

    it('breaks the consecutive-billing streak on a non-billing error', () => {
        const provider = 'minimax';

        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'context length exceeded')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
        expect(isCreditExhaustionResponse(provider, 400, 'insufficient credit')).toBe(false);
    });
});

describe('credit reservation flow', () => {
    it('reserves and settles against the ledger', async () => {
        const env = createMockEnv();
        await setCreditBalance(env, 'anthropic-direct', 1.0, 'USD');

        const reservation = await reserveCredits(env, 'anthropic-direct', 0.25);
        expect(reservation.ok).toBe(true);
        expect(reservation.reservationId).toBeDefined();

        const afterReserve = await getCreditBalance(env, 'anthropic-direct');
        expect(afterReserve.reserved).toBeCloseTo(0.25, 6);
        expect(afterReserve.available).toBeCloseTo(0.75, 6);

        const settle = await settleCredits(env, 'anthropic-direct', reservation.reservationId!, 0.1);
        expect(settle.ok).toBe(true);

        const afterSettle = await getCreditBalance(env, 'anthropic-direct');
        expect(afterSettle.balance).toBeCloseTo(0.9, 6);
        expect(afterSettle.reserved).toBe(0);
    });

    it('declines reservations exceeding the available floor', async () => {
        const env = createMockEnv();
        await setCreditBalance(env, 'anthropic-direct', 0.5, 'USD');

        const reservation = await reserveCredits(env, 'anthropic-direct', 0.9);

        expect(reservation.ok).toBe(false);
        expect(reservation.reason).toBe('insufficient');
    });

    it('marks exhaustion without zeroing the balance and recovers on sync', async () => {
        const env = createMockEnv();
        await setCreditBalance(env, 'anthropic-direct', 3.0, 'USD');

        await markProviderCreditsExhausted(env, 'anthropic-direct');

        const exhausted = await getCreditBalance(env, 'anthropic-direct');
        expect(exhausted.exhausted).toBe(true);
        expect(exhausted.balance).toBeCloseTo(3.0, 6);

        await clearAllProviderExhaustion(env);

        const recovered = await getCreditBalance(env, 'anthropic-direct');
        expect(recovered.exhausted).toBe(false);
        expect(recovered.balance).toBeCloseTo(3.0, 6);
    });
});
