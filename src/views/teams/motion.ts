/**
 * Motion for the teams page (D153 step 7, spec 50): C56 (stars fly between the
 * card and the canvas), C58 (sending: the envelope folds into light and runs
 * along each chosen flow), C59 (a new flow lights up like a constellation; a
 * new member's star is born). The orbit style (D157, §12–§22) reuses all of it
 * with its own timings and a cube that flies and flares: C62 open and back,
 * C64 sending through the cube, C65 a flow drawn and a member launched.
 *
 * Same rules as `lib/fx.ts`: reduced motion means the result at once, only a
 * change starts anything (a click, a successful write), and React keeps owning
 * the DOM — everything this file adds (the flying stars, the folding envelope,
 * the comets and blooms inside the canvas) is its own node and it removes it
 * itself. Shapes fly; text never does — names appear once their star lands
 * (the design's C42 lesson).
 */

import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import type { LayoutSkin } from "../../types";
import { hexPoints } from "./orbit";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const ease3 = (k: number) => 1 - Math.pow(1 - k, 3);
const quad = (a: Point, b: Point, bend: number, u: number): Point => {
  const c = { x: (a.x + b.x) / 2 - (b.y - a.y) * bend, y: (a.y + b.y) / 2 + (b.x - a.x) * bend };
  return {
    x: (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * c.x + u * u * b.x,
    y: (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * c.y + u * u * b.y,
  };
};

/** Timings shared with the CSS (styles.css, teams section). */
export const OPEN_OUT_MS = 180;
export const OPEN_FLY_MS = 620;
export const BACK_OUT_MS = 160;
export const BACK_FLY_MS = 560;
/**
 * C58 / C64: fold the envelope, fly to the sender, then run each flow. The
 * orbit's lights take a little longer (they go round through the cube) and
 * leave almost together, so they read as one light splitting.
 */
export interface SendTiming {
  fold: number;
  fly: number;
  along: number;
  stag: number;
}
/** The envelope's fold and its flight to the sender are the same in both styles. */
const FOLD_MS = 240;
const FLY_MS = 400;
const SEND_STAR: SendTiming = { fold: FOLD_MS, fly: FLY_MS, along: 620, stag: 130 };
const SEND_ORBIT: SendTiming = { fold: FOLD_MS, fly: FLY_MS, along: 760, stag: 40 };
export const sendTiming = (skin: LayoutSkin): SendTiming => (skin === "orbit" ? SEND_ORBIT : SEND_STAR);
/** When the k-th downstream receives its light — its result row appears then. */
export const arriveAt = (k: number, skin: LayoutSkin) => {
  const s = sendTiming(skin);
  return s.fold + s.fly + s.along + k * s.stag;
};

export type StarState = "ok" | "pending" | "missing";

/** The id the orbit's cube flies under, next to the members' ids (C62). */
export const CORE = "__core";
/** The cube's edge on the canvas and on a card, and its line width there. */
export const CUBE = { e: 34, bw: 2 } as const;
export const MINI_CUBE = { e: 12, bw: 1.2 } as const;

// ── C56: the hand-off between the list and the canvas ─────────────────────
//
// Opening a team swaps the whole page, so the card's stars are measured on the
// way out and left here; the canvas takes them once it has fitted its view.
// Going back runs the other way. Stale hand-offs are dropped: a flight from a
// page the user has long left would come from nowhere.

/** What one side hands the other: where each star was, and the canvas's zoom then (the cube flies from that size). */
export interface Parked {
  from: Record<string, Point>;
  scale: number;
}

let parked: { teamId: string; dir: "open" | "back"; from: Record<string, Point>; scale: number; t: number } | null = null;

export function parkStars(teamId: string, dir: "open" | "back", from: Record<string, Point>, scale = 1) {
  parked = Object.keys(from).length > 0 ? { teamId, dir, from, scale, t: performance.now() } : null;
}

/** Whether stars are waiting for this page — asked at first render, so the
 *  canvas can start hidden instead of showing for a frame and then hiding. */
export function peekStars(teamId: string, dir: "open" | "back"): boolean {
  return parked !== null && parked.teamId === teamId && parked.dir === dir && performance.now() - parked.t <= 2000;
}

export function takeStars(teamId: string, dir: "open" | "back"): Parked | null {
  const p = parked;
  if (p === null || p.teamId !== teamId || p.dir !== dir) return null;
  parked = null;
  return performance.now() - p.t <= 2000 ? { from: p.from, scale: p.scale } : null;
}

/** Screen centres of every `[data-star]` under `scope`, keyed by member id. */
export function starCentres(scope: ParentNode | null): Record<string, Point> {
  const out: Record<string, Point> = {};
  if (scope === null) return out;
  for (const el of scope.querySelectorAll<HTMLElement>("[data-star]")) {
    const id = el.dataset.star;
    const c = centreOf(el);
    if (id !== undefined && c !== null) out[id] = c;
  }
  return out;
}

/**
 * Stars fly from `from` to `to` (screen points), one after another 45ms apart,
 * each trailing a beam of light; lines between them (the team's flows) follow
 * and fade at the end. Each one flashes as it lands. Resolves when the last
 * has landed and the layer is gone.
 *
 * The orbit (C62, C65) asks for more: its own bend, a size per id (the cube
 * grows from the card's 12px to the canvas's zoom), a smaller swell, and
 * `dress` to put the cube inside the flying element that stands for it.
 */
export function flyStars(
  ids: string[],
  from: Record<string, Point>,
  to: Record<string, Point>,
  o: {
    dur: number;
    back?: boolean;
    state: (id: string) => StarState | "core";
    edges: { from: string; to: string }[];
    bend?: number;
    swell?: number;
    size?: (id: string) => [number, number];
    dress?: (id: string, el: HTMLElement) => void;
  },
): Promise<void> {
  const pair = ids.filter((id) => from[id] !== undefined && to[id] !== undefined);
  if (pair.length === 0 || motionOff()) return Promise.resolve();
  const bend = o.bend ?? 0.16;
  const stag = 45;
  const sizes = (id: string): [number, number] => o.size?.(id) ?? (o.back === true ? [1, 0.7] : [0.7, 1]);
  const swell = o.swell ?? 0.45;

  const layer = document.createElement("div");
  layer.className = "tv-flylayer";
  layer.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tv-flylines");
  layer.appendChild(svg);
  const els: Record<string, HTMLElement> = {};
  for (const id of pair) {
    const star = document.createElement("i");
    star.className = "tv-flystar";
    star.dataset.st = o.state(id);
    o.dress?.(id, star);
    // Start where it starts: until the first frame runs it would sit at the
    // layer's corner — a 16px star there is mostly off screen, the orbit's
    // 48px cube is not.
    star.style.transform = `translate(${from[id].x.toFixed(1)}px,${from[id].y.toFixed(1)}px) scale(${sizes(id)[0]})`;
    layer.appendChild(star);
    els[id] = star;
  }
  const edges = o.edges.filter((e) => pair.includes(e.from) && pair.includes(e.to));
  const lines = edges.map(() => {
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    svg.appendChild(l);
    return l;
  });
  document.body.appendChild(layer);

  pair.forEach((id, i) => {
    if (Math.hypot(from[id].x - to[id].x, from[id].y - to[id].y) > 24) {
      fx.beam(from[id], to[id], { dur: o.dur, delay: i * stag, bend, width: 2, trail: 0.32 });
    }
  });

  const span = o.dur + (pair.length - 1) * stag;
  const t0 = performance.now();
  const landed = new Set<string>();
  const cur: Record<string, Point> = {};
  return new Promise((resolve) => {
    const frame = (now: number) => {
      if (!layer.isConnected) {
        resolve();
        return;
      }
      pair.forEach((id, i) => {
        const k = clamp((now - t0 - i * stag) / o.dur, 0, 1);
        const p = quad(from[id], to[id], bend, Math.min(1, ease3(k) * 1.08));
        cur[id] = p;
        const [s0, s1] = sizes(id);
        const s = s0 + (s1 - s0) * ease3(k) + swell * Math.sin(Math.PI * k);
        els[id].style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px) scale(${s.toFixed(3)})`;
        if (k >= 1 && !landed.has(id)) {
          landed.add(id);
          fx.flash(to[id], { r: 34, dur: 480, alpha: 0.55 });
        }
      });
      const k = clamp((now - t0) / span, 0, 1);
      edges.forEach((e, j) => {
        const a = cur[e.from];
        const b = cur[e.to];
        const l = lines[j];
        l.setAttribute("x1", String(a.x));
        l.setAttribute("y1", String(a.y));
        l.setAttribute("x2", String(b.x));
        l.setAttribute("y2", String(b.y));
        l.style.opacity = (k < 0.8 ? 1 : (1 - k) / 0.2).toFixed(2);
      });
      if (k < 1) requestAnimationFrame(frame);
      else {
        layer.remove();
        resolve();
      }
    };
    requestAnimationFrame(frame);
  });
}

// ── C58: sending ──────────────────────────────────────────────────────────

/**
 * The send dialog fades where it stands instead of sinking (spec 50 §9):
 * the envelope is about to fold out of it. A copy fades; the real one is
 * marked so Modal's own exit does not play on top.
 */
export function fadeDialog(backdrop: HTMLElement | null) {
  if (backdrop === null) return;
  backdrop.dataset.exit = "none";
  if (motionOff()) return;
  const ghost = backdrop.cloneNode(true) as HTMLElement;
  ghost.inert = true;
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("tv-ghost");
  document.body.appendChild(ghost);
  const a = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-out", fill: "forwards" });
  void a.finished.catch(() => undefined).then(() => ghost.remove());
}

/**
 * The envelope's note folds into a point of light (text fades, the box
 * shrinks to a 16px circle) and flies to `to` — asked for only once the fold
 * is done, because the canvas may have panned in the meantime.
 */
export function foldLetter(r: DOMRect, text: string, to: () => Point | null): Promise<void> {
  if (motionOff()) return Promise.resolve();
  const el = document.createElement("div");
  el.className = "tv-letter";
  el.setAttribute("aria-hidden", "true");
  const tx = document.createElement("span");
  tx.className = "tv-letter-t";
  tx.textContent = text;
  const glow = document.createElement("i");
  glow.className = "tv-letter-glow";
  el.append(tx, glow);
  const box = {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
    borderRadius: "10px",
  };
  Object.assign(el.style, box);
  document.body.appendChild(el);
  const a = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  tx.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: "forwards" });
  glow.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 60, fill: "forwards" });
  const fold = el.animate(
    [box, { left: `${a.x - 8}px`, top: `${a.y - 8}px`, width: "16px", height: "16px", borderRadius: "50%" }],
    { duration: FOLD_MS, easing: "cubic-bezier(.55,0,.2,1)", fill: "forwards" },
  );
  return fold.finished.then(
    () =>
      new Promise<void>((resolve) => {
        const b = to();
        if (b === null || !el.isConnected) {
          el.remove();
          resolve();
          return;
        }
        fx.beam(a, b, { dur: FLY_MS, bend: 0.2, width: 2.4, trail: 0.4 });
        const t0 = performance.now();
        const frame = (now: number) => {
          if (!el.isConnected) {
            resolve();
            return;
          }
          const k = clamp((now - t0) / FLY_MS, 0, 1);
          const p = quad(a, b, 0.2, Math.min(1, ease3(k) * 1.08));
          el.style.transform = `translate(${(p.x - a.x).toFixed(1)}px,${(p.y - a.y).toFixed(1)}px)`;
          if (k < 1) requestAnimationFrame(frame);
          else {
            el.remove();
            fx.flash(b, { r: 60, dur: 520, alpha: 0.7 });
            resolve();
          }
        };
        requestAnimationFrame(frame);
      }),
    () => el.remove(),
  );
}

/**
 * A comet along a flow (canvas coordinates): one bright head and three
 * smaller lights behind it, riding `offset-path` inside the viewport so they
 * pan and zoom with the canvas.
 */
export function comet(viewport: Element | null, d: string, delay: number, dur: number) {
  if (viewport === null || motionOff()) return;
  for (const i of [0, 1, 2, 3]) {
    const s = document.createElement("span");
    s.className = i === 0 ? "tv-comet" : "tv-comet tail";
    s.setAttribute("aria-hidden", "true");
    s.style.setProperty("offset-path", `path('${d}')`);
    s.style.setProperty("--i", String(i));
    viewport.appendChild(s);
    const a = s.animate(
      [
        { offsetDistance: "0%", opacity: 0 },
        { opacity: 1, offset: 0.1 },
        { offsetDistance: "100%", opacity: i > 0 ? 0.2 : 1 },
      ],
      { duration: dur, delay: delay + i * 26, easing: "cubic-bezier(.45,0,.3,1)", fill: "both" },
    );
    void a.finished.catch(() => undefined).then(() => s.remove());
  }
}

/** A bloom at `p` (canvas coordinates): a ring spreading and a flare. */
export function bloom(viewport: Element | null, p: Point) {
  if (viewport === null || motionOff()) return;
  const b = document.createElement("span");
  b.className = "tv-bloom";
  b.setAttribute("aria-hidden", "true");
  b.style.transform = `translate(${p.x}px,${p.y}px)`;
  b.append(document.createElement("i"), document.createElement("i"));
  viewport.appendChild(b);
  window.setTimeout(() => b.remove(), 900);
}

/** Restarts a one-shot CSS class (the node's ring, the rail row's sweep). */
export function replay(el: Element | null, cls: string, ms: number) {
  if (el === null || motionOff()) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), ms);
}

// ── C59: a new flow, a new member ─────────────────────────────────────────

/**
 * Small stars light up along the new line, one every ~40px, each 55ms after
 * the last; the line then draws through them from its start, and the marks
 * on it fade in last. `onEnd` fires when the line reaches its target (660ms),
 * which is where the caller blooms.
 */
export function drawFlow(path: SVGPathElement | null, viewport: Element | null, marks: Element[], onEnd: () => void) {
  if (path === null || viewport === null || motionOff()) return;
  const L = path.getTotalLength();
  const n = Math.max(5, Math.min(9, Math.round(L / 40)));
  for (let i = 1; i < n; i++) {
    const q = path.getPointAtLength((L * i) / n);
    const d = document.createElement("span");
    d.className = "tsm-cdot";
    d.setAttribute("aria-hidden", "true");
    d.append(document.createElement("i"));
    d.style.transform = `translate(${q.x.toFixed(1)}px,${q.y.toFixed(1)}px)`;
    d.style.setProperty("--d", `${(i - 1) * 55}ms`);
    viewport.appendChild(d);
    window.setTimeout(() => d.remove(), 1400);
  }
  path.animate(
    [
      { strokeDasharray: `${L}`, strokeDashoffset: `${L}` },
      { strokeDasharray: `${L}`, strokeDashoffset: "0" },
    ],
    { duration: 520, delay: 160, easing: "cubic-bezier(.45,0,.2,1)", fill: "backwards" },
  );
  for (const el of marks) {
    el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.75 }, { opacity: 1 }], { duration: 760 });
  }
  window.setTimeout(onEnd, 660);
}

// ── The orbit's cube (C62, C64, C65) ──────────────────────────────────────

/**
 * The wire cube as plain DOM, for what this file adds and removes itself (the
 * cube that flies, the bright one that flares). The same markup as
 * `WireCube.tsx`, which draws the ones React owns: six faces turned into a
 * box, settled at the logo's angle.
 */
export function cubeNode(e: number, bw: number, cls = ""): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "tvo-cw";
  const cube = document.createElement("span");
  cube.className = cls === "" ? "tvo-cube" : `tvo-cube ${cls}`;
  cube.style.setProperty("--e", `${e}px`);
  cube.style.setProperty("--bw", `${bw}px`);
  for (let i = 0; i < 6; i++) cube.appendChild(document.createElement("i"));
  wrap.appendChild(cube);
  return wrap;
}

/**
 * A light passing through the cube (C64, C65): its edges light up and dim
 * again, and a hexagon of its own outline spreads out and fades — never a
 * flash of the whole area.
 */
export function flareCore(orb: Element | null) {
  if (orb === null || motionOff()) return;
  const f = document.createElement("span");
  f.className = "tvo-flash";
  f.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tvo-hex");
  svg.setAttribute("width", "80");
  svg.setAttribute("height", "80");
  svg.setAttribute("viewBox", "-40 -40 80 80");
  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("points", hexPoints(CUBE.e));
  svg.appendChild(poly);
  f.append(svg, cubeNode(CUBE.e, CUBE.bw, "hot"));
  orb.appendChild(f);
  window.setTimeout(() => f.remove(), 720);
}

/**
 * C65, a new flow on the orbit: the arc draws itself from the sender's planet
 * (60–780ms), its arrowhead, lights and bolt fade in over the last fifth, the
 * cube flares when the drawing passes it, and `onEnd` (the bloom) fires as the
 * line arrives. No little stars along the way — those are the star map's.
 */
export function drawArc(
  path: SVGPathElement | null,
  marks: Element[],
  flareAt: number | null,
  onFlare: () => void,
  onEnd: () => void,
) {
  if (path === null || motionOff()) return;
  const L = path.getTotalLength();
  const dur = 720;
  const delay = 60;
  path.animate(
    [
      { strokeDasharray: `${L}`, strokeDashoffset: `${L}` },
      { strokeDasharray: `${L}`, strokeDashoffset: "0" },
    ],
    { duration: dur, delay, easing: "cubic-bezier(.45,0,.3,1)", fill: "backwards" },
  );
  for (const el of marks) {
    el.animate([{ opacity: 0 }, { opacity: 0, offset: 0.8 }, { opacity: 1 }], { duration: dur + 120 });
  }
  if (flareAt !== null) window.setTimeout(onFlare, delay + Math.round(dur * flareAt));
  window.setTimeout(onEnd, delay + dur + 20);
}

/**
 * C62: what the orbit adds to a flight between a card and the canvas. The
 * cube flies as well — growing from the card's 12px to the canvas's zoom on
 * the way in, shrinking back on the way home, turning a quarter (the other
 * way home) to settle at the logo's angle — and a spoke of light joins it to
 * every planet instead of the team's flows.
 */
export function orbitFlight(members: string[], zoom: number, back: boolean, state: (id: string) => StarState) {
  const small = MINI_CUBE.e / CUBE.e;
  return {
    ids: [CORE, ...members],
    edges: members.map((id) => ({ from: CORE, to: id })),
    bend: 0.1,
    state: (id: string): StarState | "core" => (id === CORE ? "core" : state(id)),
    size: (id: string): [number, number] =>
      id === CORE ? (back ? [zoom, small] : [small, zoom]) : back ? [1, 0.7] : [0.7, 1],
    dress: (id: string, el: HTMLElement) => {
      if (id === CORE) el.appendChild(cubeNode(CUBE.e, CUBE.bw, back ? "turn-back" : "turn"));
    },
  };
}
