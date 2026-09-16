type AbortSignalLike = NonNullable<RequestInit['signal']>;

export interface AbortHandle {
  signal: AbortSignalLike;
  abort: () => void;
}

export function createAbortHandle(): AbortHandle | null {
  const ctor = (globalThis as { AbortController?: { new (): AbortHandle } }).AbortController;
  return ctor ? new ctor() : null;
}

export function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
