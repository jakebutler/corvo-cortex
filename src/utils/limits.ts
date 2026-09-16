import type { Env } from '../types';

export const DEFAULT_MAX_BODY_BYTES = 2_097_152;
export const DEFAULT_MAX_TOKENS_CEILING = 32_768;

export function getMaxBodyBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_BODY_BYTES || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_BODY_BYTES;
  }
  return parsed;
}

export function getMaxTokensCeiling(env: Env): number {
  const parsed = Number.parseInt(env.MAX_TOKENS_CEILING || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_TOKENS_CEILING;
  }
  return parsed;
}
