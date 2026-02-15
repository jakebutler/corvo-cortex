import { describe, expect, it } from 'vitest';
import {
  KINISI_HEADER_NAMES,
  parseKinisiRoutingHints,
  resolveRequestedModel
} from '../../../src/services/routing-hints';

describe('parseKinisiRoutingHints', () => {
  it('keeps legacy mode disabled when no x-kinisi headers are present', () => {
    const headers = new Headers();
    const hints = parseKinisiRoutingHints(headers);

    expect(hints.enabled).toBe(false);
    expect(hints.stage).toBe('week_n');
    expect(hints.strategy).toBe('balanced');
    expect(hints.providerPrefer).toEqual(['fireworks', 'openrouter']);
    expect(hints.requestPriority).toBe('normal');
    expect(hints.requestRole).toBe('primary');
  });

  it('enables header-driven mode when any kinisi header is present', () => {
    const headers = new Headers({
      'x-kinisi-llm-stage': 'week_1'
    });

    const hints = parseKinisiRoutingHints(headers);

    expect(hints.enabled).toBe(true);
    expect(hints.stage).toBe('week_1');
  });

  it('falls back to defaults for invalid enum values', () => {
    const headers = new Headers({
      'x-kinisi-llm-stage': 'week_99',
      'x-kinisi-routing-strategy': 'turbo',
      'x-kinisi-request-priority': 'urgent',
      'x-kinisi-request-role': 'main'
    });

    const hints = parseKinisiRoutingHints(headers);

    expect(hints.stage).toBe('week_n');
    expect(hints.strategy).toBe('balanced');
    expect(hints.requestPriority).toBe('normal');
    expect(hints.requestRole).toBe('primary');
  });

  it('parses csv provider lists and filters unknown providers', () => {
    const headers = new Headers({
      'x-kinisi-provider-prefer': 'openrouter,fireworks,bad-provider',
      'x-kinisi-provider-allow': 'fireworks,bad-provider',
      'x-kinisi-provider-block': 'openrouter,other'
    });

    const hints = parseKinisiRoutingHints(headers);

    expect(hints.providerPrefer).toEqual(['openrouter', 'fireworks']);
    expect(hints.providerAllow).toEqual(['fireworks']);
    expect(hints.providerBlock).toEqual(['openrouter']);
  });

  it('parses max latency and requested model', () => {
    const headers = new Headers({
      'x-kinisi-max-latency-ms': '9500',
      'x-kinisi-model': 'accounts/fireworks/models/llama-v3p1-8b-instruct'
    });

    const hints = parseKinisiRoutingHints(headers);

    expect(hints.maxLatencyMs).toBe(9500);
    expect(hints.requestedModel).toBe('accounts/fireworks/models/llama-v3p1-8b-instruct');
  });

  it('uses x-kinisi-model before body model', () => {
    const hints = {
      enabled: true,
      stage: 'week_n',
      strategy: 'speed',
      providerPrefer: ['fireworks', 'openrouter'],
      requestPriority: 'normal',
      requestRole: 'primary',
      requestedModel: 'gpt-5-mini'
    } as const;

    expect(resolveRequestedModel(hints, 'gpt-5')).toBe('gpt-5-mini');
    expect(resolveRequestedModel({ ...hints, requestedModel: undefined }, 'gpt-5')).toBe('gpt-5');
  });

  it('exposes stable kinisi header names list', () => {
    expect(KINISI_HEADER_NAMES).toContain('x-kinisi-llm-stage');
    expect(KINISI_HEADER_NAMES).toContain('x-kinisi-model');
  });
});
