/**
 * Motion for the collab board (D153, spec 60 "collab"): C161–C165.
 *
 * Same three rules as `lib/fx.ts`: reduced motion means the result at once,
 * only a change starts anything (the board diffs what it drew against what it
 * read, or the user clicked), and React keeps owning the DOM. What flies is a
 * clone on <body>, so the board's scroll box cannot clip it; what slides is a
 * transform on the real node that ends where React put it. The wires live in
 * an <svg> React renders empty and never reconciles into.
 *
 * Cards carry `data-kb-task`, columns `data-kb-col`.
 */

import { motionOff } from "../../lib/fx";
import { EASE_IN, EASE_OUT } from "../../lib/listMotion";

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function box(el: Element): Box {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Viewport boxes of every `[attr]` under `root`, keyed by the attribute. */
export function boxes(root: Element | null, attr: string): Map<string, Box> {
  const out = new Map<string, Box>();
  if (root === null) return out;
  for (const el of root.querySelectorAll(`[${attr}]`)) out.set(el.getAttribute(attr) ?? "", box(el));
  return out;
}

export function cardEl(root: Element | null, id: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-kb-task="${CSS.escape(id)}"]`) ?? null;
}

export function colEl(root: Element | null, key: string): HTMLElement | null {
  return root?.querySelector<HTMLElement>(`[data-kb-col="${CSS.escape(key)}"]`) ?? null;
}

/** Everything still in flight, so a page change or a new burst can finish it. */
const running = new Set<Animation>();
const ghosts = new Set<Element>();

function track(a: Animation): Animation {
  running.add(a);
  void a.finished.catch(() => undefined).then(() => running.delete(a));
  return a;
}

/** Ends every effect at once (unmount, or the next change arrives mid-flight). */
export function settle() {
  for (const a of running) {
    try {
      a.finish();
    } catch {
      a.cancel();
    }
  }
  running.clear();
  for (const g of ghosts) g.remove();
  ghosts.clear();
}

/** Nodes that stayed slide from their old box to where they are now (FLIP). */
export function flip(
  root: Element | null,
  attr: string,
  before: Map<string, Box>,
  o: { skip?: ReadonlySet<string>; dur?: number; delay?: number } = {},
) {
  if (root === null || motionOff()) return;
  for (const el of root.querySelectorAll<HTMLElement>(`[${attr}]`)) {
    const k = el.getAttribute(attr) ?? "";
    if (o.skip?.has(k)) continue;
    const a = before.get(k);
    if (a === undefined) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
    track(
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
        duration: o.dur ?? 420,
        delay: o.delay ?? 0,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    );
  }
}

/** A band of light crosses a card that has just arrived in its column. */
export function sweep(card: HTMLElement | null) {
  if (card === null || motionOff()) return;
  card.classList.remove("kb-fresh");
  void card.offsetWidth;
  card.classList.add("kb-fresh");
  window.setTimeout(() => card.classList.remove("kb-fresh"), 900);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const inOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** How long C162's flight takes for a card that travels `dist` px. */
export function flightMs(dist: number): number {
  return Math.round(clamp(420 + dist * 0.35, 520, 760));
}

/**
 * C162: the card lifts (only its shadow deepens) and flies along an arc from
 * `from` to where React has just put it. The real card stays hidden until the
 * clone lands, then a band of light crosses it. Returns when it lands (ms),
 * or 0 when nothing flew.
 *
 * `target` is the card's box measured before any column started its own
 * FLIP — measured after, it would include the column's starting offset and
 * the clone would land where the column used to be.
 */
export function fly(card: HTMLElement | null, from: Box | undefined, delay = 0, target?: Box): number {
  if (card === null || from === undefined || motionOff()) return 0;
  const to = target ?? box(card);
  const dx = to.left - from.left;
  const dy = to.top - from.top;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return 0;
  const dur = flightMs(dist);
  const lift = -clamp(28 + dist * 0.16, 30, 96);

  const g = card.cloneNode(true) as HTMLElement;
  for (const el of [g, ...g.querySelectorAll<HTMLElement>("*")]) {
    for (const at of [...el.attributes]) if (at.name.startsWith("data-kb")) el.removeAttribute(at.name);
    el.removeAttribute("id");
  }
  for (const el of g.querySelectorAll<HTMLElement>("select, input, button")) el.tabIndex = -1;
  g.classList.remove("kb-hl", "kb-fresh");
  g.classList.add("kb-ghost");
  g.inert = true;
  g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px` });
  document.body.appendChild(g);
  ghosts.add(g);

  const kf: Keyframe[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const e = inOut(t);
    kf.push({
      offset: t,
      transform: `translate(${(dx * e).toFixed(1)}px, ${(dy * e + lift * 4 * e * (1 - e)).toFixed(1)}px)`,
    });
  }
  const a = track(g.animate(kf, { duration: dur, delay, easing: "linear", fill: "both" }));
  track(
    g.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], {
      duration: dur + 80,
      delay,
      fill: "both",
      pseudoElement: "::after",
    }),
  );
  track(card.animate([{ opacity: 0 }, { opacity: 0 }], { duration: dur + delay }));
  const land = () => {
    g.remove();
    ghosts.delete(g);
  };
  void a.finished.then(
    () => {
      land();
      if (card.isConnected) sweep(card);
    },
    land,
  );
  return dur + delay;
}

/**
 * C164's second half: a column that did not exist shows its empty frame
 * first, then its name. Returns when a card may fly into it (ms).
 */
export function openCol(col: HTMLElement | null): number {
  if (col === null || motionOff()) return 0;
  track(
    col.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], {
      duration: 260,
      delay: 140,
      easing: EASE_OUT,
      fill: "backwards",
    }),
  );
  const head = col.querySelector<HTMLElement>(".kb-ch");
  if (head !== null) {
    track(
      head.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], {
        duration: 260,
        delay: 400,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    );
  }
  return 520;
}

/** C165, folding: the cards tuck up into the head. Returns when they are gone (ms). */
export function tuckCards(col: HTMLElement | null): number {
  if (col === null || motionOff()) return 0;
  const head = col.querySelector(".kb-ch");
  const hb = head?.getBoundingClientRect().bottom ?? 0;
  const cards = [...col.querySelectorAll<HTMLElement>(".kb-card")];
  cards.forEach((el, k) => {
    const dy = Math.max(-160, hb - el.getBoundingClientRect().top);
    track(
      el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${dy.toFixed(0)}px)` }], {
        duration: 260,
        delay: Math.min(k, 8) * 30,
        easing: EASE_IN,
        fill: "forwards",
      }),
    );
  });
  return cards.length === 0 ? 0 : 260 + Math.min(cards.length, 8) * 30;
}

/** C165, unfolding: the cards drop back down out of the head. */
export function dropCards(col: HTMLElement | null) {
  if (col === null || motionOff()) return;
  const hb = col.querySelector(".kb-ch")?.getBoundingClientRect().bottom;
  col.querySelectorAll<HTMLElement>(".kb-card").forEach((el, k) => {
    const dy = hb === undefined ? -20 : Math.max(-160, hb - el.getBoundingClientRect().top);
    track(
      el.animate([{ opacity: 0, transform: `translateY(${dy.toFixed(0)}px)` }, { opacity: 1, transform: "none" }], {
        duration: 360,
        delay: 60 + Math.min(k, 8) * 34,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    );
  });
}

/** C163: the lock shrinks away before "ready" takes its place. */
export function dropLock(card: HTMLElement | null) {
  const lock = card?.querySelector<HTMLElement>("[data-kb-lock]");
  if (lock == null || motionOff()) return;
  track(
    lock.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.6)" }], {
      duration: 180,
      easing: "ease-in",
      fill: "forwards",
    }),
  );
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * C161 / C163: a dashed wire from the card being waited on to the waiting
 * card's lock, in the board's own coordinates (the svg sits in `.kb-cols`, so
 * a horizontal scroll moves the wire with the cards). A dot walks the wire:
 * forever while hovered, once for `run` (the unlock), and not at all under
 * reduced motion — the wire itself still shows what waits on what.
 */
export function wire(
  svg: SVGSVGElement | null,
  from: Element | null,
  to: Element | null,
  o: { run?: boolean; dur?: number } = {},
): SVGGElement | null {
  const cols = svg?.parentElement;
  if (svg == null || cols == null || from === null || to === null) return null;
  const w = cols.scrollWidth;
  const h = cols.scrollHeight;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const c0 = cols.getBoundingClientRect();
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const bx = b.left + b.width / 2 - c0.left;
  const by = b.top + b.height / 2 - c0.top;
  // Same column: the wire leaves the left edge and bows out to the left, so
  // it does not cut across the cards in between.
  const sameCol = Math.abs(a.left - b.left) < 120;
  const ax = sameCol ? a.left - c0.left + 6 : a.left > b.left ? a.left - c0.left : a.right - c0.left;
  const ay = a.top + Math.min(a.height / 2, 28) - c0.top;
  const k = sameCol ? -Math.max(40, Math.abs(by - ay) * 0.35) : (bx - ax) * 0.45;
  const c2x = sameCol ? bx - 30 + k : bx - k;
  const d = `M${ax.toFixed(1)} ${ay.toFixed(1)} C ${(ax + k).toFixed(1)} ${ay.toFixed(1)}, ${c2x.toFixed(1)} ${by.toFixed(1)}, ${bx.toFixed(1)} ${by.toFixed(1)}`;

  const g = document.createElementNS(SVG, "g");
  g.setAttribute("class", `kb-wire${o.run ? " run" : ""}`);
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", d);
  g.appendChild(p);
  svg.appendChild(g);
  const off = motionOff();
  if (!off) track(p.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, fill: "backwards" }));
  if (off) {
    if (o.run) window.setTimeout(() => g.remove(), 400);
    return g;
  }
  const dot = document.createElementNS(SVG, "circle");
  dot.setAttribute("r", "2.6");
  dot.setAttribute("class", "kb-wire-dot");
  g.appendChild(dot);
  const len = p.getTotalLength();
  const kf: Keyframe[] = [];
  for (let i = 0; i <= 16; i++) {
    const pt = p.getPointAtLength((len * i) / 16);
    kf.push({
      transform: `translate(${pt.x.toFixed(1)}px, ${pt.y.toFixed(1)}px)`,
      opacity: i === 0 || i === 16 ? 0 : 1,
    });
  }
  // The hover dot loops until the wire is taken away; it is not tracked, or
  // `settle()` would try to finish an infinite animation.
  const walk = dot.animate(kf, {
    duration: o.dur ?? 900,
    easing: "ease-in-out",
    iterations: o.run ? 1 : Infinity,
    fill: "both",
  });
  if (o.run) {
    track(walk);
    void walk.finished.then(
      () =>
        void g
          .animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: "forwards" })
          .finished.then(
            () => g.remove(),
            () => g.remove(),
          ),
      () => g.remove(),
    );
  }
  return g;
}
