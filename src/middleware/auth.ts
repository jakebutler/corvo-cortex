import { MiddlewareHandler } from 'hono';
import type { Env, Variables, ClientConfig } from '../types';

declare module 'hono' {
  interface ContextVariableMap extends Variables {}
}

/**
 * Authentication middleware for API key validation
 *
 * Extracts Bearer token from Authorization header, validates against KV store,
 * and attaches client config to context.
 */
export const authMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  // 1. Extract API key from Authorization header
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey) {
    return c.json(
      { error: 'Unauthorized: Missing API key' },
      401
    );
  }

  // 2. Validate against KV store
  const clientData = await c.env.CORTEX_CLIENTS.get(apiKey, { type: 'json' }) as ClientConfig | null;

  if (!clientData) {
    return c.json(
      { error: 'Invalid API Key' },
      401
    );
  }

  // 3. Attach client data to context
  c.set('client', clientData);

  await next();
};

/**
 * Admin auth middleware for elevated privileges
 * Checks for admin flag in client config
 */
export const adminAuthMiddleware: MiddlewareHandler<{ Bindings: Env; Variables: Variables }> = async (c, next) => {
  const authHeader = c.req.header('Authorization');
  const apiKey = authHeader?.replace('Bearer ', '');

  if (!apiKey) {
    return c.json(
      { error: 'Unauthorized: Missing API key' },
      401
    );
  }

  const clientData = await c.env.CORTEX_CLIENTS.get(apiKey, { type: 'json' }) as ClientConfig & { admin?: boolean } | null;

  if (!clientData) {
    return c.json(
      { error: 'Invalid API Key' },
      401
    );
  }

  // Check if admin
  if (!clientData.admin) {
    return c.json(
      { error: 'Forbidden: Admin access required' },
      403
    );
  }

  c.set('client', clientData);

  await next();
};
