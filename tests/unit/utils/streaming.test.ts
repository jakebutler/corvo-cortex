import { describe, it, expect } from 'vitest';
import { createStreamingResponse, isStreamingResponse, parseSSEChunk } from '../../../src/utils/streaming';

describe('Streaming Utility', () => {
    describe('createStreamingResponse', () => {
        it('should create a streaming response with correct headers', async () => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('test'));
                    controller.close();
                }
            });
            const upstream = new Response(stream);

            const response = await createStreamingResponse(upstream);

            expect(response.status).toBe(200);
            expect(response.headers.get('Content-Type')).toBe('text/event-stream');
            expect(response.headers.get('Cache-Control')).toBe('no-cache');
            expect(response.headers.get('Connection')).toBe('keep-alive');
        });

        it('should pass through stream content', async () => {
            const encoder = new TextEncoder();
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode('data: test\n\n'));
                    controller.close();
                }
            });
            const upstream = new Response(stream);

            const response = await createStreamingResponse(upstream);
            const text = await response.text();

            expect(text).toBe('data: test\n\n');
        });

        it('should handle missing body', async () => {
            const upstream = new Response(null);
            const response = await createStreamingResponse(upstream);

            expect(response.status).toBe(500);
            expect(await response.text()).toBe('No response body');
        });
    });

    describe('isStreamingResponse', () => {
        it('should detect text/event-stream', () => {
            const headers = new Headers({ 'Content-Type': 'text/event-stream' });
            expect(isStreamingResponse(headers)).toBe(true);
        });

        it('should detect application/x-ndjson', () => {
            const headers = new Headers({ 'Content-Type': 'application/x-ndjson' });
            expect(isStreamingResponse(headers)).toBe(true);
        });

        it('should return false for json', () => {
            const headers = new Headers({ 'Content-Type': 'application/json' });
            expect(isStreamingResponse(headers)).toBe(false);
        });
    });

    describe('parseSSEChunk', () => {
        it('should extract data from SSE lines', () => {
            const chunk = 'data: {"foo":"bar"}\n\ndata: {"baz":"qux"}\n\n';
            const events = parseSSEChunk(chunk);

            expect(events).toHaveLength(2);
            expect(events[0]).toBe('{"foo":"bar"}');
            expect(events[1]).toBe('{"baz":"qux"}');
        });

        it('should ignore [DONE] message', () => {
            const chunk = 'data: {"foo":"bar"}\n\ndata: [DONE]\n\n';
            const events = parseSSEChunk(chunk);

            expect(events).toHaveLength(1);
            expect(events[0]).toBe('{"foo":"bar"}');
        });

        it('should ignore non-data lines', () => {
            const chunk = ': keep-alive\ndata: test\n\n';
            const events = parseSSEChunk(chunk);

            expect(events).toHaveLength(1);
            expect(events[0]).toBe('test');
        });
    });
});
