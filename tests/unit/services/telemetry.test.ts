import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../../../src/services/telemetry';
import { Langfuse } from 'langfuse';
import type { Env } from '../../../src/types';

vi.mock('langfuse');

describe('Telemetry Service', () => {
    let service: TelemetryService;
    let mockEnv: Env;
    let mockConsole: any;
    let mockLangfuseInstance: any;
    let mockTrace: any;

    beforeEach(() => {
        mockEnv = {
            LANGFUSE_PUBLIC_KEY: 'pk-test',
            LANGFUSE_SECRET_KEY: 'sk-test',
            LANGFUSE_BASE_URL: 'https://test.langfuse.com'
        } as Env;

        // Setup mock Langfuse instance
        mockTrace = {
            generation: vi.fn().mockResolvedValue(undefined)
        };
        mockLangfuseInstance = {
            trace: vi.fn().mockReturnValue(mockTrace),
            flushAsync: vi.fn().mockResolvedValue(undefined),
            shutdownAsync: vi.fn().mockResolvedValue(undefined)
        };

        // Mock constructor behavior
        vi.mocked(Langfuse).mockImplementation(() => mockLangfuseInstance);

        service = new TelemetryService(mockEnv);

        // Spy on console
        mockConsole = {
            log: vi.fn(),
            error: vi.fn()
        };
        vi.stubGlobal('console', mockConsole);

        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    describe('estimateCost', () => {
        it('should estimate cost for GPT-4o', () => {
            const cost = service.estimateCost({
                provider: 'openai-direct',
                model: 'gpt-4o',
                promptTokens: 1000,
                completionTokens: 1000
            });
            expect(cost).toBeCloseTo(0.0125);
        });

        it('should estimate cost for Claude 3.5 Sonnet', () => {
            const cost = service.estimateCost({
                provider: 'anthropic-direct',
                model: 'claude-3-5-sonnet',
                promptTokens: 1000,
                completionTokens: 1000
            });
            expect(cost).toBeCloseTo(0.018);
        });

        it('should use default cost for unknown model in OpenRouter', () => {
            const cost = service.estimateCost({
                provider: 'openrouter',
                model: 'unknown-model',
                promptTokens: 1000,
                completionTokens: 1000
            });
            expect(cost).toBeCloseTo(0.002);
        });
    });

    describe('createTrace', () => {
        it('should create trace and generation', async () => {
            const params = {
                name: 'test-trace',
                appId: 'test-app',
                provider: 'openai',
                model: 'gpt-4o',
                input: 'test input',
                startTime: Date.now(),
                usage: {
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15
                }
            };

            await service.createTrace(params);

            expect(mockLangfuseInstance.trace).toHaveBeenCalledWith(expect.objectContaining({
                name: 'test-trace',
                metadata: expect.objectContaining({
                    appId: 'test-app',
                    provider: 'openai',
                    model: 'gpt-4o'
                })
            }));

            expect(mockTrace.generation).toHaveBeenCalledWith(expect.objectContaining({
                model: 'gpt-4o',
                input: 'test input',
                usage: {
                    input: 10,
                    output: 5,
                    total: 15
                }
            }));

            expect(mockLangfuseInstance.flushAsync).toHaveBeenCalled();
        });

        it('should handle errors gracefully', async () => {
            mockLangfuseInstance.trace.mockImplementationOnce(() => {
                throw new Error('Trace failed');
            });

            await service.createTrace({
                name: 'test',
                appId: 'test',
                provider: 'test',
                model: 'test',
                input: 'test'
            });

            expect(mockConsole.error).toHaveBeenCalledWith(
                expect.stringContaining('LangFuse trace creation failed'),
                expect.any(Error)
            );
        });
    });

    describe('logEvent', () => {
        it('should log event as JSON', () => {
            service.logEvent({
                event: 'test_event',
                appId: 'test',
                provider: 'openai',
                model: 'gpt-4o',
                metadata: { val: 1 }
            });

            expect(mockConsole.log).toHaveBeenCalledTimes(1);
            const logData = JSON.parse(mockConsole.log.mock.calls[0][0]);

            expect(logData.event).toBe('test_event');
            expect(logData.appId).toBe('test');
            expect(logData.metadata).toEqual({ val: 1 });
            expect(logData.timestamp).toBeDefined();
        });
    });
});
