/**
 * Provider Concurrency Durable Object
 * Tracks in-flight requests and enforces per-provider/model concurrency limits.
 */

interface AcquireRequest {
  provider: string;
  model: string;
  limit: number;
  ttlMs?: number;
}

interface ReleaseRequest {
  leaseId: string;
}

interface LeaseRecord {
  key: string;
  expiresAt: number;
}

export class ProviderConcurrency implements DurableObject {
  private readonly defaultLeaseTtlMs = 15 * 60 * 1000; // 15 minutes
  private readonly maxLeaseTtlMs = 60 * 60 * 1000; // 60 minutes
  private readonly counters = new Map<string, number>();
  private readonly leases = new Map<string, LeaseRecord>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly _env: unknown
  ) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;

    try {
      if (pathname === '/acquire') {
        return await this.handleAcquire(request);
      }
      if (pathname === '/release') {
        return await this.handleRelease(request);
      }
      if (pathname === '/status') {
        return this.handleStatus();
      }
      if (pathname === '/reset') {
        return this.handleReset();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      return this.json(
        { error: error instanceof Error ? error.message : 'Unknown error' },
        500
      );
    }
  }

  private async handleAcquire(request: Request): Promise<Response> {
    this.cleanupExpiredLeases();

    const body = await request.json() as Partial<AcquireRequest>;
    const provider = typeof body.provider === 'string' ? body.provider.trim() : '';
    const model = typeof body.model === 'string' ? body.model.trim().toLowerCase() : '';
    const limit = Number(body.limit);

    if (!provider || !model || !Number.isFinite(limit) || limit <= 0) {
      return this.json({ error: 'Invalid acquire request' }, 400);
    }

    const key = this.toKey(provider, model);
    const inFlight = this.counters.get(key) || 0;

    if (inFlight >= limit) {
      return this.json(
        { acquired: false, provider, model, limit, inFlight },
        429
      );
    }

    const leaseId = this.createLeaseId();
    const ttlMs = this.getLeaseTtlMs(body.ttlMs);
    const nextInFlight = inFlight + 1;

    this.leases.set(leaseId, {
      key,
      expiresAt: Date.now() + ttlMs
    });
    this.counters.set(key, nextInFlight);

    return this.json(
      {
        acquired: true,
        leaseId,
        provider,
        model,
        limit,
        inFlight: nextInFlight
      },
      200
    );
  }

  private async handleRelease(request: Request): Promise<Response> {
    this.cleanupExpiredLeases();

    const body = await request.json() as Partial<ReleaseRequest>;
    const leaseId = typeof body.leaseId === 'string' ? body.leaseId : '';
    if (!leaseId) {
      return this.json({ error: 'Missing leaseId' }, 400);
    }

    const lease = this.leases.get(leaseId);
    if (!lease) {
      return this.json({ released: false }, 200);
    }

    this.leases.delete(leaseId);
    this.decrementCounter(lease.key);

    return this.json({ released: true }, 200);
  }

  private handleStatus(): Response {
    this.cleanupExpiredLeases();
    const counters = Array.from(this.counters.entries()).map(([key, inFlight]) => {
      const [provider, model] = this.fromKey(key);
      return { provider, model, inFlight };
    });
    return this.json({ counters, leases: this.leases.size }, 200);
  }

  private handleReset(): Response {
    this.counters.clear();
    this.leases.clear();
    return this.json({ reset: true }, 200);
  }

  private cleanupExpiredLeases(now = Date.now()): void {
    for (const [leaseId, lease] of this.leases.entries()) {
      if (lease.expiresAt <= now) {
        this.leases.delete(leaseId);
        this.decrementCounter(lease.key);
      }
    }
  }

  private decrementCounter(key: string): void {
    const current = this.counters.get(key) || 0;
    if (current <= 1) {
      this.counters.delete(key);
      return;
    }
    this.counters.set(key, current - 1);
  }

  private getLeaseTtlMs(requestedTtlMs?: number): number {
    if (!Number.isFinite(requestedTtlMs)) return this.defaultLeaseTtlMs;
    const ttl = Math.floor(Number(requestedTtlMs));
    if (ttl <= 0) return this.defaultLeaseTtlMs;
    return Math.min(ttl, this.maxLeaseTtlMs);
  }

  private createLeaseId(): string {
    const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (webCrypto && typeof webCrypto.randomUUID === 'function') {
      return webCrypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  private toKey(provider: string, model: string): string {
    return `${provider}:${model}`;
  }

  private fromKey(key: string): [string, string] {
    const separator = key.indexOf(':');
    if (separator < 0) return [key, ''];
    return [key.slice(0, separator), key.slice(separator + 1)];
  }

  private json(payload: unknown, status: number): Response {
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
