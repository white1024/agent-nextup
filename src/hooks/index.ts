import { useCallback, useEffect, useRef, useState } from "react";

import { api, errorKind, errorMessage } from "../api";
import { NOTIFY_STRENGTH, type Toast } from "../lib/notify";
import type { WorkspaceOverview } from "../types";

/**
 * Shared "read a workspace view" boilerplate: fetch on mount and whenever
 * `refreshKey` bumps (backend watcher / local mutation), keeping the last
 * good data on transient failures. With `notFoundAsEmpty`, a backend
 * `not_found` clears the data instead of raising (missing file = normal
 * empty state). `setData`/`setError` are exposed for mutations that already
 * hold a fresher value from the backend.
 *
 * `loading` means "the first read has not resolved yet" — NOT "a read is in
 * flight". Two reasons it is neither derived nor re-armed (D65):
 *  - Deriving it as `data === null && error === null` breaks `notFoundAsEmpty`,
 *    whose whole job is to land on exactly that state deliberately — the view
 *    would spin forever on a workspace that legitimately has no such file.
 *  - Re-arming it on every `refreshKey` bump would flash a loading state each
 *    time the watcher sees an agent write, which is the same trap `anim.ts`
 *    documents for mount animations.
 * Callers use it to tell "still fetching" apart from "fetched, and it is
 * empty" — rendering an empty state during the first read tells the user
 * something false about their project.
 */
export function useWorkspaceData<T>(
  fetcher: () => Promise<T>,
  refreshKey: number,
  opts?: { notFoundAsEmpty?: boolean },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Ref-stabilized so callers may pass inline arrows without retriggering
  // the effect on every render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const notFoundRef = useRef(opts?.notFoundAsEmpty ?? false);
  notFoundRef.current = opts?.notFoundAsEmpty ?? false;

  const reload = useCallback(async () => {
    try {
      setData(await fetcherRef.current());
      setError(null);
    } catch (e) {
      if (notFoundRef.current && errorKind(e) === "not_found") {
        setData(null);
        setError(null);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  return { data, setData, error, setError, reload, loading };
}

/**
 * The "one mutation at a time" shell, hoisted out of `Tasks.tsx` where it was
 * the only written-down copy of a shape 32 call sites across 19 files had each
 * hand-rolled.
 *
 * Deliberately small. A survey of those sites found four *orthogonal* things
 * they do on success — reload, adopt the returned value, fire a callback, clear
 * a form or close a dialog — in every combination. Turning those into options
 * would make the hook harder to read than the eight lines it replaces, so they
 * stay in the caller's `fn`: it runs inside the same `try`, so a failed reload
 * still surfaces as an error exactly as it did before.
 *
 * Clearing the previous error is the caller's first line inside `fn` for the
 * same reason — and it lands *after* the guard, so a double-click that gets
 * rejected no longer wipes the error the user is currently reading.
 *
 * What the hook does own is the part everyone got subtly wrong:
 *
 *  - **The ref is the actual guard.** Two clicks in one tick both read `false`
 *    from state, because `disabled` only takes effect on the next render (the
 *    D57 lesson). Only 4 of the 32 sites had this; the rest relied on
 *    `disabled={busy}` alone, which does not hold for non-idempotent calls.
 *  - **`run` reports whether it succeeded.** Callers that clear an input only
 *    on success need this, and a `void` shell makes them fail silently — the
 *    user's typing vanishes on error.
 *  - **The error sink is injected, never assumed.** The sites split four ways
 *    (main slot, a second dedicated slot, a callback prop, plus per-call
 *    overrides). Toast is deliberately *not* offered: `NOTIFY_STRENGTH` decides
 *    loudness per event kind (D62), and routing arbitrary failures through it
 *    would hollow that table out.
 *
 * Share one instance across several mutations when they should lock each other
 * out — that is how the existing views scope their `disabled` bindings, and one
 * instance per existing `busy` keeps that scope exactly as it was.
 */
export function useGuardedMutation(onError: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  // Ref-stabilized so callers may pass an inline arrow without making `run`
  // a new function on every render (it lands in effect deps and JSX handlers).
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const run = useCallback(
    async (fn: () => Promise<void>, onErrorOverride?: (message: string) => void) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        await fn();
        return true;
      } catch (e) {
        (onErrorOverride ?? onErrorRef.current)(errorMessage(e));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [],
  );

  return { busy, run };
}

/**
 * Transient success banner with unmount-safe timeout: `showFlash(msg)` shows
 * `msg` for `ttlMs`, then clears. Re-showing restarts the clock.
 */
export function useFlash(ttlMs: number) {
  const [flash, setFlash] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const showFlash = useCallback(
    (message: string) => {
      setFlash(message);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setFlash(null), ttlMs);
    },
    [ttlMs],
  );

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return { flash, showFlash };
}

/** At most this many toasts are on screen; the oldest is dropped past it. */
const TOAST_MAX = 4;

/**
 * Toast queue with per-toast TTL and repeat folding (D62).
 *
 * Repeats of the same `dedupeKey` bump a counter on the existing toast and
 * restart its clock instead of stacking — an agent retrying a denied call
 * would otherwise bury the screen in identical popups.
 *
 * The queue is held in a ref and mirrored into state rather than derived
 * inside a `setState` updater: updaters must stay pure (StrictMode invokes
 * them twice, the D57 lesson), and arming a timer or minting an id is a side
 * effect. The ref also keeps two pushes in the same tick from racing — the
 * second sees the first.
 */
export function useToasts(ttlMs: number) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastsRef = useRef<Toast[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const nextIdRef = useRef(1);

  const commit = useCallback((next: Toast[]) => {
    toastsRef.current = next;
    setToasts(next);
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      const timer = timersRef.current.get(id);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timersRef.current.delete(id);
      }
      commit(toastsRef.current.filter((t) => t.id !== id));
    },
    [commit],
  );

  const arm = useCallback(
    (id: number) => {
      window.clearTimeout(timersRef.current.get(id));
      timersRef.current.set(
        id,
        window.setTimeout(() => dismiss(id), ttlMs),
      );
    },
    [dismiss, ttlMs],
  );

  const pushToast = useCallback(
    (spec: Omit<Toast, "id" | "count">) => {
      // Loudness belongs to the event, not to the call site: a kind the table
      // marks badge-only is dropped here rather than trusted, so ambient
      // events cannot become popups by way of one careless caller.
      if (NOTIFY_STRENGTH[spec.kind] !== "toast") return;
      const existing = toastsRef.current.find((t) => t.dedupeKey === spec.dedupeKey);
      if (existing !== undefined) {
        commit(
          toastsRef.current.map((t) =>
            t.id === existing.id ? { ...t, ...spec, id: t.id, count: t.count + 1 } : t,
          ),
        );
        arm(existing.id);
        return;
      }
      const id = nextIdRef.current++;
      const next = [...toastsRef.current, { ...spec, id, count: 1 }];
      // Dropping the oldest must also drop its timer, or it fires later and
      // removes whatever id-less ghost it still believes in.
      for (const dropped of next.slice(0, Math.max(0, next.length - TOAST_MAX))) {
        window.clearTimeout(timersRef.current.get(dropped.id));
        timersRef.current.delete(dropped.id);
      }
      commit(next.slice(-TOAST_MAX));
      arm(id);
    },
    [arm, commit],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, pushToast, dismiss };
}

/**
 * Recent-workspace list with the shared degrade path: a failed read logs and
 * falls back to an empty list (the menus stay usable). Loading is explicit
 * (`reload`) because both call sites fetch on menu open, not on mount.
 * `setRecent` is exposed for the remove-mutation which returns the new list.
 *
 * `null` = not read yet, `[]` = read and there genuinely are none (D65). The
 * two used to share `[]`, which made the projects overview render its
 * "welcome, create your first project" hero during the first read — the
 * landing view of the app, telling every returning user they own nothing.
 */
export function useRecentWorkspaces() {
  const [recent, setRecent] = useState<WorkspaceOverview[] | null>(null);

  const reload = useCallback(() => {
    api
      .recentWorkspaces()
      .then(setRecent)
      .catch((e) => {
        console.warn("recent workspaces failed:", e);
        setRecent([]);
      });
  }, []);

  return { recent, setRecent, reload };
}
