import { describe, it, expect } from 'vitest';
import { createStreamingResponse, createStreamingResponseWithUsage, isStreamingResponse, parseSSEChunk } from '../../../src/utils/streaming';
import { anthropicAdapter } from '../../../src/providers/anthropic';

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

    describe('createStreamingResponseWithUsage — anthropic normalization', () => {
        it('normalizes anthropic SSE to OpenAI chunks, taps usage, and terminates with [DONE]', async () => {
            const anthropicSse = [
                'event: message_start',
                'data: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":21}}}',
                '',
                'event: content_block_delta',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
                '',
                'event: content_block_delta',
                'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
                '',
                'event: message_delta',
                'data: {"type":"message_delta","usage":{"output_tokens":7}}',
                '',
                'event: message_stop',
                'data: {"type":"message_stop"}',
                ''
            ].join('\n');

            const upstream = new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode(anthropicSse));
                    controller.close();
                }
            }));

            const chunks: string[] = [];
            const usageCalls: Array<{ prompt_tokens?: number; completion_tokens?: number }> = [];
            let doneCalled = false;

            const response = await createStreamingResponseWithUsage(upstream, {
                streamModel: 'claude-sonnet-4-6',
                transformStreamData: anthropicAdapter.transformStreamData.bind(anthropicAdapter),
                onChunk: (chunk) => chunks.push(chunk),
                onUsage: async (usage) => usageCalls.push(usage),
                onDone: async () => { doneCalled = true; }
            });

            const text = await response.text();
            const dataLines = text.split('\n').filter(line => line.startsWith('data: '));
            const jsonLines = dataLines.filter(line => line.slice(6) !== '[DONE]');
            const parsed = jsonLines.map(line => JSON.parse(line.slice(6)));

            expect(parsed[0].object).toBe('chat.completion.chunk');
            expect(parsed[0].model).toBe('claude-sonnet-4-6');
            expect(parsed[0].choices[0].delta.content).toBe('Hello');
            expect(parsed[1].choices[0].delta.content).toBe(' world');
            const finalChunk = parsed.find((chunk) => chunk.choices[0].finish_reason === 'stop');
            expect(finalChunk).toBeDefined();
            expect(dataLines[dataLines.length - 1].slice(6)).toBe('[DONE]');
            expect(doneCalled).toBe(true);

            expect(chunks.join('')).toBe('Hello world');

            expect(usageCalls.length).toBeGreaterThan(0);
            const finalUsage = usageCalls[usageCalls.length - 1];
            expect(finalUsage.prompt_tokens).toBe(21);
            expect(finalUsage.completion_tokens).toBe(7);
        });
    });
});
