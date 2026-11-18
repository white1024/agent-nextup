/**
 * Motion for the specs page (D153, spec 60 "specs"): C167, C169, C170.
 *
 * Same rules as `lib/fx.ts`: reduced motion means the result at once, only a
 * change starts anything (a click, or a re-read that folded a delta in), and
 * React keeps owning the DOM — what this file adds to the page (the sliding
 * bar, the scan line, a pending row's picture, the old text under the
 * curtain) are its own nodes, and it removes them itself.
 */

import { fx, motionOff, type Point } from "../../lib/fx";
import { EASE_IN, EASE_OUT } from "../../lib/listMotion";

const running = new Set<Animation>();
const extras = new Set<Element>();

function track(a: Animation): Animation {
  running.add(a);
  void a.finished.catch(() => undefined).then(() => running.delete(a));
  return a;
}

function own<T extends Element>(el: T): T {
  extras.add(el);
  return el;
}

function drop(el: Element) {
  el.remove();
  extras.delete(el);
}

/** Ends everything in flight (unmount, or the next change arrives mid-way). */
export function settle() {
  for (const a of running) {
    try {
      a.finish();
    } catch {
      a.cancel();
    }
  }
  running.clear();
  for (const el of extras) el.remove();
  extras.clear();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── C167: choosing another capability ─────────────────────────────────────

/**
 * A frame the size of a capability slides from the old one to the new one,
 * then fades; the new one brightens from .35 as it arrives.
 */
export function slideBar(from: DOMRect | null, to: HTMLElement | null) {
  if (from === null || to === null || motionOff()) return;
  const b = to.getBoundingClientRect();
  const bar = own(document.createElement("i"));
  bar.className = "spc-bar";
  bar.setAttribute("aria-hidden", "true");
  Object.assign(bar.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
  document.body.appendChild(bar);
  const mv = track(
    bar.animate(
      [
        { transform: `translate(${from.left - b.left}px, ${from.top - b.top}px)`, opacity: 1 },
        { transform: "none", opacity: 1, offset: 0.8 },
        { transform: "none", opacity: 0 },
      ],
      { duration: 380, easing: EASE_OUT, fill: "both" },
    ),
  );
  void mv.finished.then(
    () => drop(bar),
    () => drop(bar),
  );
  track(to.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 300, delay: 120, easing: "ease-out", fill: "backwards" }));
}

/** The old text fades (120 ms) and the box keeps its height while it loads. */
export function fadeContent(box: HTMLElement | null): number {
  if (box === null || motionOff()) return 0;
  box.style.minHeight = `${Math.min(box.offsetHeight, window.innerHeight)}px`;
  for (const el of box.children) {
    if (el.classList.contains("spc-line")) continue;
    track(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-in", fill: "forwards" }));
  }
  return 120;
}

/** The scan line that waits at the top edge while the new text loads. */
export function parkLine(box: HTMLElement | null): HTMLElement | null {
  if (box === null || motionOff()) return null;
  for (const old of box.querySelectorAll(":scope > .spc-line")) drop(old);
  const line = own(document.createElement("i"));
  line.className = "spc-line";
  line.setAttribute("aria-hidden", "true");
  box.appendChild(line);
  return line;
}

/**
 * The line sweeps down to the visible bottom; each block of the new text
 * fades up as the line passes where it sits.
 */
export function reveal(box: HTMLElement | null, dur = 300) {
  if (box === null) return;
  const line = box.querySelector<HTMLElement>(":scope > .spc-line");
  const release = () => {
    box.style.minHeight = "";
    if (line !== null) drop(line);
  };
  if (motionOff()) {
    release();
    return;
  }
  const r = box.getBoundingClientRect();
  const vis = Math.max(80, Math.min(r.bottom, window.innerHeight) - r.top);
  for (const el of box.querySelectorAll<HTMLElement>(":scope > .md-body > *, :scope > .spc-muted")) {
    const y = el.getBoundingClientRect().top - r.top;
    track(
      el.animate([{ opacity: 0, transform: "translateY(4px)" }, { opacity: 1, transform: "none" }], {
        duration: 220,
        delay: clamp(y / vis, 0, 1) * dur,
        easing: "ease-out",
        fill: "backwards",
      }),
    );
  }
  if (line === null) {
    release();
    return;
  }
  const mv = track(
    line.animate(
      [
        { transform: "translateY(0)", opacity: 1 },
        { transform: `translateY(${vis.toFixed(0)}px)`, opacity: 1, offset: 0.85 },
        { transform: `translateY(${vis.toFixed(0)}px)`, opacity: 0 },
      ],
      { duration: dur + 60, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
    ),
  );
  void mv.finished.then(release, release);
}

// ── C169: a pending delta folds into the specs ────────────────────────────

export interface RowShot {
  box: DOMRect;
  picture: HTMLElement;
}

/** Each pending row's box and a picture of it, taken before a re-read lands. */
export function shootRows(list: HTMLElement | null): Map<string, RowShot> {
  const out = new Map<string, RowShot>();
  if (list === null || motionOff()) return out;
  for (const el of list.querySelectorAll<HTMLElement>("[data-spc-row]")) {
    out.set(el.dataset.spcRow ?? "", { box: el.getBoundingClientRect(), picture: el.cloneNode(true) as HTMLElement });
  }
  return out;
}

/**
 * Rows that stayed slide up into the place the folded one left. The list
 * keeps its old height until they have, then eases down — otherwise the
 * panel (it scrolls, so it clips) shrinks at once and cuts off the rows that
 * are still on their way up.
 */
export function closeGap(list: HTMLElement | null, shots: Map<string, RowShot>, delay: number, wasHeight = 0) {
  if (list === null || motionOff()) return;
  const now = list.getBoundingClientRect().height;
  if (wasHeight > now + 0.5) {
    const total = delay + 380;
    track(
      list.animate(
        [
          { minHeight: `${wasHeight}px` },
          { minHeight: `${wasHeight}px`, offset: delay / total, easing: EASE_OUT },
          { minHeight: `${now}px` },
        ],
        { duration: total, easing: "linear" },
      ),
    );
  }
  for (const el of list.querySelectorAll<HTMLElement>("[data-spc-row]")) {
    const was = shots.get(el.dataset.spcRow ?? "");
    if (was === undefined) continue;
    const dy = was.box.top - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 0.5) continue;
    track(
      el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
        duration: 380,
        delay,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    );
  }
}

/**
 * The folded row's words fade, then its empty frame shrinks to a point near
 * its left edge. Returns that point, where the light will leave from.
 */
export function foldRow(shot: RowShot): Point {
  const r = shot.box;
  const p = { x: r.left + 18, y: r.top + r.height / 2 };
  if (motionOff()) return p;
  const pic = own(shot.picture);
  pic.classList.add("spc-row-shot");
  pic.removeAttribute("data-spc-row");
  pic.setAttribute("aria-hidden", "true");
  pic.inert = true;
  Object.assign(pic.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.appendChild(pic);
  for (const c of pic.children) {
    track(c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "forwards" }));
  }
  track(pic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, delay: 160, fill: "forwards" }));

  const g = own(document.createElement("div"));
  g.className = "spc-shrink";
  g.setAttribute("aria-hidden", "true");
  Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  document.body.appendChild(g);
  track(
    g.animate(
      [
        { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: 1 },
        { left: `${p.x - 5}px`, top: `${p.y - 5}px`, width: "10px", height: "10px", opacity: 1 },
      ],
      { duration: 320, delay: 140, easing: EASE_IN, fill: "both" },
    ),
  );
  window.setTimeout(() => {
    drop(pic);
    drop(g);
  }, 460);
  return p;
}

/** The light flies from the point into each capability the delta changed. */
export function beamInto(from: Point, targets: (Element | null)[]) {
  targets.forEach((el, k) => {
    if (el === null) return;
    const r = el.getBoundingClientRect();
    fx.beam(from, { x: r.left + r.width / 2, y: r.top + r.height / 2 }, { dur: 640, delay: k * 90, bend: -0.22, width: 3 });
  });
}

/**
 * The curtain over the open capability (the same band as C36's): the old
 * text — a picture laid over the new — fades where the band passes, and the
 * new text fades in behind it.
 */
export function curtain(box: HTMLElement | null, old: HTMLElement | null) {
  if (box === null || motionOff()) return;
  const r = box.getBoundingClientRect();
  const vis = Math.max(120, Math.min(r.bottom, window.innerHeight) - r.top);
  const dur = 900;
  const when = (el: Element) => clamp((el.getBoundingClientRect().top - r.top) / vis, 0, 1) * dur * 0.85;
  if (old !== null) {
    own(old);
    old.classList.add("spc-old");
    old.setAttribute("aria-hidden", "true");
    box.appendChild(old);
    for (const el of old.children) {
      track(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: when(el), fill: "forwards" }));
    }
  }
  for (const el of box.querySelectorAll(":scope > .md-body:not(.spc-old) > *")) {
    track(el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: when(el) + 40, fill: "backwards" }));
  }
  const sc = own(document.createElement("div"));
  sc.className = "adv-scan";
  sc.setAttribute("aria-hidden", "true");
  Object.assign(sc.style, { left: `${r.left}px`, width: `${r.width}px`, top: `${r.top - 150}px` });
  document.body.appendChild(sc);
  const mv = track(
    sc.animate(
      [
        { transform: "translateY(0)", opacity: 0 },
        { opacity: 1, offset: 0.08 },
        { opacity: 1, offset: 0.85 },
        { transform: `translateY(${vis.toFixed(0)}px)`, opacity: 0 },
      ],
      { duration: dur, easing: "cubic-bezier(.5,0,.3,1)", fill: "forwards" },
    ),
  );
  const done = () => {
    drop(sc);
    if (old !== null) drop(old);
  };
  void mv.finished.then(done, done);
}

// ── C170: the empty page's path ───────────────────────────────────────────

/**
 * A point of light walks the three steps once and stops at the third.
 * `onStep(k)` lights step k as the light passes it; `onDone` leaves the
 * third one glowing. Positions are measured now, so call it after fonts load.
 */
export function walkPath(guide: HTMLElement | null, onStep: (k: number) => void, onDone: () => void): () => void {
  const run = guide?.querySelector<HTMLElement>(".spc-path-run");
  const line = guide?.querySelector<HTMLElement>(".spc-path-line");
  const stops = guide === null || guide === undefined ? [] : [...guide.querySelectorAll<HTMLElement>(".spc-node")];
  if (motionOff() || run == null || line == null || stops.length < 3) {
    onStep(3);
    onDone();
    return () => undefined;
  }
  const lr = line.getBoundingClientRect();
  const vertical = lr.height > lr.width;
  const ps = stops.map((n) => {
    const b = n.getBoundingClientRect();
    return vertical ? b.top + b.height / 2 - lr.top : b.left + b.width / 2 - lr.left;
  });
  const tf = (v: number) => (vertical ? `translateY(${v.toFixed(1)}px)` : `translateX(${v.toFixed(1)}px)`);
  const dur = 1500;
  track(
    run.animate(
      [
        { transform: tf(ps[0]), opacity: 0 },
        { transform: tf(ps[0]), opacity: 1, offset: 0.08 },
        { transform: tf(ps[2]), opacity: 1, offset: 0.9 },
        { transform: tf(ps[2]), opacity: 0 },
      ],
      { duration: dur, delay: 420, easing: "cubic-bezier(.45,0,.25,1)", fill: "both" },
    ),
  );
  const span = Math.max(1, ps[2] - ps[0]);
  const timers = stops.map((_, k) =>
    window.setTimeout(() => onStep(k + 1), 420 + 120 + ((ps[k] - ps[0]) / span) * dur * 0.8),
  );
  timers.push(window.setTimeout(onDone, 420 + dur));
  return () => {
    for (const id of timers) window.clearTimeout(id);
  };
}
