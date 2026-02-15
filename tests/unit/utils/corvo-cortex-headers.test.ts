import { describe, expect, it } from 'vitest';
import {
  buildCorvoCortexHeaders,
  CORVO_CORTEX_HEADER_KEYS
} from '../../../src/utils/corvo-cortex-headers';

describe('buildCorvoCortexHeaders', () => {
  it('returns unknown placeholders when values are unavailable', () => {
    const headers = buildCorvoCortexHeaders({});

    expect(headers[CORVO_CORTEX_HEADER_KEYS.provider]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.model]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.routeId]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.fallbackUsed]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.hedgeUsed]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.cacheHit]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.ttftMs]).toBe('unknown');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.latencyMs]).toBe('unknown');
  });

  it('normalizes booleans and numbers to expected header values', () => {
    const headers = buildCorvoCortexHeaders({
      provider: 'fireworks',
      model: 'gpt-5-mini',
      routeId: 'route-1',
      fallbackUsed: false,
      hedgeUsed: true,
      cacheHit: false,
      ttftMs: 42.2,
      latencyMs: 199.8
    });

    expect(headers[CORVO_CORTEX_HEADER_KEYS.provider]).toBe('fireworks');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.model]).toBe('gpt-5-mini');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.routeId]).toBe('route-1');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.fallbackUsed]).toBe('false');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.hedgeUsed]).toBe('true');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.cacheHit]).toBe('false');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.ttftMs]).toBe('42');
    expect(headers[CORVO_CORTEX_HEADER_KEYS.latencyMs]).toBe('200');
  });
});
