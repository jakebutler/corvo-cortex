import type { Context, MiddlewareHandler } from 'hono';
import type { Env, Variables } from '../types';
import { getMaxBodyBytes } from '../utils/limits';

export function requestBodyLimitMiddleware(): MiddlewareHandler<{ Bindings: Env; Variables: Variables }> {
  return async (c, next) => {
    const maxSize = getMaxBodyBytes(c.env);
    const contentLengthHeader = Number.parseInt(c.req.raw.headers.get('content-length') || '', 10);

    if (Number.isFinite(contentLengthHeader)) {
      if (contentLengthHeader > maxSize) {
        return rejectTooLarge(c, maxSize);
      }
      return next();
    }

    if (!c.req.raw.body) {
      return next();
    }

    const reader = c.req.raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxSize) {
        return rejectTooLarge(c, maxSize);
      }
      chunks.push(value);
    }

    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    c.req.raw = new Request(c.req.raw, { body });
    await next();
  };
}

function rejectTooLarge(c: Context<{ Bindings: Env; Variables: Variables }>, maxSize: number): Response {
  return c.json(
    { error: 'Request body too large', maxSizeBytes: maxSize },
    413
  );
}
