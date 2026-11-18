/**
 * Motion for the tools page (D153, spec 60 "tools"): the pieces of C173,
 * C176 and C178 that move page elements rather than the orb (the orb's own
 * motion lives in HubOrb). Same rules as `lib/fx.ts`: reduced motion means the
 * result at once, only an event starts anything, and React keeps owning the
 * DOM — what moves is a transform that ends where React put the node.
 */

import { motionOff, type Point } from "../../lib/fx";
import { EASE_OUT } from "../../lib/listMotion";

/** The scrolling content area. */
export function scroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main.content");
}

/** Is `el` fully inside the content area's visible part (with margins)? */
export function inView(el: Element | null, top = 40, bottom = 60): boolean {
  const m = scroller();
  if (el === null || m === null) return true;
  const r = el.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  return r.top >= mr.top + top && r.bottom <= mr.bottom - bottom;
}

/** Scrolls the content area so `el` sits `ratio` of the way down it. */
export function scrollTo(el: Element | null, o: { ratio?: number; offset?: number } = {}) {
  const m = scroller();
  if (el === null || m === null) return;
  const r = el.getBoundingClientRect();
  const mr = m.getBoundingClientRect();
  const lead = o.offset ?? mr.height * (o.ratio ?? 0.3);
  m.scrollTo({ top: Math.max(0, m.scrollTop + (r.top - mr.top) - lead), behavior: motionOff() ? "auto" : "smooth" });
}

/**
 * C173: the parked amber circle flies along an arc to `to` (560 ms), then
 * swells and fades where it lands. Returns when it lands.
 */
export function flyDot(dot: HTMLElement | null, to: Point | null): number {
  if (dot === null) return 0;
  if (to === null || motionOff()) {
    popDot(dot);
    return 0;
  }
  const d0 = dot.getBoundingClientRect();
  const dx = to.x - (d0.left + d0.width / 2);
  const dy = to.y - (d0.top + d0.height / 2);
  const lift = -Math.min(120, 40 + Math.hypot(dx, dy) * 0.12);
  const kf: Keyframe[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    kf.push({ offset: t, transform: `translate(${(dx * e).toFixed(1)}px, ${(dy * e + lift * 4 * e * (1 - e)).toFixed(1)}px)` });
  }
  const a = dot.animate(kf, { duration: 560, easing: "linear", fill: "forwards" });
  void a.finished.then(
    () => {
      dot.style.left = `${to.x - 7}px`;
      dot.style.top = `${to.y - 7}px`;
      a.cancel();
      popDot(dot);
    },
    () => dot.remove(),
  );
  return 560;
}

/** The circle swells and fades where it is. */
export function popDot(dot: HTMLElement | null) {
  if (dot === null) return;
  if (motionOff()) {
    dot.remove();
    return;
  }
  const a = dot.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(2.2)" },
    ],
    { duration: 360, easing: "ease-out", fill: "forwards" },
  );
  void a.finished.then(
    () => dot.remove(),
    () => dot.remove(),
  );
}

/** A block fades up and away (220 ms) before it is removed (C178). */
export function liftAway(el: Element | null): Animation | null {
  if (el === null || motionOff()) return null;
  return el.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-8px)" },
    ],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  );
}

/** Everything after `el` in its own block and in the page column holding it,
 *  with where each one is now — what has to close the gap it leaves. */
export function followers(el: Element | null, column: Element | null): Map<HTMLElement, number> {
  const out = new Map<HTMLElement, number>();
  if (el === null) return out;
  const after = (x: Element) => (el.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && !x.contains(el);
  const pool = [...(el.parentElement?.children ?? []), ...(column?.children ?? [])];
  for (const x of pool) {
    if (x instanceof HTMLElement && after(x)) out.set(x, x.getBoundingClientRect().top);
  }
  return out;
}

/** Those blocks slide from where they were to where they are now. */
export function closeUp(tops: Map<HTMLElement, number>) {
  if (motionOff()) return;
  for (const [el, was] of tops) {
    if (!el.isConnected) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 320, easing: EASE_OUT });
  }
}

/** A row fades up before the list it is in is redrawn without it (C176). */
export function fadeRow(row: Element | null): Animation | null {
  if (row === null || motionOff()) return null;
  return row.animate(
    [
      { opacity: 1, transform: "none" },
      { opacity: 0, transform: "translateY(-6px)" },
    ],
    { duration: 220, easing: "ease-in", fill: "forwards" },
  );
}
