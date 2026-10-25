/** A signal that fires after `ms`, or earlier when the caller's `signal` aborts. */
export function timeoutSignal(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([timeout, signal]) : timeout;
}
