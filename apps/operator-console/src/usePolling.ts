import { useCallback, useEffect, useRef, useState } from "react";

export interface Polling<T> {
  data: T | null;
  error: string;
  updatedAt: number | null;
  refresh: () => Promise<void>;
}

// Cap the error backoff so a persistently-failing endpoint is retried at most
// once every MAX_BACKOFF_MS instead of every intervalMs forever.
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * Poll `fn` on mount and every `intervalMs` while `enabled`. `deps` triggers an
 * immediate re-fetch when it changes (e.g. the selected window) instead of
 * waiting for the next tick. `fn` is read through a ref so a new closure each
 * render doesn't restart the loop.
 *
 * The loop self-schedules with `setTimeout` after each poll settles rather than
 * a fixed `setInterval`, which gives two properties a naive interval lacks:
 *
 * - **In-flight guard:** the next tick is only scheduled once the current
 *   request resolves, so a slow endpoint (>`intervalMs`) can't pile up
 *   overlapping requests.
 * - **Error backoff:** consecutive failures double the delay (capped at
 *   `MAX_BACKOFF_MS`), so a persistently-erroring endpoint stops being hammered
 *   every interval. A success resets it back to `intervalMs`.
 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  enabled: boolean,
  deps: readonly unknown[] = [],
): Polling<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  // A poll started before unmount (e.g. a tenant switch re-keys and remounts the
  // page subtree) can resolve afterwards; drop its result instead of setting
  // state on a dead component. Re-set true on mount for StrictMode remounts.
  const mounted = useRef(true);
  // True while a request is outstanding, so overlapping ticks are skipped.
  const inFlight = useRef(false);
  // Consecutive-failure count driving the exponential backoff.
  const failures = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Guard against overlap: a manual refresh or a scheduled tick while a
    // request is still in flight is a no-op (the outstanding one will update).
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const d = await fnRef.current();
      if (!mounted.current) return;
      setData(d);
      setUpdatedAt(Date.now());
      setError("");
      failures.current = 0;
    } catch (e) {
      if (!mounted.current) return;
      setError(e instanceof Error ? e.message : String(e));
      failures.current += 1;
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let id: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (cancelled || !enabled) return;
      // Back off exponentially on consecutive failures, capped.
      const delay = Math.min(intervalMs * 2 ** failures.current, MAX_BACKOFF_MS);
      id = setTimeout(tick, delay);
    };
    const tick = () => {
      if (cancelled) return;
      void refresh().finally(schedule);
    };
    tick();
    return () => {
      cancelled = true;
      if (id !== undefined) clearTimeout(id);
    };
  }, [refresh, intervalMs, enabled, ...deps]);

  return { data, error, updatedAt, refresh };
}
