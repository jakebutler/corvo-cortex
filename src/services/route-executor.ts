import type { RoutePlan, PlannedRouteCandidate } from './route-planner';

export type RouteFailureReason =
  | 'timeout'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'schema_invalid'
  | 'throttled';

export interface AttemptSuccess<TPayload> {
  ok: true;
  provider: PlannedRouteCandidate['provider'];
  model: string;
  payload: TPayload;
  ttftMs?: number;
  cacheHit?: boolean;
}

export interface AttemptFailure {
  ok: false;
  reason: RouteFailureReason;
  message: string;
  retriable: boolean;
  statusCode?: number;
}

export type AttemptResult<TPayload> = AttemptSuccess<TPayload> | AttemptFailure;

export interface AttemptContext {
  attemptIndex: number;
  role: 'primary' | 'hedge' | 'fallback';
  timeoutMs: number;
  signal: AbortSignalLike;
}

export interface AttemptRecord {
  candidateIndex: number;
  provider: PlannedRouteCandidate['provider'];
  model: string;
  role: AttemptContext['role'];
  reason?: RouteFailureReason;
  message?: string;
  statusCode?: number;
  success: boolean;
}

export interface ExecuteRoutePlanOptions<TPayload> {
  plan: RoutePlan;
  attempt: (candidate: PlannedRouteCandidate, context: AttemptContext) => Promise<AttemptResult<TPayload>>;
  validate?: (payload: TPayload) => Promise<{ valid: boolean; reason?: RouteFailureReason; message?: string }>;
}

export type ExecuteRoutePlanResult<TPayload> =
  | {
      ok: true;
      value: TPayload;
      winner: {
        provider: PlannedRouteCandidate['provider'];
        model: string;
        candidateIndex: number;
        role: AttemptContext['role'];
      };
      attempts: AttemptRecord[];
      fallbackUsed: boolean;
      hedgeUsed: boolean;
      latencyMs: number;
      ttftMs?: number;
      cacheHit?: boolean;
    }
  | {
      ok: false;
      errorClass: 'route_exhausted' | 'schema_invalid';
      reasonCodes: RouteFailureReason[];
      attempts: AttemptRecord[];
      fallbackUsed: boolean;
      hedgeUsed: boolean;
      latencyMs: number;
    };

interface CandidateAttemptResult<TPayload> {
  success?: AttemptSuccess<TPayload>;
  attempts: AttemptRecord[];
}

interface AbortSignalLike {
  aborted: boolean;
}

interface AbortControllerLike {
  signal: AbortSignalLike;
  abort: () => void;
}

export async function executeRoutePlan<TPayload>(
  options: ExecuteRoutePlanOptions<TPayload>
): Promise<ExecuteRoutePlanResult<TPayload>> {
  const { plan } = options;
  const startedAt = Date.now();

  if (!plan.candidates.length) {
    return {
      ok: false,
      errorClass: 'route_exhausted',
      reasonCodes: ['upstream_5xx'],
      attempts: [],
      fallbackUsed: false,
      hedgeUsed: false,
      latencyMs: 0
    };
  }

  let hedgeUsed = false;
  const allAttempts: AttemptRecord[] = [];

  if (plan.hedge.enabled && plan.requestRole === 'primary' && plan.candidates.length >= 2) {
    const hedgedResult = await runHedged(options, startedAt);
    allAttempts.push(...hedgedResult.attempts);

    if (hedgedResult.success) {
      return {
        ok: true,
        value: hedgedResult.success.payload,
        winner: {
          provider: hedgedResult.success.provider,
          model: hedgedResult.success.model,
          candidateIndex: hedgedResult.success.candidateIndex,
          role: hedgedResult.success.role
        },
        attempts: allAttempts,
        fallbackUsed: hedgedResult.success.candidateIndex > 0,
        hedgeUsed: hedgedResult.hedgeUsed,
        latencyMs: Date.now() - startedAt,
        ttftMs: hedgedResult.success.ttftMs,
        cacheHit: hedgedResult.success.cacheHit
      };
    }

    hedgeUsed = hedgedResult.hedgeUsed;
  }

  const startCandidateIndex = hedgeUsed ? 2 : 0;

  for (let candidateIndex = startCandidateIndex; candidateIndex < plan.candidates.length; candidateIndex++) {
    // nosemgrep: javascript.lang.security.audit.object-injection.object-injection
    // eslint-disable-next-line security/detect-object-injection
    const candidate = plan.candidates[candidateIndex];
    const candidateResult = await runCandidateWithRetry(
      options,
      candidate,
      candidateIndex,
      'fallback',
      startedAt
    );

    allAttempts.push(...candidateResult.attempts);

    if (candidateResult.success) {
      return {
        ok: true,
        value: candidateResult.success.payload,
        winner: {
          provider: candidateResult.success.provider,
          model: candidateResult.success.model,
          candidateIndex,
          role: 'fallback'
        },
        attempts: allAttempts,
        fallbackUsed: candidateIndex > 0 || hedgeUsed,
        hedgeUsed,
        latencyMs: Date.now() - startedAt,
        ttftMs: candidateResult.success.ttftMs,
        cacheHit: candidateResult.success.cacheHit
      };
    }
  }

  const reasonCodes = Array.from(new Set(allAttempts
    .map(attempt => attempt.reason)
    .filter((reason): reason is RouteFailureReason => Boolean(reason))));
  const errorClass = reasonCodes.length > 0 && reasonCodes.every(reason => reason === 'schema_invalid')
    ? 'schema_invalid'
    : 'route_exhausted';

  return {
    ok: false,
    errorClass,
    reasonCodes,
    attempts: allAttempts,
    fallbackUsed: allAttempts.some((attempt) => attempt.candidateIndex > 0),
    hedgeUsed,
    latencyMs: Date.now() - startedAt
  };
}

interface HedgedSuccess<TPayload> extends AttemptSuccess<TPayload> {
  candidateIndex: number;
  role: AttemptContext['role'];
}

interface HedgedResult<TPayload> {
  success?: HedgedSuccess<TPayload>;
  attempts: AttemptRecord[];
  hedgeUsed: boolean;
}

async function runHedged<TPayload>(
  options: ExecuteRoutePlanOptions<TPayload>,
  startedAt: number
): Promise<HedgedResult<TPayload>> {
  const attempts: AttemptRecord[] = [];
  const primaryCandidate = options.plan.candidates[0];
  const hedgeCandidate = options.plan.candidates[1];

  const primaryPromise = runCandidateWithRetry(options, primaryCandidate, 0, 'primary', startedAt);

  const first = await Promise.race([
    primaryPromise.then(result => ({ kind: 'primary' as const, result })),
    sleep(options.plan.hedge.delayMs).then(() => ({ kind: 'delay' as const }))
  ]);

  if (first.kind === 'primary') {
    attempts.push(...first.result.attempts);
    if (first.result.success) {
      return {
        success: {
          ...first.result.success,
          candidateIndex: 0,
          role: 'primary'
        },
        attempts,
        hedgeUsed: false
      };
    }

    return {
      attempts,
      hedgeUsed: false
    };
  }

  const hedgePromise = runCandidateWithRetry(options, hedgeCandidate, 1, 'hedge', startedAt);

  const pending = new Map<
    'primary' | 'hedge',
    Promise<{ role: 'primary' | 'hedge'; result: CandidateAttemptResult<TPayload> }>
  >([
    ['primary', primaryPromise.then(result => ({ role: 'primary' as const, result }))],
    ['hedge', hedgePromise.then(result => ({ role: 'hedge' as const, result }))]
  ]);

  while (pending.size > 0) {
    const raced = await Promise.race(Array.from(pending.values()));
    pending.delete(raced.role);

    attempts.push(...raced.result.attempts);

    if (raced.result.success) {
      return {
        success: {
          ...raced.result.success,
          candidateIndex: raced.role === 'primary' ? 0 : 1,
          role: raced.role
        },
        attempts,
        hedgeUsed: true
      };
    }
  }

  return {
    attempts,
    hedgeUsed: true
  };
}

async function runCandidateWithRetry<TPayload>(
  options: ExecuteRoutePlanOptions<TPayload>,
  candidate: PlannedRouteCandidate,
  candidateIndex: number,
  role: AttemptContext['role'],
  startedAt: number
): Promise<CandidateAttemptResult<TPayload>> {
  const attempts: AttemptRecord[] = [];

  for (let attemptIndex = 0; attemptIndex <= options.plan.retryPolicy.maxRetries; attemptIndex++) {
    const elapsed = Date.now() - startedAt;
    const remainingBudget = options.plan.maxLatencyMs - elapsed;

    if (remainingBudget <= 0) {
      attempts.push({
        candidateIndex,
        provider: candidate.provider,
        model: candidate.model,
        role,
        reason: 'timeout',
        message: 'latency budget exceeded',
        success: false
      });
      return { attempts };
    }

    const controller = createAbortController();
    const timeoutId = setTimeout(() => controller.abort(), remainingBudget);

    try {
      const rawResult = await options.attempt(candidate, {
        attemptIndex,
        role,
        timeoutMs: remainingBudget,
        signal: controller.signal
      });

      const result = rawResult.ok
        ? await validateSuccess(options, rawResult)
        : rawResult;

      if (result.ok) {
        attempts.push({
          candidateIndex,
          provider: result.provider,
          model: result.model,
          role,
          success: true
        });
        return {
          success: result,
          attempts
        };
      }

      attempts.push({
        candidateIndex,
        provider: candidate.provider,
        model: candidate.model,
        role,
        reason: result.reason,
        message: result.message,
        statusCode: result.statusCode,
        success: false
      });

      if (!result.retriable || attemptIndex === options.plan.retryPolicy.maxRetries) {
        return { attempts };
      }

      await sleep(calculateBackoffDelay(
        attemptIndex,
        options.plan.retryPolicy.baseDelayMs,
        options.plan.retryPolicy.maxDelayMs
      ));
    } catch (error) {
      const failure = classifyUnknownFailure(error);
      attempts.push({
        candidateIndex,
        provider: candidate.provider,
        model: candidate.model,
        role,
        reason: failure.reason,
        message: failure.message,
        success: false
      });

      if (!failure.retriable || attemptIndex === options.plan.retryPolicy.maxRetries) {
        return { attempts };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return { attempts };
}

async function validateSuccess<TPayload>(
  options: ExecuteRoutePlanOptions<TPayload>,
  success: AttemptSuccess<TPayload>
): Promise<AttemptResult<TPayload>> {
  if (!options.validate) {
    return success;
  }

  const validation = await options.validate(success.payload);
  if (validation.valid) {
    return success;
  }

  return {
    ok: false,
    reason: validation.reason || 'schema_invalid',
    message: validation.message || 'schema validation failed',
    retriable: false
  };
}

function classifyUnknownFailure(error: unknown): AttemptFailure {
  if (error instanceof Error) {
    const message = error.message || 'Unknown upstream error';
    if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted')) {
      return {
        ok: false,
        reason: 'timeout',
        message,
        retriable: true
      };
    }

    return {
      ok: false,
      reason: 'upstream_5xx',
      message,
      retriable: true
    };
  }

  return {
    ok: false,
    reason: 'upstream_5xx',
    message: 'Unknown upstream error',
    retriable: true
  };
}

function calculateBackoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt);
  return Math.min(exponential, maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createAbortController(): AbortControllerLike {
  const AbortControllerCtor = (globalThis as {
    AbortController?: new () => AbortControllerLike;
  }).AbortController;

  if (AbortControllerCtor) {
    return new AbortControllerCtor();
  }

  const fallbackSignal: AbortSignalLike = { aborted: false };
  return {
    signal: fallbackSignal,
    abort: () => {
      fallbackSignal.aborted = true;
    }
  };
}

export function createSuccessResult<TPayload>(params: {
  provider: PlannedRouteCandidate['provider'];
  model: string;
  payload: TPayload;
  ttftMs?: number;
  cacheHit?: boolean;
}): AttemptSuccess<TPayload> {
  return {
    ok: true,
    provider: params.provider,
    model: params.model,
    payload: params.payload,
    ttftMs: params.ttftMs,
    cacheHit: params.cacheHit
  };
}

export function createFailureResult(
  reason: RouteFailureReason,
  message: string,
  retriable: boolean,
  statusCode?: number
): AttemptFailure {
  return {
    ok: false,
    reason,
    message,
    retriable,
    statusCode
  };
}
