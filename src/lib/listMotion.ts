/**
 * Motion for lists whose rows change in place (D153, spec 30, tasks page): the
 * filter swap (C24 / C270–C272), rows sliding to where they now are (FLIP),
 * and the empty frame that grows a row into its own card and back (C25).
 *
 * The tasks page is the first user; the inbox's envelope (step 5) reuses the
 * frame and the projects overview's "remove" (step 4) the row exit, which is
 * why this lives in lib/ rather than next to the tasks page.
 *
 * Same three rules as `fx.ts`: reduced motion means the result at once, only
 * events start anything (callers fire these from handlers or from a diff, never
 * from a render), and React keeps owning the DOM — nothing here moves, removes
 * or re-parents a node React rendered. What travels is a *picture* (a clone),
 * or a transform on the real node that ends where React put it.
 *
 * DOM and the Web Animations API only (D154 R1); no React (lib/ rule).
 */

import { motionOff } from "./fx";

/** The open-frame timing (C25). */
export const BOX_OPEN_MS = 440;
export const BOX_CLOSE_MS = 360;
export const EASE_OUT = "cubic-bezier(.16,1,.3,1)";
export const EASE_IN = "cubic-bezier(.4,0,.2,1)";

// ── View Transitions (C24) ─────────────────────────────────────────────────

type VtDocument = Document & {
  startViewTransition?: (cb: () => void) => { finished: Promise<void> };
};

/**
 * Runs `swap` inside a View Transition so rows that survive slide to their new
 * place and the rest fade (C24). `swap` must commit synchronously — wrap the
 * state change in `flushSync` — because the engine takes its "after" picture
 * as soon as the callback returns.
 *
 * Only rows that are on screen get a name: naming all of a long list costs
 * a picture per row (the design measured 42–48 ms for 24) for rows nobody can
 * see move. Names are cleared when the transition ends, or the next one would
 * find stale names and refuse to start.
 *
 * `kind` lands on `<html data-vt>` for the duration so the CSS can time this
 * transition without touching any other (settings' theme fade has its own).
 * Falls back to a plain swap without the API, under reduced motion, or while
 * another transition is still running.
 */
export function viewSwap(kind: string, scope: HTMLElement | null, swap: () => void) {
  const doc = document as VtDocument;
  const root = document.documentElement;
  if (motionOff() || typeof doc.startViewTransition !== "function" || root.dataset.vt !== undefined) {
    swap();
    return;
  }
  const name = () => {
    if (scope === null) return;
    for (const el of scope.querySelectorAll<HTMLElement>("[data-vt-name]")) {
      const r = el.getBoundingClientRect();
      el.style.viewTransitionName =
        r.bottom > 0 && r.top < window.innerHeight ? (el.dataset.vtName ?? "") : "";
    }
  };
  name();
  root.dataset.vt = kind;
  const tr = doc.startViewTransition(() => {
    swap();
    name();
  });
  void tr.finished.finally(() => {
    if (root.dataset.vt === kind) delete root.dataset.vt;
    for (const el of document.querySelectorAll<HTMLElement>("[data-vt-name]")) {
      el.style.viewTransitionName = "";
    }
  });
}

// ── FLIP: rows slide to where they are now ──────────────────────────────────

/**
 * Tops of every `[data-row]` under `list`, keyed by the row's id, measured
 * from the list's own top — so a scroll between two measurements (a write
 * that takes a while) does not read as every row having moved.
 */
export function rowTops(list: HTMLElement | null): Map<string, number> {
  const out = new Map<string, number>();
  if (list === null) return out;
  const top = list.getBoundingClientRect().top;
  for (const el of list.querySelectorAll<HTMLElement>("[data-row]")) {
    out.set(el.dataset.row ?? "", el.getBoundingClientRect().top - top);
  }
  return out;
}

/** True when some row present in both snapshots moved. */
export function rowsMoved(a: Map<string, number>, b: Map<string, number>): boolean {
  for (const [id, y] of b) {
    const was = a.get(id);
    if (was !== undefined && Math.abs(was - y) >= 1) return true;
  }
  return a.size !== b.size;
}

/**
 * Rows that moved since `before` (a `rowTops` snapshot) play from their old
 * place to their new one. Rows off screen on both ends stay put — nobody would
 * see them move, and a long list would otherwise animate a hundred transforms.
 */
export function slideRows(
  list: HTMLElement | null,
  before: Map<string, number>,
  timing: KeyframeAnimationOptions,
  skip?: string | null,
): Animation[] {
  if (list === null || motionOff()) return [];
  const out: Animation[] = [];
  const h = window.innerHeight;
  const top = list.getBoundingClientRect().top;
  for (const el of list.querySelectorAll<HTMLElement>("[data-row]")) {
    const id = el.dataset.row ?? "";
    const was = before.get(id);
    if (id === skip || was === undefined) continue;
    const r = el.getBoundingClientRect();
    const dy = was - (r.top - top);
    if (Math.abs(dy) < 1) continue;
    if ((r.bottom < 0 && r.bottom + dy < 0) || (r.top > h && r.top + dy > h)) continue;
    out.push(el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing));
  }
  return out;
}

/** The list's own outline follows its rows instead of jumping to the end. */
export function easeHeight(el: HTMLElement | null, from: number, timing: KeyframeAnimationOptions): Animation[] {
  if (el === null || motionOff()) return [];
  const to = el.getBoundingClientRect().height;
  if (Math.abs(to - from) <= 1) return [];
  return [el.animate([{ height: `${from}px` }, { height: `${to}px` }], timing)];
}

/**
 * Fades rows out where they stand (C277 / C278 / deleting), one after another
 * by `stagger` ms, at most 12 steps — rows past the twelfth go together, and
 * rows off screen just go. Resolves when the last one is invisible; the caller
 * then lets React drop them and slides the rest up (`slideRows`).
 *
 * `fill: forwards` holds them invisible until React removes the nodes. Rows are
 * keyed by id, so a node is never handed to a different task in between.
 */
export async function fadeRowsOut(rows: (HTMLElement | null)[], stagger = 0): Promise<void> {
  const els = rows.filter((e): e is HTMLElement => e !== null && e.isConnected);
  if (els.length === 0 || motionOff()) return;
  const h = window.innerHeight;
  let i = 0;
  const anims: Animation[] = [];
  for (const el of els) {
    el.style.pointerEvents = "none";
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > h) {
      el.style.opacity = "0";
      continue;
    }
    anims.push(
      el.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 220,
        delay: Math.min(i, 12) * stagger,
        easing: "ease-in",
        fill: "forwards",
      }),
    );
    i += 1;
  }
  await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
}

// ── C25: the empty frame ────────────────────────────────────────────────────

/** Attributes a picture must not carry: tests, clicks and the next lookup all
 *  find the real element by these. */
const STRIP = ["id", "data-row", "data-card", "data-vt", "data-vt-name"];

/**
 * A picture of `el` at its current size: inert, unreachable, unfindable.
 * Form controls get their live values copied over — `cloneNode` copies
 * attributes, and React drives a `<select>` through its property, so a plain
 * clone would show every status select on its first option.
 */
export function pictureOf(el: HTMLElement): HTMLElement {
  const width = el.getBoundingClientRect().width;
  const cl = el.cloneNode(true) as HTMLElement;
  for (const node of [cl, ...cl.querySelectorAll<HTMLElement>("*")]) {
    for (const a of STRIP) node.removeAttribute(a);
    if (node !== cl) node.style.viewTransitionName = "";
  }
  const srcControls = el.querySelectorAll<HTMLSelectElement | HTMLInputElement>("select, input");
  cl.querySelectorAll<HTMLSelectElement | HTMLInputElement>("select, input").forEach((c, i) => {
    const s = srcControls[i];
    if (s !== undefined) c.value = s.value;
    c.tabIndex = -1;
  });
  cl.querySelectorAll<HTMLElement>("button, a, textarea, summary").forEach((b) => {
    b.tabIndex = -1;
  });
  cl.classList.add("bx-clone");
  cl.style.width = `${width}px`;
  cl.style.viewTransitionName = "";
  cl.inert = true;
  cl.setAttribute("aria-hidden", "true");
  return cl;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const boxOf = (el: Element): Box => {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
};

const shown = (b: Box | null | undefined): b is Box =>
  b != null && b.height > 0 && b.top + b.height > 0 && b.top < window.innerHeight;

/** Box keyframes in the coordinates of the frame's offset parent (`host`). */
function frames(g: HTMLElement, a: Box, b: Box): Keyframe[] {
  const p = (g.offsetParent as HTMLElement | null) ?? document.body;
  const o = p.getBoundingClientRect();
  const dx = o.left + p.clientLeft - p.scrollLeft;
  const dy = o.top + p.clientTop - p.scrollTop;
  return [a, b].map((r) => ({
    left: `${r.left - dx}px`,
    top: `${r.top - dy}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  }));
}

function ghost(host: HTMLElement, cls: string): HTMLDivElement {
  const g = document.createElement("div");
  g.className = `bx-ghost ${cls}`.trim();
  g.setAttribute("aria-hidden", "true");
  host.appendChild(g);
  return g;
}

// What is playing and what to do when it ends. Opening or closing again first
// plays the current one to its end synchronously, so a late tidy-up can never
// remove the frame the next one just made.
let playing: Animation[] | null = null;
let onSettle: (() => void) | null = null;

/** Finish whatever frame is in flight, right now. */
export function settleBox() {
  for (const a of playing ?? []) {
    try {
      a.finish();
    } catch {
      /* already finished or cancelled */
    }
  }
  playing = null;
  const d = onSettle;
  onSettle = null;
  d?.();
}

const endOf = (a: Animation) => Number(a.effect?.getComputedTiming().endTime ?? 0);

/**
 * Opening (C25): an empty frame grows from where the source was (`from`, measured
 * before the swap) to `dst`; inside it the source's picture fades at its own
 * size — the words are never stretched with the box — and a band of light
 * sweeps the frame. Just before it lands, `dst` fades in and its children rise
 * one after another. When the source was off screen, `dst` simply rises.
 *
 * Returns the animations so the caller can add its own (the other rows'
 * slide) to the same settle.
 */
export function boxOpen(o: {
  host: HTMLElement;
  from: Box;
  picture: HTMLElement | null;
  dst: HTMLElement;
  cls?: string;
  also?: Animation[];
}): Animation[] {
  const fx = [...(o.also ?? [])];
  if (motionOff()) return fx;
  const dst = o.dst;
  if (!shown(o.from) || o.picture === null) {
    fx.push(
      dst.animate([{ opacity: 0, transform: "translateY(16px)" }, { opacity: 1, transform: "none" }], {
        duration: 380,
        easing: EASE_OUT,
      }),
    );
    playing = fx;
    return fx;
  }
  const D = BOX_OPEN_MS;
  const g = ghost(o.host, o.cls ?? "");
  g.appendChild(o.picture);
  const grow = g.animate(frames(g, o.from, boxOf(dst)), { duration: D, easing: EASE_OUT, fill: "both" });
  fx.push(
    grow,
    o.picture.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: "ease-out", fill: "both" }),
    g.animate([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], {
      duration: 560,
      delay: 40,
      easing: "ease-out",
      fill: "both",
      pseudoElement: "::after",
    }),
    dst.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 140, delay: D - 90, easing: "ease-out", fill: "backwards" }),
  );
  [...dst.children].forEach((ch, i) =>
    fx.push(
      ch.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], {
        duration: 280,
        delay: D - 70 + Math.min(i, 6) * 40,
        easing: EASE_OUT,
        fill: "backwards",
      }),
    ),
  );
  playing = fx;
  let fired = false;
  const end = () => {
    if (fired) return;
    fired = true;
    if (onSettle === end) {
      onSettle = null;
      playing = null;
    }
    g.remove();
  };
  onSettle = end;
  grow.finished.then(
    () => {
      if (fired) return;
      g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: "forwards" }).finished.then(end, end);
    },
    end,
  );
  return fx;
}

/**
 * Closing (C25 backwards): the card's picture (`out`, taken before the swap)
 * fades inside a frame that shrinks from the card's box (`from`) back to the
 * row (`to`); the row's own picture fades in as the frame arrives, and the
 * real row (`hide`) only shows once it is there. `done` runs once, at the end
 * or when the next frame settles this one.
 */
export function boxClose(o: {
  host: HTMLElement;
  from: Box;
  to: Box | null;
  out: HTMLElement | null;
  src: HTMLElement | null;
  hide?: HTMLElement[];
  cls?: string;
  also?: Animation[];
  done: () => void;
}): Animation[] {
  const fx = [...(o.also ?? [])];
  const D = BOX_CLOSE_MS;
  let g: HTMLDivElement | null = null;
  if (!motionOff() && o.src !== null && shown(o.to)) {
    g = ghost(o.host, o.cls ?? "");
    if (o.out !== null) {
      g.appendChild(o.out);
      fx.push(o.out.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-in", fill: "both" }));
    }
    const cl = pictureOf(o.src);
    g.appendChild(cl);
    fx.push(
      g.animate(frames(g, o.from, o.to), { duration: D, delay: 60, easing: EASE_IN, fill: "both" }),
      cl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: D - 100, easing: "ease-out", fill: "both" }),
    );
    for (const e of o.hide ?? []) fx.push(e.animate([{ opacity: 0 }, { opacity: 0 }], { duration: D + 60 }));
  }
  playing = fx;
  let fired = false;
  const end = () => {
    if (fired) return;
    fired = true;
    if (onSettle === end) {
      onSettle = null;
      playing = null;
    }
    g?.remove();
    o.done();
  };
  onSettle = end;
  if (fx.length === 0) {
    end();
    return fx;
  }
  const last = fx.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
  last.finished.then(end, end);
  return fx;
}

/** Resolves after the browser has painted whatever React just committed. */
export const afterPaint = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
