/**
 * Motion for the templates view (D153, spec 60): the card that grows into the
 * editor and back (C141, the signature moment), the light that walks a card's
 * phase band (C140), the band going dark before a delete (C151), and the light
 * that runs down the editor's rail on save (C147 / C148).
 *
 * Same rules as lib/fx.ts and lib/listMotion.ts: reduced motion means the end
 * state at once, nothing here runs on render (the view fires these from
 * handlers), and React keeps owning its DOM — what travels is a picture in an
 * overlay, or a transform / opacity on a real node that ends where React put
 * it. The only foreign nodes are the overlay and the rail's running dot, both
 * removed when they finish.
 */
import { motionOff } from "../../lib/fx";
import { EASE_IN, EASE_OUT, boxOf, pictureOf, type Box } from "../../lib/listMotion";

/** C140: one cell every 140 ms; a band of n cells runs n × 140 + 760. */
const BAND_STEP = 140;

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

const px = (r: Box) => ({
  left: `${r.left}px`,
  top: `${r.top}px`,
  width: `${r.width}px`,
  height: `${r.height}px`,
});

const shown = (r: Box | null | undefined): r is Box =>
  r != null && r.width > 4 && r.height > 4 && r.top + r.height > 0 && r.top < window.innerHeight;

/** `r` cut to the part of the content area you can see. */
function clip(r: Box, m: Box): Box {
  const top = Math.max(r.top, m.top);
  const bottom = Math.min(r.top + r.height, m.top + m.height);
  return { left: r.left, top, width: r.width, height: Math.max(0, bottom - top) };
}

const endOf = (a: Animation) => Number(a.effect?.getComputedTiming().endTime ?? 0);

// ── C140: the light along a card's band ─────────────────────────────────────

const bandTimers = new WeakMap<Element, number>();

/**
 * Plays a card's band once (the CSS behind `.tp-band.go`) and returns how
 * long it runs, so the caller can space the next card after it. Zero when
 * there is nothing to play.
 */
export function bandRun(card: Element | null | undefined): number {
  const band = card?.querySelector<HTMLElement>(".tp-band");
  if (!band || motionOff()) return 0;
  const n = Number(band.style.getPropertyValue("--n")) || 1;
  const ms = n * BAND_STEP + 760;
  band.classList.remove("go");
  void band.offsetWidth;
  band.classList.add("go");
  window.clearTimeout(bandTimers.get(band));
  bandTimers.set(
    band,
    window.setTimeout(() => band.classList.remove("go"), ms),
  );
  return ms;
}

/**
 * C151: before a deleted card leaves, its band goes dark from the last cell
 * to the first, then the card fades. Resolves when the caller should swap the
 * list (the card is invisible by then).
 */
export async function bandOff(card: HTMLElement | null): Promise<void> {
  if (card === null || motionOff()) return;
  card.style.pointerEvents = "none";
  const cells = [...card.querySelectorAll<HTMLElement>(".tp-cell")];
  const n = cells.length;
  const out: Keyframe[] = [{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }];
  cells.forEach((c, k) => {
    const delay = (n - 1 - k) * 90;
    c.querySelector(".tp-cell-lt")?.animate(out, { duration: 380, delay, fill: "both" });
    for (const m of c.querySelectorAll(".tp-mk")) {
      m.animate(out, { duration: 380, delay, fill: "both", pseudoElement: "::after" });
    }
  });
  const fade = n * 90 + 260;
  card.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, delay: fade, fill: "forwards" });
  await wait(fade + 230);
}

// ── Cards moving to their new place (2-D FLIP) ──────────────────────────────

/** Where each card sits, relative to the grid's own corner — a scroll between
 *  two readings does not read as every card having moved. */
export function cardSpots(grid: HTMLElement | null): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (grid === null) return out;
  const g = grid.getBoundingClientRect();
  for (const el of grid.querySelectorAll<HTMLElement>(":scope > [data-tpl]")) {
    const r = el.getBoundingClientRect();
    out.set(el.dataset.tpl ?? "", { x: r.left - g.left, y: r.top - g.top });
  }
  return out;
}

/** Cards that moved since `before` slide from there (460 ms). */
export function slideCards(grid: HTMLElement | null, before: Map<string, { x: number; y: number }>) {
  if (grid === null || motionOff()) return;
  const g = grid.getBoundingClientRect();
  for (const el of grid.querySelectorAll<HTMLElement>(":scope > [data-tpl]")) {
    const was = before.get(el.dataset.tpl ?? "");
    if (was === undefined) continue;
    const r = el.getBoundingClientRect();
    const dx = was.x - (r.left - g.left);
    const dy = was.y - (r.top - g.top);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: 460,
      easing: EASE_OUT,
    });
  }
}

// ── C141: the card grows into the editor, and back ──────────────────────────

/** The run in flight: its overlay, its animations, and its tidy-up. */
let current: { layer: HTMLElement; anims: Animation[]; end: () => void } | null = null;

/** True while a C141 run is on screen (C140 waits for it). */
export function transitionBusy(): boolean {
  return current !== null;
}

/** Plays whatever run is in flight to its end, right now. */
export function settleTransition() {
  const c = current;
  if (c === null) return;
  for (const a of c.anims) {
    try {
      a.finish();
    } catch {
      /* already finished or cancelled */
    }
  }
  c.end();
}

function overlay(): HTMLDivElement {
  const fx = document.createElement("div");
  fx.className = "tp-fx";
  fx.setAttribute("aria-hidden", "true");
  fx.inert = true;
  document.body.appendChild(fx);
  return fx;
}

function div(cls: string, host: HTMLElement): HTMLDivElement {
  const e = document.createElement("div");
  e.className = cls;
  host.appendChild(e);
  return e;
}

/** Resolves when the last of `anims` ends; registers the run meanwhile. */
function track(layer: HTMLElement, anims: Animation[], done?: () => void): Promise<void> {
  return new Promise((resolve) => {
    let fired = false;
    const end = () => {
      if (fired) return;
      fired = true;
      if (current?.layer === layer) current = null;
      layer.remove();
      done?.();
      resolve();
    };
    current = { layer, anims, end };
    if (anims.length === 0) {
      end();
      return;
    }
    const last = anims.reduce((a, b) => (endOf(b) > endOf(a) ? b : a));
    last.finished.then(end, end);
  });
}

const editorOf = (main: HTMLElement) => main.querySelector<HTMLElement>(".view.tp-ed");
const tilesOf = (root: Element) => [...root.querySelectorAll(".tp-ph")].map(boxOf);

/**
 * C141, opening. From a card: the list (sidebar included) dims and its other
 * cards sink; an empty frame grows from the card to the editor; the card's
 * phase cells fly one after another into the editor's rail and the stations
 * show as each lands; the editor's blocks rise once the frame is there.
 * From "New template" (`source === null`): no growing out of a button
 * (D-0035) — the frame rises where the editor will be.
 *
 * `swap` must commit synchronously (flushSync): everything after it measures
 * the editor React just rendered. A source off screen or reduced motion just
 * swaps.
 */
export function openEditorFx(o: { main: HTMLElement | null; source: HTMLElement | null; swap: () => void }) {
  settleTransition();
  const main = o.main;
  const rise = o.source === null;
  const r0 = o.source === null ? null : boxOf(o.source);
  if (main === null || motionOff() || (!rise && !shown(r0))) {
    o.swap();
    if (main !== null) main.scrollTop = 0;
    return;
  }
  const mr = boxOf(main);
  const c0 = o.source === null ? [] : [...o.source.querySelectorAll(".tp-cell")].map(boxOf);
  const fx = overlay();

  // The list's picture stays where it was; the real one is about to go.
  const back = div("tp-fx-back", fx);
  Object.assign(back.style, px(mr));
  const page = main.cloneNode(true) as HTMLElement;
  page.classList.add("tp-fx-page");
  Object.assign(page.style, { width: `${mr.width}px`, height: `${mr.height}px` });
  back.appendChild(page);
  page.scrollTop = main.scrollTop;
  const dim = div("tp-fx-dim", fx);
  const srcCard = o.source;
  const srcPic = srcCard === null ? null : pictureOf(srcCard);

  o.swap();
  main.scrollTop = 0;
  const ed = editorOf(main);
  if (ed === null) {
    fx.remove();
    return;
  }
  const to = clip(boxOf(ed), mr);
  const tiles = tilesOf(ed);
  const OPEN = rise ? 360 : 480;
  const A: Animation[] = [];

  A.push(dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: rise ? 220 : 240, easing: "ease-out", fill: "both" }));
  const g = div("bx-ghost tp-fx-frame", fx);
  if (rise) {
    A.push(
      g.animate(
        [
          { ...px(to), opacity: 0, transform: "translateY(18px)" },
          { ...px(to), opacity: 1, transform: "none" },
        ],
        { duration: OPEN, easing: EASE_OUT, fill: "both" },
      ),
    );
  } else if (r0 !== null && srcCard !== null) {
    const id = srcCard.dataset.tpl;
    for (const c of page.querySelectorAll<HTMLElement>("[data-tpl]")) {
      if (c.dataset.tpl === id) {
        c.style.opacity = "0";
        continue;
      }
      A.push(
        c.animate(
          [
            { transform: "none", opacity: 1 },
            { transform: "translateY(16px)", opacity: 0.35 },
          ],
          { duration: 380, easing: EASE_OUT, fill: "both" },
        ),
      );
    }
    if (srcPic !== null) {
      srcPic.classList.add("tp-fx-src");
      g.appendChild(srcPic);
      A.push(srcPic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: "ease-out", fill: "both" }));
    }
    A.push(g.animate([px(r0), px(to)], { duration: OPEN, easing: EASE_OUT, fill: "both" }));
    A.push(
      g.animate([{ transform: "translateX(-120%)" }, { transform: "translateX(120%)" }], {
        duration: 620,
        delay: 40,
        easing: "ease-out",
        fill: "both",
        pseudoElement: "::after",
      }),
    );
  }
  A.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: OPEN, fill: "forwards" }));
  A.push(back.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, delay: OPEN - 60, fill: "forwards" }));
  A.push(dim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, delay: OPEN, easing: "ease-out", fill: "forwards" }));

  // The cells fly to the rail one after another; past the eighth they go
  // together, so a long template does not keep its last station waiting.
  const land: number[] = [];
  c0.forEach((r, i) => {
    const tr = tiles[i];
    if (tr === undefined) return;
    const e = div("tp-fx-cell", fx);
    const d0 = 80 + Math.min(i, 8) * 60;
    land[i] = d0 + 520;
    A.push(e.animate([px(r), px(tr)], { duration: 520, delay: d0, easing: EASE_OUT, fill: "both" }));
    A.push(e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, delay: d0 + 520, fill: "forwards" }));
  });

  [...ed.children].forEach((k, i) =>
    A.push(
      k.animate(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 300, delay: OPEN - 60 + Math.min(i, 5) * 45, easing: EASE_OUT, fill: "backwards" },
      ),
    ),
  );
  ed.querySelectorAll(".tp-it").forEach((it, i) => {
    const at = land[i] !== undefined ? land[i] - 30 : OPEN + 80 + Math.min(i, 8) * 50;
    for (const x of it.querySelectorAll(":scope > .tp-st, :scope > .tp-seg")) {
      A.push(x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: at, easing: "ease-out", fill: "backwards" }));
    }
  });
  const lastLand = Math.max(OPEN + 80, ...land.filter((x) => x !== undefined));
  for (const x of ed.querySelectorAll(".tp-link, .tp-rail-lt")) {
    A.push(x.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, delay: lastLand, fill: "backwards" }));
  }
  void track(fx, A);
}

/** Scrolls the content area so `el` is in view (the card a closing frame lands on). */
function reveal(main: HTMLElement, el: HTMLElement | null) {
  if (el === null) return;
  const m = main.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top < m.top + 8) main.scrollTop -= m.top + 8 - r.top;
  else if (r.bottom > m.bottom - 8) main.scrollTop += Math.min(r.top - m.top - 8, r.bottom - m.bottom + 8);
}

/**
 * C141 backwards (also how C147 lands a save): the editor's words fade, the
 * frame shrinks into the card it came from while the cells fly back in
 * reverse order, the other cards come back up from where they sank, and the
 * card itself only shows once everything has landed. A template opened from
 * "New template" and closed unsaved has no card to go to: the editor sinks
 * 12 px and fades (`sink`).
 *
 * `swap` renders the list (flushSync) and may return where the other cards
 * were before a new one took its place — the save of a new template renders
 * the old list first to take that reading. Resolves when the overlay is gone.
 */
export function closeEditorFx(o: {
  main: HTMLElement | null;
  swap: () => Map<string, { x: number; y: number }> | null;
  target: () => HTMLElement | null;
  sink: boolean;
}): Promise<void> {
  settleTransition();
  const main = o.main;
  const ed = main === null ? null : editorOf(main);
  if (main === null || ed === null || motionOff()) {
    o.swap();
    if (main !== null) reveal(main, o.target());
    return Promise.resolve();
  }
  const mr = boxOf(main);
  const full = boxOf(ed);
  const from = clip(full, mr);
  const tiles = tilesOf(ed);
  const out = pictureOf(ed);

  const fx = overlay();
  const dim = div("tp-fx-dim", fx);
  const g = div("bx-ghost tp-fx-frame", fx);
  Object.assign(g.style, px(from));
  out.classList.add("tp-fx-src");
  // The frame is the visible part; the picture keeps the editor's own top.
  out.style.transform = `translateY(${Math.round(full.top - from.top)}px)`;
  g.appendChild(out);

  const before = o.swap();
  const card = o.target();
  reveal(main, card);
  const grid = card?.parentElement ?? null;
  const r1 = card === null ? null : boxOf(card);
  const landed = !o.sink && shown(r1);
  const cells = landed && card !== null ? [...card.querySelectorAll(".tp-cell")].map(boxOf) : [];
  const D0 = 120;
  const CLOSE = 420;
  const FLY = 460;
  const A: Animation[] = [];

  if (!o.sink) A.push(out.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "ease-in", fill: "both" }));
  A.push(dim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out", fill: "both" }));
  if (!o.sink && grid !== null) {
    const g0 = grid.getBoundingClientRect();
    for (const c of grid.querySelectorAll<HTMLElement>(":scope > [data-tpl]")) {
      if (c === card) continue;
      const r = c.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      const b = before?.get(c.dataset.tpl ?? "");
      const dx = b === undefined ? 0 : Math.round(b.x - (r.left - g0.left));
      const dy = b === undefined ? 0 : Math.round(b.y - (r.top - g0.top));
      A.push(
        c.animate(
          [
            { transform: `translate(${dx}px, ${dy + 16}px)`, opacity: 0.35 },
            { transform: "none", opacity: 1 },
          ],
          { duration: 460, delay: D0, easing: EASE_OUT, fill: "backwards" },
        ),
      );
    }
  }

  let landAt = D0 + 300;
  if (o.sink) {
    A.push(
      g.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateY(12px)" },
        ],
        { duration: 240, delay: D0, easing: "ease-in", fill: "both" },
      ),
    );
    landAt = D0 + 240;
  } else if (landed && r1 !== null && card !== null) {
    A.push(g.animate([px(from), px(r1)], { duration: CLOSE, delay: D0, easing: EASE_IN, fill: "both" }));
    const cl = pictureOf(card);
    cl.classList.add("tp-fx-src");
    g.appendChild(cl);
    A.push(cl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: D0 + CLOSE - 120, fill: "both" }));
    const n = Math.min(tiles.length, cells.length);
    let lastCell = 0;
    for (let i = 0; i < n; i++) {
      const e = div("tp-fx-cell", fx);
      const d0 = 40 + Math.min(n - 1 - i, 8) * 45;
      lastCell = Math.max(lastCell, d0 + FLY);
      A.push(e.animate([px(tiles[i]), px(cells[i])], { duration: FLY, delay: d0, easing: EASE_OUT, fill: "both" }));
      A.push(e.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, delay: Math.max(d0 + FLY, D0 + CLOSE), fill: "forwards" }));
    }
    landAt = Math.max(D0 + CLOSE, lastCell);
    A.push(card.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: landAt - 40, fill: "backwards" }));
    A.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, delay: landAt, fill: "forwards" }));
  } else {
    A.push(g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, delay: 60, fill: "both" }));
  }
  A.push(dim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, delay: landAt, easing: "ease-out", fill: "forwards" }));
  return track(fx, A);
}

// ── C147 / C148: the light down the editor's rail ───────────────────────────

/** `el`'s position inside `root`, by layout offsets — unaffected by any
 *  transform still playing on the way (a station sliding in reads where it
 *  will be, not where it is this frame). */
export function offsetIn(el: HTMLElement, root: HTMLElement): { x: number; y: number } {
  let x = 0;
  let y = 0;
  let cur: HTMLElement | null = el;
  while (cur !== null && cur !== root) {
    x += cur.offsetLeft;
    y += cur.offsetTop;
    const p = cur.offsetParent as HTMLElement | null;
    if (p !== null && p !== root) {
      x += p.clientLeft;
      y += p.clientTop;
    }
    cur = p;
  }
  return { x, y };
}

/**
 * The save's light: a dot runs down the rail from the first station — to the
 * bottom of the last phase when the save went through (`ok`), to the station
 * of phase `stop` when core refused it. Each station's tile lights as the dot
 * passes, each gate mark on the track too. On success everything is left lit
 * (`.lit`, a class, so the picture the closing frame takes of the editor
 * carries it); on refusal the dot and the lights go out. Resolves when the
 * caller should go on (close the editor / show the error).
 */
export async function runRail(rail: HTMLElement | null, stop: number, ok: boolean): Promise<void> {
  if (rail === null || motionOff()) return;
  const its = [...rail.querySelectorAll<HTMLElement>(".tp-it")];
  if (its.length === 0) return;
  const cy = (el: HTMLElement) => offsetIn(el, rail).y + el.offsetHeight / 2;
  const stations = its.map((it) => it.querySelector<HTMLElement>(".tp-stn"));
  if (stations.some((s) => s === null)) return;
  const stn = stations.map((s) => cy(s as HTMLElement));
  const s0 = stations[0] as HTMLElement;
  const last = its[its.length - 1];
  const at0 = Math.min(Math.max(stop, 0), its.length - 1);
  const y0 = stn[0];
  const yEnd = ok ? offsetIn(last, rail).y + last.offsetHeight - 2 : stn[at0];
  const T = Math.min(1300, Math.max(420, (yEnd - y0) * 1.8));
  const at = (y: number) => ((y - y0) / Math.max(1, yEnd - y0)) * T;

  const dot = document.createElement("i");
  dot.className = "tp-run";
  dot.setAttribute("aria-hidden", "true");
  dot.style.left = `${Math.round(offsetIn(s0, rail).x + s0.offsetWidth / 2)}px`;
  dot.style.top = `${Math.round(y0)}px`;
  rail.appendChild(dot);

  const A: Animation[] = [];
  const lit: [Element, string | undefined][] = [];
  A.push(
    dot.animate(
      [
        { transform: "translateY(0)", opacity: 0 },
        { transform: "translateY(0)", opacity: 1, offset: 0.05 },
        { transform: `translateY(${Math.round(yEnd - y0)}px)`, opacity: 1 },
      ],
      { duration: T, easing: "linear", fill: "forwards" },
    ),
  );
  its.forEach((it, k) => {
    if (k > at0) return;
    const lt = it.querySelector(".tp-ph-lt");
    if (lt !== null) {
      lit.push([lt, undefined]);
      A.push(lt.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: at(stn[k]), fill: "both" }));
    }
    if (!ok && k === at0) return;
    for (const m of it.querySelectorAll<HTMLElement>(".tp-seg .tp-mk")) {
      lit.push([m, "::after"]);
      A.push(
        m.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180, delay: at(cy(m)), fill: "both", pseudoElement: "::after" }),
      );
    }
  });

  await wait(T + (ok ? 220 : 160));
  if (ok) {
    for (const it of its) it.classList.add("lit");
    for (const a of A) a.cancel();
    dot.remove();
    return;
  }
  dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 280, fill: "forwards" });
  for (const [el, pe] of lit) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 320, fill: "forwards", pseudoElement: pe });
  }
  await wait(330);
  dot.remove();
  for (const a of rail.getAnimations({ subtree: true })) {
    if (a instanceof CSSAnimation) continue;
    a.cancel();
  }
}
