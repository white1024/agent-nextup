import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { IconWarn } from "./icons";
import { motionOff } from "../lib/fx";

const EASE_OUT = "cubic-bezier(.16,1,.3,1)";

/**
 * A page's error line under its header (spec 20 §1, C236): it drops in with a
 * slight overshoot while what is below it makes room, and on clearing lifts
 * away before the content slides back up. The projects overview and the
 * dashboard's connect guide (§10) use it.
 *
 * The content below is moved with FLIP on the element's *following siblings*:
 * inserting or removing the bar shifts each of them by the same amount — the
 * distance from the bar's top to the next sibling's top — so that one number
 * is the whole measurement. Reduced motion shows and removes it at once.
 */
export default function ErrorBar({ error, className }: { error: string | null; className?: string }) {
  const [shown, setShown] = useState<string | null>(error);
  const ref = useRef<HTMLDivElement>(null);
  const entering = useRef(false);

  useLayoutEffect(() => {
    if (error !== null) {
      if (shown === null) entering.current = true;
      if (error !== shown) setShown(error);
      return;
    }
    if (shown === null) return;
    const el = ref.current;
    if (el === null || motionOff()) {
      setShown(null);
      return;
    }
    const gap = gapBelow(el);
    let done = false;
    const anim = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-8px)" },
      ],
      { duration: 200, easing: "ease-in", fill: "forwards" },
    );
    void anim.finished
      .catch(() => undefined)
      .then(() => {
        if (done) return;
        const after = following(el);
        flushSync(() => setShown(null));
        slide(after, gap, 320, 0);
      });
    return () => {
      // A new error arrived mid-exit: the bar stays, at full strength.
      done = true;
      anim.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!entering.current || el === null) return;
    entering.current = false;
    if (motionOff()) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(-14px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 420, delay: 80, easing: "cubic-bezier(.2,1.3,.4,1)", fill: "backwards" },
    );
    slide(following(el), -gapBelow(el), 420, 60);
  }, [shown]);

  if (shown === null) return null;
  return (
    <div ref={ref} className={`alert alert-error error-bar ${className ?? ""}`} role="alert">
      <IconWarn size={15} />
      <span>{shown}</span>
    </div>
  );
}

function following(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let n = el.nextElementSibling; n !== null; n = n.nextElementSibling) {
    if (n instanceof HTMLElement) out.push(n);
  }
  return out;
}

/** How far the bar pushes what follows it: its top to the next sibling's top. */
function gapBelow(el: HTMLElement): number {
  const next = el.nextElementSibling;
  if (next === null) return 0;
  return next.getBoundingClientRect().top - el.getBoundingClientRect().top;
}

/** Each element plays from `dy` back to where it is now. */
function slide(els: HTMLElement[], dy: number, duration: number, delay: number) {
  if (Math.abs(dy) < 1 || motionOff()) return;
  const h = window.innerHeight;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.top > h) break;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration,
      delay,
      easing: EASE_OUT,
      fill: "backwards",
    });
  }
}
