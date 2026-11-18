import { useEffect, useRef, useState } from "react";

// Diff-based animation hooks. The watcher bumps refreshKey and views re-read
// wholesale, so "animate on mount/render" would flash the entire screen on
// every external change — these hooks animate only what actually changed.

/** True for `ttl` ms after `value` changes (initial value does not pulse). */
export function usePulse(value: unknown, ttl = 340): boolean {
  const prev = useRef(value);
  const [on, setOn] = useState(false);

  useEffect(() => {
    if (prev.current === value) return;
    prev.current = value;
    setOn(true);
    const id = window.setTimeout(() => setOn(false), ttl);
    return () => window.clearTimeout(id);
  }, [value, ttl]);

  return on;
}

/**
 * Keys that appeared since the previous snapshot (first load animates
 * nothing). Entries auto-expire after `ttl` ms.
 *
 * `loaded`, when the caller can say it, marks the moment the first read came
 * back: that snapshot is the baseline even when it is empty, so the very first
 * entry of an empty list (the first envelope ever published) still arrives as
 * new. Without it, the first non-empty snapshot is taken as the baseline.
 */
export function useFreshKeys(keys: string[], ttl = 1600, loaded?: boolean): Set<string> {
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const joined = keys.join(" ");

  useEffect(() => {
    if (seen.current === null) {
      // Views mount with an empty list before the first fetch resolves — the
      // first NON-EMPTY snapshot is the baseline, absorbed without animation.
      if (loaded === undefined ? keys.length === 0 : !loaded) return;
      seen.current = new Set(keys);
      return;
    }
    const added = keys.filter((k) => !seen.current!.has(k));
    for (const k of keys) seen.current.add(k);
    if (added.length === 0) return;
    setFresh(new Set(added));
    const id = window.setTimeout(() => setFresh(new Set()), ttl);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined, ttl, loaded]);

  return fresh;
}
