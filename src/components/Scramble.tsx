import { useLayoutEffect, useRef } from "react";

import { motionOff } from "../lib/fx";
import { FIXED, poolFor } from "../lib/scramble";

/**
 * C10: when the value changes, the text settles left to right and the
 * characters not yet settled flicker through a pool of their own kind (digits
 * for digits, workflow words for Chinese). `.scramble-busy` carries the
 * in-flight colour and glow.
 *
 * Diff-triggered (invariant: animate only what changed): the first value
 * renders as is, and so does every value under reduced motion. The animation
 * writes into React's own text node rather than replacing it, so React keeps
 * a live reference and the next real update lands where it should.
 */
export default function Scramble({
  value,
  durationMs = 520,
  className,
  replay,
  delayMs = 0,
  initial,
}: {
  value: string | number;
  durationMs?: number;
  className?: string;
  /**
   * What the text was before this element existed. When it differs from
   * `value`, the first render settles too — a result that has just been
   * fetched (C196's version) or a version that changed across a restart
   * (C197). Without it the first value simply shows.
   */
  initial?: string;
  /**
   * Waits this long before settling, holding the digits at 0 meanwhile — a
   * column of counts that should run up one after another (C235).
   */
  delayMs?: number;
  /**
   * Plays the settle even though the text is unchanged, whenever this value
   * changes — a phase becoming current keeps its name but still arrives (C18).
   */
  replay?: unknown;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const text = String(value);
  const prev = useRef(initial ?? text);
  const prevReplay = useRef(replay);

  useLayoutEffect(() => {
    if (prev.current === text && prevReplay.current === replay) return;
    prev.current = text;
    prevReplay.current = replay;
    const el = ref.current;
    const node = el?.firstChild;
    if (el === null || !(node instanceof Text) || motionOff()) return;

    const target = [...text];
    // The clock starts on the first frame, from the frame's own timestamp.
    // Starting it from performance.now() mixed two clocks: the frame clock
    // follows the document timeline, and whenever that runs slow (a debugger
    // slowing animations, G080) it fell behind for good — the text never
    // settled and kept flickering until the next change.
    let t0 = -1;
    let raf = 0;
    let wait = 0;
    el.classList.add("scramble-busy");
    const frame = (now: number) => {
      if (t0 < 0) t0 = now;
      const k = (now - t0) / durationMs;
      if (k >= 1) {
        node.nodeValue = text;
        el.classList.remove("scramble-busy");
        return;
      }
      node.nodeValue = target
        .map((c, i) => {
          if (k > (i + 1) / (target.length + 1) || FIXED.has(c)) return c;
          const pool = poolFor(c);
          return pool[Math.floor(Math.random() * pool.length)];
        })
        .join("");
      raf = requestAnimationFrame(frame);
    };
    if (delayMs > 0) {
      node.nodeValue = text.replace(/\d/g, "0");
      wait = window.setTimeout(() => {
        raf = requestAnimationFrame(frame);
      }, delayMs);
    } else raf = requestAnimationFrame(frame);
    return () => {
      window.clearTimeout(wait);
      cancelAnimationFrame(raf);
      node.nodeValue = text;
      el.classList.remove("scramble-busy");
    };
    // delayMs is read when a change starts, not a reason to start one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, durationMs, replay]);

  return (
    <span ref={ref} className={className}>
      {text}
    </span>
  );
}
