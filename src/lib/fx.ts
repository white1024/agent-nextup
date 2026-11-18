/**
 * Shared motion plumbing for the D153 design (R1 relaxed by D154: CSS, the
 * Web Animations API and Canvas 2D, still no packages).
 *
 * Three rules every caller inherits from here rather than re-deciding:
 *
 *  - **Reduced motion means the result, at once.** The global CSS rule cannot
 *    reach `el.animate()` or a canvas, so every JS-driven effect asks
 *    `motionOff()` first and skips straight to its end state.
 *  - **Only on a real change.** Nothing in this file runs on render. Callers
 *    fire it from an event handler or from a diff hook (`usePulse`,
 *    `useFreshKeys`), never from a mount.
 *  - **Colours come from the tokens.** A glow that means "waiting on you" reads
 *    `--orange`, not a literal — the prototype hard-coded a slightly different
 *    amber for its canvas, which is exactly the drift the token sheet exists to
 *    prevent.
 *
 * No React here (lib/ rule, invariant 18): DOM only, and nothing touches the DOM
 * at import time, so the module stays importable from the node test runner.
 */

/** True when the user (or the OS) asked for reduced motion. */
export function motionOff(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** True when the light theme is in effect (pinned, or followed from the OS). */
export function lightTheme(): boolean {
  if (typeof document === "undefined") return false;
  const pinned = document.documentElement.dataset.theme;
  if (pinned === "light") return true;
  if (pinned === "dark") return false;
  return !window.matchMedia("(prefers-color-scheme: dark)").matches;
}

let probe: HTMLSpanElement | null = null;

/**
 * Resolves a colour token to `"r,g,b"` for canvas strings and `rgba()` math.
 * Goes through a hidden probe element so light-dark() and the active theme are
 * applied by the browser exactly as they are for every other surface.
 */
export function tokenRgb(name: string): string {
  if (probe === null || !probe.isConnected) {
    probe = document.createElement("span");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText = "position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;";
    document.body.appendChild(probe);
  }
  probe.style.color = `var(${name})`;
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(getComputedStyle(probe).color);
  return m ? `${Math.round(+m[1])},${Math.round(+m[2])},${Math.round(+m[3])}` : "143,136,255";
}

export interface Point {
  x: number;
  y: number;
}

// ── Where a page was entered from ───────────────────────────────────────────
//
// A few arrivals start their light where the click was, on a page that no
// longer exists by the time the destination has its data (C41: the sidebar's
// inbox badge → each unread envelope). The click leaves its point here; the
// destination takes it once, and only while it is fresh — a stale point would
// fire a beam from somewhere the user is no longer looking.

let origin: { key: string; at: Point; t: number } | null = null;

/** Leaves `at` for the page `key` to pick up (or clears it with `null`). */
export function stashOrigin(key: string, at: Point | null) {
  origin = at === null ? null : { key, at, t: performance.now() };
}

/** Takes the point left for `key`, if it is younger than `maxAge` ms. Once. */
export function takeOrigin(key: string, maxAge = 2000): Point | null {
  const o = origin;
  if (o === null || o.key !== key) return null;
  origin = null;
  return performance.now() - o.t <= maxAge ? o.at : null;
}

// ── A box handed from one overlay to the next ──────────────────────────────
//
// The command palette picking "record a decision" grows into that dialog
// (R-10-25, my-design review F5): it leaves its panel's box here and closes;
// the next dialog to open takes the box, once and only while it is fresh, and
// grows out of it instead of rising — over a scrim that is already there.

let handed: { key: string; box: Box; t: number } | null = null;

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Leaves `box` for the next overlay of kind `key`. */
export function stashBox(key: string, box: Box) {
  handed = { key, box, t: performance.now() };
}

/** Takes the box left for `key`, if it is younger than `maxAge` ms. Once. */
export function takeBox(key: string, maxAge = 800): Box | null {
  const h = handed;
  if (h === null || h.key !== key) return null;
  handed = null;
  return performance.now() - h.t <= maxAge ? h.box : null;
}

// ── A light split between two effects that do not know each other ──────────
//
// C30: a refused call reaches the projects overview's light core, and the
// core splits — one light to the project's card, one to the notification that
// says the agent is waiting (my-design review F15). The card's half belongs to
// the overview, the notification's to the toast stack, and the two learn of
// the refusal by different roads, in either order. So they meet here: the
// overview offers the core's point at the moment it splits; the toast, if it
// is already waiting, gets it at once, otherwise it finds it on arrival as
// long as it is fresh. A toast that waits in vain falls back to its own light.

const offers = new Map<string, { at: Point; t: number }>();
const waiters = new Map<string, (at: Point | null) => void>();

/** The overview's half: the light leaves `at` now. */
export function offerLight(key: string, at: Point) {
  const w = waiters.get(key);
  if (w !== undefined) {
    waiters.delete(key);
    w(at);
    return;
  }
  offers.set(key, { at, t: performance.now() });
}

/** The toast's half: the point to start from, or `null` after `maxWait` ms. */
export function awaitLight(key: string, maxWait: number): Promise<Point | null> {
  const o = offers.get(key);
  offers.delete(key);
  if (o !== undefined && performance.now() - o.t <= maxWait) return Promise.resolve(o.at);
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      if (waiters.get(key) === done) waiters.delete(key);
      resolve(null);
    }, maxWait);
    const done = (at: Point | null) => {
      window.clearTimeout(timer);
      resolve(at);
    };
    waiters.get(key)?.(null);
    waiters.set(key, done);
  });
}

/** Centre of an element's box in viewport coordinates. */
export function centreOf(el: Element | null | undefined): Point | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** The sidebar entry for a page (`data-view`), if the sidebar is showing it. */
export function navItem(view: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.sidebar [data-view="${CSS.escape(view)}"]`);
}

/**
 * The sidebar entry lights once (C195, C199): where something just went — a
 * saved edit into the Ledger, a new CLI into the agent overview. The entry's
 * own fill and an inset frame in the light's colour, from and back to what the
 * entry already shows — its `::after` belongs to the palette's landing mark
 * (`.shell-flash`), and its `::before` to the selected bar.
 */
export function lightNav(entry: Element | null) {
  if (!(entry instanceof HTMLElement) || motionOff()) return;
  const now = getComputedStyle(entry);
  const glow = tokenRgb("--glow");
  const rest = { backgroundColor: now.backgroundColor, boxShadow: now.boxShadow === "none" ? `inset 0 0 0 1px rgba(${glow},0)` : now.boxShadow };
  entry.animate(
    [rest, { backgroundColor: `rgba(${glow},.2)`, boxShadow: `inset 0 0 0 1px rgba(${glow},.42)`, offset: 0.18 }, rest],
    { duration: 1100, easing: "ease-out" },
  );
}

// ── Canvas light (spec 00 §6.7) ─────────────────────────────────────────────
//
// One full-window canvas, created on first use, that only runs
// requestAnimationFrame while something is being drawn. Dark mixes additively
// (light on light gets brighter, white cores); light uses normal mixing with
// small solid points, because a big additive glow on white either vanishes or
// smears over the text.

interface Palette {
  op: GlobalCompositeOperation;
  partA: string;
  partB: string;
  spr: number;
  stops: (rgb: string) => [number, string][];
  ring: [string, number][];
  flash: [string, number][];
}

function palette(): Palette {
  const agent = tokenRgb("--agent");
  const pass = tokenRgb("--green");
  if (lightTheme()) {
    return {
      op: "source-over",
      partA: pass,
      partB: agent,
      spr: 3.5,
      stops: (rgb) => [
        [0, `rgba(${rgb},1)`],
        [0.2, `rgba(${rgb},.85)`],
        [0.42, `rgba(${rgb},.16)`],
        [1, `rgba(${rgb},0)`],
      ],
      ring: [
        [agent, 0.22],
        [tokenRgb("--agent-2"), 0.9],
        [agent, 0.35],
      ],
      flash: [
        [agent, 0.35],
        [agent, 0.14],
      ],
    };
  }
  return {
    op: "lighter",
    partA: pass,
    partB: "255,255,255",
    spr: 6,
    stops: (rgb) => [
      [0, "rgba(255,255,255,.95)"],
      [0.3, `rgba(${rgb},.55)`],
      [1, `rgba(${rgb},0)`],
    ],
    ring: [
      [agent, 0.45],
      ["255,255,255", 1],
      [agent, 0.5],
    ],
    flash: [
      ["255,255,255", 1],
      [agent, 0.5],
    ],
  };
}

interface Item {
  t0: number;
  dur: number;
  delay?: number;
  draw: (g: CanvasRenderingContext2D, k: number) => void;
}

const ease = (k: number) => 1 - Math.pow(1 - k, 3);

function quad(a: Point, c: Point, b: Point, t: number): Point {
  const u = 1 - t;
  return { x: u * u * a.x + 2 * u * t * c.x + t * t * b.x, y: u * u * a.y + 2 * u * t * c.y + t * t * b.y };
}

function control(a: Point, b: Point, bend: number): Point {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return { x: mx - (b.y - a.y) * bend, y: my + (b.x - a.x) * bend };
}

class FxLayer {
  private canvas: HTMLCanvasElement | null = null;
  private g: CanvasRenderingContext2D | null = null;
  private items: Item[] = [];
  private raf = 0;
  private dpr = 1;
  private pal: Palette | null = null;
  // Each head is pre-rendered once per colour and theme; rebuilding a radial
  // gradient per point per frame halved the frame rate on a 165 Hz screen in
  // the prototype.
  private sprites = new Map<string, HTMLCanvasElement>();

  private ensure(): CanvasRenderingContext2D | null {
    if (this.g !== null && this.canvas?.isConnected) return this.g;
    const cv = document.createElement("canvas");
    cv.className = "fx-layer";
    cv.setAttribute("aria-hidden", "true");
    document.body.appendChild(cv);
    this.canvas = cv;
    this.g = cv.getContext("2d");
    return this.g;
  }

  private size() {
    const cv = this.canvas;
    if (cv === null) return;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = Math.round(window.innerWidth * this.dpr);
    const h = Math.round(window.innerHeight * this.dpr);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
  }

  // One clock (G081): items are stamped with performance.now(), so frames are
  // read with it too. rAF's own timestamp follows the document timeline,
  // which can fall behind real time (a slowed-down timeline does not catch up
  // when it is restored) — and a delayed beam would then never start.
  private loop = () => {
    const now = performance.now();
    this.raf = 0;
    const g = this.g;
    const pal = this.pal;
    if (g === null || pal === null) return;
    this.size();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, window.innerWidth, window.innerHeight);
    g.globalCompositeOperation = pal.op;
    this.items = this.items.filter((it) => {
      const k = (now - it.t0) / it.dur;
      if (k < 0) return true;
      if (k >= 1) return false;
      it.draw(g, k);
      return true;
    });
    if (this.items.length > 0) this.raf = requestAnimationFrame(this.loop);
    else {
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
      this.pal = null;
    }
  };

  private add(it: Omit<Item, "t0">) {
    if (this.ensure() === null) return;
    // The palette is read once per burst, not per frame: tokenRgb() forces a
    // style resolution, and the theme cannot change mid-flight.
    if (this.pal === null) this.pal = palette();
    this.items.push({ ...it, t0: performance.now() + (it.delay ?? 0) });
    if (this.raf === 0) this.raf = requestAnimationFrame(this.loop);
  }

  private sprite(rgb: string): HTMLCanvasElement {
    const key = `${lightTheme() ? "l" : "d"}${rgb}`;
    const hit = this.sprites.get(key);
    if (hit) return hit;
    const s = document.createElement("canvas");
    s.width = s.height = 64;
    const x = s.getContext("2d");
    if (x !== null && this.pal !== null) {
      const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      for (const [o, c] of this.pal.stops(rgb)) gr.addColorStop(o, c);
      x.fillStyle = gr;
      x.fillRect(0, 0, 64, 64);
    }
    this.sprites.set(key, s);
    return s;
  }

  /** A comet along a quadratic curve: a pre-rendered head and an N-segment tail. */
  private comet(
    g: CanvasRenderingContext2D,
    a: Point,
    c: Point,
    b: Point,
    head: number,
    trail: number,
    width: number,
    rgb: string,
    segs = 12,
  ) {
    const t0 = Math.max(0, head - trail);
    let prev = quad(a, c, b, t0);
    g.lineCap = "round";
    for (let i = 1; i <= segs; i++) {
      const t = t0 + ((head - t0) * i) / segs;
      const p = quad(a, c, b, t);
      const f = i / segs;
      g.strokeStyle = `rgba(${rgb},${(f * f * 0.9).toFixed(3)})`;
      g.lineWidth = width * (0.3 + 0.7 * f);
      g.beginPath();
      g.moveTo(prev.x, prev.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      prev = p;
    }
    const h = quad(a, c, b, head);
    const r = width * (this.pal?.spr ?? 6);
    g.drawImage(this.sprite(rgb), h.x - r, h.y - r, r * 2, r * 2);
  }

  /** One comet of light from `a` to `b`. Violet (the agent) unless `rgb` says otherwise. */
  beam(
    a: Point | null,
    b: Point | null,
    o: { bend?: number; trail?: number; width?: number; dur?: number; delay?: number; rgb?: string } = {},
  ) {
    if (motionOff() || a === null || b === null) return;
    const c = control(a, b, o.bend ?? 0);
    const trail = o.trail ?? 0.35;
    const w = o.width ?? 2.5;
    const rgb = o.rgb ?? tokenRgb("--agent");
    this.add({
      dur: o.dur ?? 600,
      delay: o.delay,
      draw: (g, k) => {
        const hd = ease(k);
        this.comet(g, a, c, b, Math.min(1, hd * 1.08), trail * (1 - Math.max(0, hd - 0.8) * 3), w, rgb);
      },
    });
  }

  /** A spray of small comets from `a` to `b`, each with its own bend and delay. */
  particles(
    a: Point | null,
    b: Point | null,
    o: { n?: number; dur?: number; spread?: number; width?: number; segs?: number; rgb?: string } = {},
  ) {
    if (motionOff() || a === null || b === null) return;
    const n = o.n ?? 24;
    const dur = o.dur ?? 900;
    for (let i = 0; i < n; i++) {
      const c = control(a, b, (Math.random() - 0.5) * 0.9 * (o.spread ?? 1));
      const w = (1 + Math.random() * 1.6) * (o.width ?? 1);
      this.add({
        dur: dur * (0.75 + Math.random() * 0.4),
        delay: Math.random() * 340,
        draw: (g, k) => {
          const pal = this.pal;
          if (pal === null) return;
          this.comet(g, a, c, b, ease(k), 0.18, w, o.rgb ?? (i % 3 ? pal.partA : pal.partB), o.segs ?? 12);
        },
      });
    }
  }

  /** Three rings expanding from `c` to the window's diagonal. */
  ring(c: Point | null, o: { dur?: number } = {}) {
    if (motionOff() || c === null) return;
    const max = Math.hypot(window.innerWidth, window.innerHeight);
    this.add({
      dur: o.dur ?? 1400,
      draw: (g, k) => {
        const pal = this.pal;
        if (pal === null) return;
        const r = ease(k) * max;
        const a = (1 - k) * 0.75;
        const [o1, o2, o3] = pal.ring;
        g.lineWidth = 2 + 26 * (1 - k);
        g.strokeStyle = `rgba(${o1[0]},${(a * o1[1]).toFixed(3)})`;
        g.beginPath();
        g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.stroke();
        g.lineWidth = 1.5;
        g.strokeStyle = `rgba(${o2[0]},${(a * o2[1]).toFixed(3)})`;
        g.beginPath();
        g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.stroke();
        if (k > 0.08) {
          g.lineWidth = 1;
          g.strokeStyle = `rgba(${o3[0]},${(a * o3[1]).toFixed(3)})`;
          g.beginPath();
          g.arc(c.x, c.y, ease(k - 0.08) * max * 0.82, 0, Math.PI * 2);
          g.stroke();
        }
      },
    });
  }

  /** A radial burst of light at `c`. */
  flash(c: Point | null, o: { r?: number; dur?: number; alpha?: number } = {}) {
    if (motionOff() || c === null) return;
    const r0 = o.r ?? 200;
    this.add({
      dur: o.dur ?? 600,
      draw: (g, k) => {
        const pal = this.pal;
        if (pal === null) return;
        const r = r0 * (0.4 + 0.8 * ease(k));
        const a = Math.pow(1 - k, 2) * 0.8 * (o.alpha ?? 1);
        const [f1, f2] = pal.flash;
        const gr = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, r);
        gr.addColorStop(0, `rgba(${f1[0]},${(a * f1[1]).toFixed(3)})`);
        gr.addColorStop(0.35, `rgba(${f2[0]},${(a * f2[1]).toFixed(3)})`);
        gr.addColorStop(1, `rgba(${f2[0]},0)`);
        g.fillStyle = gr;
        g.beginPath();
        g.arc(c.x, c.y, r, 0, Math.PI * 2);
        g.fill();
      },
    });
  }

  /** Drops everything in flight (e.g. a page change mid-effect). */
  clear() {
    this.items = [];
  }
}

/** The app's one canvas of light. */
export const fx = new FxLayer();
