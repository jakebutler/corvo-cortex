import { describe, it, expect } from 'vitest';
import { generateRateLimitHeaders, setRateLimitHeaders } from '../../../src/utils/headers';
import type { ClientConfig, RateLimitUsage } from '../../../src/types';

describe('Headers Utility', () => {
    const mockClient: ClientConfig = {
        appId: 'test',
        name: 'Test',
        rateLimit: { requestsPerMinute: 100, tokensPerMinute: 1000 }
    };

    describe('generateRateLimitHeaders', () => {
        it('should calculate remaining requests and reset time', () => {
            const usage: RateLimitUsage = { requests: 10, tokens: 50 };
            const headers = generateRateLimitHeaders(mockClient, usage);

            expect(headers['RateLimit-Limit']).toBe('100');
            expect(headers['RateLimit-Remaining']).toBe('90'); // 100 - 10
            expect(headers['RateLimit-Used']).toBe('10');
            expect(headers['RateLimit-Reset']).toBeDefined();
        });

        it('should handle negative remaining as 0', () => {
            const usage: RateLimitUsage = { requests: 110, tokens: 50 };
            const headers = generateRateLimitHeaders(mockClient, usage);

            expect(headers['RateLimit-Remaining']).toBe('0');
        });
    });

    describe('setRateLimitHeaders', () => {
        it('should append headers to response', () => {
            const response = new Response('ok');
            const headers = {
                'RateLimit-Limit': '100',
                'RateLimit-Remaining': '90',
                'RateLimit-Reset': '1234567890',
                'RateLimit-Used': '10'
            };

            const newResponse = setRateLimitHeaders(response, headers);

            expect(newResponse.headers.get('RateLimit-Remaining')).toBe('90');
            expect(newResponse.headers.get('RateLimit-Limit')).toBe('100');
        });
    });
});
