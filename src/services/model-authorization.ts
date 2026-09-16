import type { ClientConfig } from '../types';

/**
 * Decide whether a client may invoke a model.
 *
 * Semantics of ClientConfig.allowedModels:
 * - undefined (legacy records): all models allowed (backward compatible)
 * - []: no models allowed
 * - ['*']: all models allowed
 * - entry ending with '*': prefix match (e.g. 'gpt-4o*')
 * - otherwise: exact match
 */
export function isModelAllowedForClient(client: ClientConfig, model: string): boolean {
  const allowedModels = client.allowedModels;
  if (allowedModels === undefined) return true;
  if (allowedModels.length === 0) return false;

  for (const entry of allowedModels) {
    if (entry === '*') return true;
    if (entry.endsWith('*') && model.startsWith(entry.slice(0, -1))) return true;
    if (entry === model) return true;
  }

  return false;
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
