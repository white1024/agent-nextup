import { useEffect, useRef, type ReactNode } from "react";

import { IconInfo } from "./icons";

/**
 * An explanation behind an ⓘ (D153): the teaching kind of copy that a row
 * does not need to carry all the time — invariant 17(c) splits explanations
 * into rules (always on screen) and teaching (can be put away). This is the
 * lightest way of putting teaching away: it is there every time, one click
 * deep, and never gone for good (that is `TeachingHint`'s job).
 *
 * `<details>`/`<summary>`, so it is a native disclosure — keyboard, Enter and
 * Space, and screen readers all work without wiring. Clicking anywhere else or
 * pressing Esc folds it again.
 */
export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (el === null || !el.open) return;
      if (e instanceof KeyboardEvent) {
        if (e.key !== "Escape") return;
      } else if (el.contains(e.target as Node)) {
        return;
      }
      el.open = false;
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, []);

  return (
    <details className="info-tip" ref={ref}>
      <summary aria-label={label} title={label}>
        <IconInfo size={14} />
      </summary>
      <div className="info-tip-pop">{children}</div>
    </details>
  );
}
