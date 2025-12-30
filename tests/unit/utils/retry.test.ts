import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../../../src/utils/retry';

describe('fetchWithRetry', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        globalThis.fetch = vi.fn();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        vi.restoreAllMocks();
    });

    it('should return successful response immediately', async () => {
        const mockResponse = new Response('ok', { status: 200 });
        vi.mocked(globalThis.fetch).mockResolvedValue(mockResponse);

        const response = await fetchWithRetry('http://test.com', {});

        expect(response.status).toBe(200);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable status code (503)', async () => {
        const failureResponse = new Response('unavailable', { status: 503 });
        const successResponse = new Response('ok', { status: 200 });

        vi.mocked(globalThis.fetch)
            .mockResolvedValueOnce(failureResponse.clone())
            .mockResolvedValueOnce(successResponse);

        const response = await fetchWithRetry('http://test.com', {}, {
            baseDelay: 1 // Speed up test
        });

        expect(response.status).toBe(200);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should fail after max retries exceeded', async () => {
        const failureResponse = new Response('unavailable', { status: 503 });

        vi.mocked(globalThis.fetch).mockResolvedValue(failureResponse.clone());

        const response = await fetchWithRetry('http://test.com', {}, {
            maxRetries: 2,
            baseDelay: 1
        });

        expect(response.status).toBe(503);
        expect(globalThis.fetch).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should not retry on non-retryable status (400)', async () => {
        const failureResponse = new Response('bad request', { status: 400 });

        vi.mocked(globalThis.fetch).mockResolvedValue(failureResponse);

        const response = await fetchWithRetry('http://test.com', {});

        expect(response.status).toBe(400);
        expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('should retry on network error', async () => {
        const successResponse = new Response('ok', { status: 200 });

        vi.mocked(globalThis.fetch)
            .mockRejectedValueOnce(new Error('ECONNRESET: connection reset'))
            .mockResolvedValueOnce(successResponse);

        const response = await fetchWithRetry('http://test.com', {}, {
            baseDelay: 1
        });

        expect(response.status).toBe(200);
        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should throw error after max retries processing network errors', async () => {
        const error = new Error('ECONNRESET: connection reset');

        vi.mocked(globalThis.fetch).mockRejectedValue(error);

        await expect(fetchWithRetry('http://test.com', {}, {
            maxRetries: 2,
            baseDelay: 1
        })).rejects.toThrow('ECONNRESET');

        expect(globalThis.fetch).toHaveBeenCalledTimes(3);
    });

    it('should call onRetry callback', async () => {
        const failureResponse = new Response('unavailable', { status: 503 });
        const successResponse = new Response('ok', { status: 200 });
        const onRetry = vi.fn();

        vi.mocked(globalThis.fetch)
            .mockResolvedValueOnce(failureResponse.clone())
            .mockResolvedValueOnce(successResponse);

        await fetchWithRetry('http://test.com', {}, {
            baseDelay: 1,
            onRetry
        });

        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
    });
});
