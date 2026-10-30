import { StellarSafeError } from "./errors.js";

/** Retry policy for transient RPC failures. */
export interface RetryOptions {
  /** Extra attempts after the first. Default 3. Set 0 to disable retries. */
  readonly retries?: number;
  /** Delay before the first retry, in ms. Doubles each attempt (with jitter). Default 250. */
  readonly baseDelayMs?: number;
  /** Upper bound on a single delay, in ms. Default 5000. */
  readonly maxDelayMs?: number;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "EPIPE",
  "ENOTFOUND",
  "ECONNABORTED",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Heuristic for errors worth retrying: network failures, timeouts, 429 and 5xx.
 * Errors from the SDK itself (validation, contract errors) are never retried.
 */
export function isTransientError(err: unknown): boolean {
  if (err instanceof StellarSafeError) return false;
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    code?: unknown;
    status?: unknown;
    response?: { status?: unknown };
    cause?: unknown;
    name?: unknown;
  };
  const status = typeof e.status === "number" ? e.status : e.response?.status;
  if (typeof status === "number") return TRANSIENT_STATUS.has(status);
  if (typeof e.code === "string" && TRANSIENT_CODES.has(e.code)) return true;
  if (e.name === "TimeoutError") return true;
  // fetch() network failures surface as TypeError with the real error in `cause`.
  if (e.name === "TypeError" && e.cause !== undefined) return isTransientError(e.cause);
  return false;
}

/** Sleep for `ms`, rejecting early with an ABORTED error if `signal` fires. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(signal: AbortSignal): StellarSafeError {
  return new StellarSafeError("ABORTED", "Operation aborted", { cause: signal.reason });
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

/**
 * Run `fn`, retrying transient failures with exponential backoff and full jitter.
 * Non-transient errors are rethrown immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
  signal?: AbortSignal,
): Promise<T> {
  const retries = options.retries ?? 3;
  const base = options.baseDelayMs ?? 250;
  const max = options.maxDelayMs ?? 5000;
  for (let attempt = 0; ; attempt++) {
    throwIfAborted(signal);
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isTransientError(err)) throw err;
      const ceiling = Math.min(max, base * 2 ** attempt);
      await sleep(Math.random() * ceiling, signal);
    }
  }
}
