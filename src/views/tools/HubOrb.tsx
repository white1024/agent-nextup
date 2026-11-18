import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from "react";

import { motionOff, type Point } from "../../lib/fx";
import { EASE_OUT } from "../../lib/listMotion";

export type McpState = "ready" | "repair" | "missing";

/** What the tools page drives on the orb (C172, C173, C178). */
export interface OrbHandle {
  /** Viewport centre of a tool's segment, or null if it is not drawn. */
  segPoint: (tool: string) => Point | null;
  /** C172: these segments light (or go out) one after another, in ring order. */
  play: (tools: string[], on: boolean, o?: { delay?: number; stagger?: number }) => void;
  /** C173: the marked segment blinks twice and stays outlined. */
  flashMark: () => void;
  /** C178: the broken edge closes and a light walks the cube once. Returns
   *  how long until "ready" should be shown (ms). */
  mend: () => number;
}

// The cube: the boot logo's angle, flat lines (no 3D).
const V = {
  top: [120, 84],
  ur: [152, 102],
  lr: [152, 138],
  bot: [120, 156],
  ll: [88, 138],
  ul: [88, 102],
  c: [120, 120],
} as const;
type Vk = keyof typeof V;
const EDGES: [Vk, Vk][] = [
  ["top", "ur"],
  ["ur", "lr"],
  ["lr", "bot"],
  ["bot", "ll"],
  ["ll", "ul"],
  ["ul", "top"],
  ["c", "ur"],
  ["c", "bot"],
  ["c", "ul"],
];
/** The edge that breaks while .mcp.json needs repair (lower right). */
const BROKEN = 2;
const LOOP: Vk[] = ["top", "ur", "lr", "bot", "ll", "ul", "top"];

const at = (r: number, a: number): [number, number] => {
  const t = (a * Math.PI) / 180;
  return [120 + r * Math.cos(t), 120 + r * Math.sin(t)];
};
const f = (p: readonly [number, number] | [number, number]) => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;

function sector(a0: number, a1: number, r0: number, r1: number): string {
  const lg = a1 - a0 > 180 ? 1 : 0;
  return `M${f(at(r1, a0))} A${r1} ${r1} 0 ${lg} 1 ${f(at(r1, a1))} L${f(at(r0, a1))} A${r0} ${r0} 0 ${lg} 0 ${f(at(r0, a0))} Z`;
}

interface Arc {
  tool: string;
  a0: number;
  a1: number;
}

/** One segment per write tool, group by group from twelve o'clock, clockwise:
 *  7° between groups, 1.6° between the tools of one group. */
export function ringArcs(groups: readonly { tools: readonly string[] }[]): Arc[] {
  const live = groups.filter((g) => g.tools.length > 0);
  const n = live.reduce((s, g) => s + g.tools.length, 0);
  if (n === 0) return [];
  const G = live.length;
  const gg = 7;
  const tg = 1.6;
  const per = (360 - G * gg - (n - G) * tg) / n;
  let a = -90 + gg / 2;
  const out: Arc[] = [];
  for (const g of live) {
    g.tools.forEach((tool, i) => {
      out.push({ tool, a0: a, a1: a + per });
      a += per + (i < g.tools.length - 1 ? tg : 0);
    });
    a += gg;
  }
  return out;
}

/**
 * The hub (C171, spec 60 "tools"): a wire cube for nextup-mcp, an outer ring
 * with a segment per write tool (violet once granted, hollow until then) and
 * an inner ring with one per read tool (always cyan — always allowed). The
 * cube carries the connection's state: a point of light walks its edges when
 * ready, one edge breaks in amber when .mcp.json needs repair, and only a
 * dashed outline is left when the binary is missing.
 *
 * Colour only, on purpose (9(a)): the switches on the left are the readable
 * controls; here every segment has its tool name as a title and the drawing
 * as a whole is named by the same count the page prints under it.
 */
const HubOrb = forwardRef<
  OrbHandle,
  {
    groups: readonly { id: string; tools: readonly string[] }[];
    allowed: ReadonlySet<string>;
    reads: readonly string[];
    enabled: boolean;
    mcp: McpState;
    marked: string | null;
    label: string;
  }
>(function HubOrb({ groups, allowed, reads, enabled, mcp, marked, label }, ref) {
  const svgRef = useRef<SVGSVGElement>(null);
  const arcs = ringArcs(groups);
  const order = useRef<string[]>([]);
  order.current = arcs.map((x) => x.tool);
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const seg = (tool: string) =>
    svgRef.current?.querySelector<SVGGElement>(`[data-seg="${CSS.escape(tool)}"]`) ?? null;

  useImperativeHandle(ref, () => ({
    segPoint(tool) {
      const svg = svgRef.current;
      const x = ringArcs(groups).find((a) => a.tool === tool);
      if (!svg || x === undefined) return null;
      const r = svg.getBoundingClientRect();
      const p = at(89, (x.a0 + x.a1) / 2);
      return { x: r.left + (p[0] / 240) * r.width, y: r.top + (p[1] / 240) * r.height };
    },
    play(tools, on, o = {}) {
      if (motionOff()) return;
      const ring = order.current;
      const list = tools.filter((tool) => ring.includes(tool)).sort((a, b) => ring.indexOf(a) - ring.indexOf(b));
      const step = o.stagger ?? (list.length > 1 ? 70 : 0);
      // While the master switch is off a granted segment is drawn dim, not
      // violet — so it is the dim layer that lights.
      const live = enabledRef.current;
      list.forEach((tool, k) => {
        const lit = seg(tool)?.querySelector(live ? ".f" : ".d");
        if (lit == null) return;
        const top = live ? 1 : 0.4;
        if (on) {
          lit.animate([{ opacity: 0 }, { opacity: top, offset: 0.4 }, { opacity: top }], {
            duration: 420,
            delay: (o.delay ?? 0) + k * step,
            easing: "ease-out",
            fill: "backwards",
          });
        } else {
          lit.animate(
            [
              { opacity: top, transform: "scale(1)" },
              { opacity: 0, transform: "scale(1.08)" },
            ],
            { duration: 340, delay: k * Math.min(step, 50), easing: "ease-in", fill: "backwards" },
          );
        }
      });
    },
    flashMark() {
      const g = svgRef.current?.querySelector(".tls-seg.is-mark");
      if (g == null || motionOff()) return;
      g.classList.remove("flash");
      void g.getBoundingClientRect();
      g.classList.add("flash");
      window.setTimeout(() => g.classList.remove("flash"), 1400);
    },
    mend() {
      const svg = svgRef.current;
      if (svg === null || motionOff()) return 0;
      const [ea, eb] = EDGES[BROKEN];
      const dx = (V[eb][0] - V[ea][0]) * 0.14;
      const dy = (V[eb][1] - V[ea][1]) * 0.14;
      const a = svg.querySelector('[data-brk="a"]');
      const b = svg.querySelector('[data-brk="b"]');
      const edge = svg.querySelector(`[data-edge="${BROKEN}"]`);
      const close = { duration: 360, easing: EASE_OUT, fill: "forwards" as const };
      a?.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px)` }], close);
      b?.animate([{ transform: "none" }, { transform: `translate(${-dx}px, ${-dy}px)` }], close);
      window.setTimeout(() => {
        for (const half of [a, b]) half?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: "forwards" });
        edge?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, fill: "forwards" });
        // One lap of light around the outer edges (the walking point only
        // appears once "ready" is drawn, so there are never two).
        const NS = "http://www.w3.org/2000/svg";
        const g = document.createElementNS(NS, "g");
        g.setAttribute("class", "tls-loop");
        for (const [cls, r] of [
          ["h", "7"],
          ["d", "2.8"],
        ]) {
          const c = document.createElementNS(NS, "circle");
          c.setAttribute("class", cls);
          c.setAttribute("r", r);
          g.appendChild(c);
        }
        svg.appendChild(g);
        const lap = g.animate(
          LOOP.map((k, i) => ({
            offset: i / 6,
            transform: `translate(${V[k][0]}px, ${V[k][1]}px)`,
            opacity: i === 6 ? 0 : 1,
          })),
          { duration: 1000, easing: "linear", fill: "both" },
        );
        void lap.finished.then(
          () => g.remove(),
          () => g.remove(),
        );
      }, 340);
      return 1500;
    },
  }));

  // C174: the master switch. Granted segments go dim (or come back) one after
  // another rather than all at once, so you can see which ones were granted.
  const wasEnabled = useRef(enabled);
  useLayoutEffect(() => {
    if (wasEnabled.current === enabled) return;
    wasEnabled.current = enabled;
    const svg = svgRef.current;
    if (svg === null || motionOff()) return;
    const lit = order.current.filter((tool) => allowedRef.current.has(tool));
    lit.forEach((tool, k) => {
      for (const p of seg(tool)?.querySelectorAll<SVGElement>(".f, .d") ?? []) p.style.transitionDelay = `${k * 45}ms`;
    });
    const id = window.setTimeout(() => {
      for (const p of svg.querySelectorAll<SVGElement>(".tls-seg .f, .tls-seg .d")) p.style.transitionDelay = "";
    }, lit.length * 45 + 500);
    return () => window.clearTimeout(id);
  }, [enabled]);

  const rg = 4;
  const rper = reads.length === 0 ? 0 : (360 - reads.length * rg) / reads.length;
  const [p, q] = [V[EDGES[BROKEN][0]], V[EDGES[BROKEN][1]]];
  const lerp = (t: number): [number, number] => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

  return (
    <div className="tls-orb">
      <i className="tls-halo" aria-hidden="true" />
      <svg
        ref={svgRef}
        className={`tls-ring is-${mcp}${enabled ? "" : " is-off"}`}
        viewBox="0 0 240 240"
        role="img"
        aria-label={label}
      >
        {arcs.map((x) => {
          const d = sector(x.a0, x.a1, 82, 96);
          return (
            <g
              key={x.tool}
              className={`tls-seg${allowed.has(x.tool) ? " is-on" : ""}${marked === x.tool ? " is-mark" : ""}`}
              data-seg={x.tool}
            >
              <path className="o" d={d} />
              <path className="d" d={d} />
              <path className="f" d={d} />
              <path className="y" d={d} />
              <title>{x.tool}</title>
            </g>
          );
        })}
        <g className="tls-rds">
          {reads.map((tool, k) => {
            const a0 = -90 + rg / 2 + k * (rper + rg);
            return (
              <path key={tool} className="tls-rd" d={`M${f(at(64, a0))} A64 64 0 0 1 ${f(at(64, a0 + rper))}`}>
                <title>{tool}</title>
              </path>
            );
          })}
        </g>
        <g className="tls-cube">
          {EDGES.map(([a, b], k) => (
            <line
              key={k}
              className={`tls-e${k === BROKEN && mcp === "repair" ? " gone" : ""}`}
              data-edge={k}
              x1={V[a][0]}
              y1={V[a][1]}
              x2={V[b][0]}
              y2={V[b][1]}
            />
          ))}
          {mcp === "repair" && (
            <>
              <line className="tls-brk" data-brk="a" x1={p[0]} y1={p[1]} x2={lerp(0.36)[0]} y2={lerp(0.36)[1]} />
              <line className="tls-brk" data-brk="b" x1={lerp(0.64)[0]} y1={lerp(0.64)[1]} x2={q[0]} y2={q[1]} />
            </>
          )}
        </g>
        <g className="tls-walk" aria-hidden="true">
          <circle className="h" r="6" />
          <circle className="d" r="2.4" />
        </g>
      </svg>
    </div>
  );
});

export default HubOrb;
