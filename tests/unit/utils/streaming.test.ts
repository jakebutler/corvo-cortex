import { describe, it, expect } from 'vitest';
import { createStreamingResponseWithUsage, isStreamingResponse, parseSSEChunk } from '../../../src/utils/streaming';

describe('Streaming Utility', () => {
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

    describe('client cancel', () => {
        it('aborts the upstream reader and invokes onCancel when the client cancels', async () => {
            let upstreamCancelled = false;

            const upstream = new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('data: {"usage":{"total_tokens":1}}\n\n'));
                    // never closes on its own
                },
                cancel() {
                    upstreamCancelled = true;
                }
            }));

            let cancelCalled = false;
            const response = await createStreamingResponseWithUsage(upstream, {
                onCancel: async () => { cancelCalled = true; }
            });

            const reader = response.body!.getReader();
            await reader.read();
            await reader.cancel();

            await new Promise((resolve) => setTimeout(resolve, 20));

            expect(cancelCalled).toBe(true);
            expect(upstreamCancelled).toBe(true);
        });
    });
});
