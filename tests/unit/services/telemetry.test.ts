import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelemetryService, DEFAULT_LANGFUSE_BASE_URL } from '../../../src/services/telemetry';
import type { Env } from '../../../src/types';

describe('Telemetry Service', () => {
  let mockEnv: Env;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (TelemetryService as unknown as { warnedMissingKeys: boolean }).warnedMissingKeys = false;
    (TelemetryService as unknown as { warnedDefaultBaseUrl: boolean }).warnedDefaultBaseUrl = false;

    mockEnv = {
      LANGFUSE_PUBLIC_KEY: 'pk-test',
      LANGFUSE_SECRET_KEY: 'sk-test',
      LANGFUSE_BASE_URL: 'https://test.langfuse.com',
      ENVIRONMENT: 'test'
    } as Env;

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ successes: [{ id: 'evt', status: 201 }], errors: [] }), {
        status: 207,
        headers: { 'Content-Type': 'application/json' }
      })
    );
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends trace and generation events via Langfuse ingestion API', async () => {
    const service = new TelemetryService(mockEnv);

    await service.createTrace({
      name: 'llm-request',
      appId: 'test-app',
      provider: 'openai-direct',
      model: 'gpt-4o',
      input: { messages: [{ role: 'user', content: 'hello' }] },
      output: { choices: [{ message: { content: 'hi' } }] },
      statusCode: 200,
      startTime: Date.now() - 100,
      endTime: Date.now(),
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      }
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://test.langfuse.com/api/public/ingestion');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual(expect.objectContaining({
      'Content-Type': 'application/json'
    }));

    const payload = JSON.parse(String(init?.body)) as { batch: Array<{ type: string; body: { metadata?: { appId?: string }; usage?: { total?: number } } }> };
    expect(payload.batch).toHaveLength(2);
    expect(payload.batch[0].type).toBe('trace-create');
    expect(payload.batch[0].body.metadata?.appId).toBe('test-app');
    expect(payload.batch[1].type).toBe('generation-create');
    expect(payload.batch[1].body.usage?.total).toBe(15);
  });

  it('falls back to US region if base URL is not configured and warns once', async () => {
    const service = new TelemetryService({
      ...mockEnv,
      LANGFUSE_BASE_URL: undefined
    } as Env);

    await service.createTrace({
      name: 'llm-request',
      appId: 'test-app',
      provider: 'openai-direct',
      model: 'gpt-4o',
      input: { messages: [] },
      statusCode: 200,
      startTime: Date.now() - 10,
      endTime: Date.now()
    });

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toBe(`${DEFAULT_LANGFUSE_BASE_URL}/api/public/ingestion`);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('LANGFUSE_BASE_URL is not set'));
  });

  it('does not send traces when credentials are missing', async () => {
    const service = new TelemetryService({
      ...mockEnv,
      LANGFUSE_PUBLIC_KEY: '',
      LANGFUSE_SECRET_KEY: ''
    } as Env);

    await service.createTrace({
      name: 'llm-request',
      appId: 'test-app',
      provider: 'openai-direct',
      model: 'gpt-4o',
      input: { messages: [] },
      statusCode: 200,
      startTime: Date.now() - 10,
      endTime: Date.now()
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('credentials are missing'));
  });

  it('logs ingestion errors from API response', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        successes: [],
        errors: [{ id: 'evt-1', message: 'bad payload' }]
      }), {
        status: 207,
        headers: { 'Content-Type': 'application/json' }
      })
    );

    const service = new TelemetryService(mockEnv);

    await service.createTrace({
      name: 'llm-request',
      appId: 'test-app',
      provider: 'openai-direct',
      model: 'gpt-4o',
      input: { messages: [] },
      statusCode: 500,
      startTime: Date.now() - 10,
      endTime: Date.now()
    });

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Langfuse ingestion returned errors:'),
      expect.any(Array)
    );
  });
});
