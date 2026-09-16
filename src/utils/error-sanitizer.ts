export interface UpstreamErrorEnvelope {
  provider: string;
  status: number;
  class: string;
}

const STATUS_CLASSES: Array<[number, string]> = [
  [400, 'bad_request'],
  [401, 'access_denied'],
  [402, 'payment_required'],
  [403, 'access_denied'],
  [404, 'not_found'],
  [408, 'timeout'],
  [429, 'throttled']
];

export function classifyUpstreamStatus(status: number): string {
  for (const [code, className] of STATUS_CLASSES) {
    if (status === code) return className;
  }
  if (status >= 500) return 'upstream_error';
  return 'upstream_error';
}

export function buildUpstreamErrorEnvelope(provider: string, status: number): UpstreamErrorEnvelope {
  return {
    provider,
    status,
    class: classifyUpstreamStatus(status)
  };
}

export function classifyUnknownUpstreamError(error: unknown): { provider: string; status: number; class: string } {
  const message = error instanceof Error ? error.message : '';
  const isTimeoutLike = /timeout|abort/i.test(message);
  return {
    provider: 'unknown',
    status: isTimeoutLike ? 408 : 502,
    class: isTimeoutLike ? 'timeout' : 'upstream_error'
  };
}

export function logUpstreamError(provider: string, status: number, raw: string): void {
  console.error(`Upstream error from ${provider} (status ${status}):`, raw.slice(0, 2000));
}

export function logUpstreamException(provider: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Upstream request to ${provider} failed:`, message.slice(0, 2000));
}
