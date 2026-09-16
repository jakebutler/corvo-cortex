import type { ClientConfig } from '../types';

/**
 * Generic allowlist matching shared by the per-client (#6) and routing-policy (#15)
 * model allowlists.
 *
 * Semantics:
 * - undefined: all models allowed (field absent)
 * - []: no models allowed
 * - ['*']: all models allowed
 * - entry ending with '*': prefix match (e.g. 'gpt-4o*')
 * - otherwise: exact match
 */
export function matchesModelAllowlist(allowedModels: string[] | undefined, model: string): boolean {
  if (allowedModels === undefined) return true;
  if (allowedModels.length === 0) return false;

  for (const entry of allowedModels) {
    if (entry === '*') return true;
    if (entry.endsWith('*') && model.startsWith(entry.slice(0, -1))) return true;
    if (entry === model) return true;
  }

  return false;
}

/**
 * Decide whether a client may invoke a model based on ClientConfig.allowedModels.
 */
export function isModelAllowedForClient(client: ClientConfig, model: string): boolean {
  return matchesModelAllowlist(client.allowedModels, model);
}

export function modelAuthorizationErrorPayload(model: string): {
  error: string;
  message: string;
  model: string;
} {
  return {
    error: 'Forbidden',
    message: `Model '${model}' is not permitted for this client`,
    model
  };
}
