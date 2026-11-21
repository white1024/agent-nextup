import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  BaseEdge,
  ControlButton,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useConnection,
  useEdgesState,
  useNodesState,
  ViewportPortal,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type OnNodeDrag,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { TFunction } from "i18next";

import { BOLT_PATH, IconFit, IconX } from "../../components/icons";
import {
  NODE_H,
  NODE_W,
  canConnect,
  drawnTeam,
  edgeGeo,
  edgeGeos,
  edgeKey,
  fitViewport,
  layersOf,
  linesOf,
  markPoints,
  reversedPath,
  viewportLeftOf,
  type Pos,
  type Positions,
  type Rect,
} from "./layout";
import { lookOf } from "./looks";
import {
  ARROW_PATH,
  bezPath,
  nearCore,
  orbitDraws,
  orbitPlan,
  planetOf,
  reverseBez,
  sideOf,
  type OrbitDraw,
  type OrbitGeo,
  type OrbitPlan,
} from "./orbit";
import OrbitCore from "./OrbitCore";
import type { LayoutSkin, Team } from "../../types";
import PathLabel from "../../components/PathLabel";
import { canvasHintEnabled, dismissCanvasHint } from "../../lib/prefs";
import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import {
  OPEN_FLY_MS,
  bloom,
  comet,
  drawArc,
  drawFlow,
  flareCore,
  flyStars,
  orbitFlight,
  peekStars,
  replay,
  starCentres,
  takeStars,
  type StarState,
} from "./motion";

type MemberNodeData = {
  label: string;
  root: string;
  state: StarState;
  /** Null until the cross-workspace outbox read lands (invariant 10). */
  pending: number | null;
  /** Preformatted arrival time of this member's latest delivery, if any. */
  lastDelivery: string | null;
  /** Has a flow going out — its tail reaches the sending point. */
  out: boolean;
  outAuto: boolean;
  /** Delay (ms) before this member's "delivered" ring shows, or null for none. */
  got: number | null;
  /** A send-result row is hovered: this is its member. */
  hl: boolean;
  born: boolean;
  /** The orbit this node sits on (D157), or null on the star map. Its words face away from the cube. */
  orbit: OrbitGeo | null;
};
type MemberNode = Node<MemberNodeData, "member">;
/** `span` = how many layers the edge crosses; ≥2 means it bypasses a node, <0 that it runs back upstream (D161). */
type FlowEdgeData = {
  onRemove: () => void;
  span: number;
  autoRoute: boolean;
  /** The way back on a two-way line (D176), null on a one-way line. */
  back: { autoRoute: boolean } | null;
  mark: (Pos & { a: number }) | null;
  /** The orbit's arc for this flow (D157), or null on the star map. */
  draw: OrbitDraw | null;
};
type FlowEdge = Edge<FlowEdgeData, "flow">;

/** What the detail page drives on the canvas (C56 going back, C58 sending). */
export interface CanvasApi {
  /** Screen centres of every member's star. */
  stars(): Record<string, Point>;
  starOf(id: string): Point | null;
  /** Pan (and only ever shrink) so these members show beside the inspector. */
  frame(ids: string[], dur?: number): void;
  /**
   * Light running along one flow; null when this team has no such flow. On
   * the orbit, `core` is when (as a share of `dur`) the light passes the
   * cube, so the page can flare it once, at the first such moment (C64).
   */
  comet(from: string, to: string, delay: number, dur: number): { core: number | null } | null;
  /** A bloom on a member's star, and its node's ring. */
  bloom(id: string): void;
  /** The orbit's cube lights up as a light passes through it (C64); nothing on the star map. */
  flare(): void;
  /** The canvas's zoom — the orbit's cube flies home from that size (C62). */
  zoom(): number;
}

interface Props {
  team: Team;
  /** Star map or orbit (D157): which positions, which drawing, which motion. */
  skin: LayoutSkin;
  missing: Set<string>;
  /** Pending outbox envelope count per member workspaceId; null until read. */
  pending: Map<string, number> | null;
  /** Latest arrival time per member workspaceId, preformatted for display. */
  lastDelivery: Map<string, string>;
  busy: boolean;
  /** Edge-op failure shown on the canvas (errors live in place, 11 §4). */
  flowError: string | null;
  onClearFlowError: () => void;
  selectedId: string | null;
  /**
   * Bump `nonce` to pan the viewport onto `id` (the member rail asks for this;
   * clicking a node does not — it is already on screen and recentring jars).
   */
  focus: { id: string; nonce: number } | null;
  onSelect: (workspaceId: string | null) => void;
  onAddEdge: (from: string, to: string) => void;
  onRemoveEdge: (from: string, to: string) => void;
  /** Remove a two-way line, both directions (D176). */
  onRemoveLine: (a: string, b: string) => void;
  /** Full position map after a drag ends or a tidy settles (D53 §4 — the only write moments). */
  onPersistLayout: (positions: Positions) => void;
  /** Bumped by "Tidy up": nodes slide to their auto slots (C54), then persist. */
  tidy: number;
  /** A flow just created (C59): it draws itself once, then the owner clears it. */
  freshEdge: string | null;
  onFreshEdgeDone: () => void;
  /** Members just added (C59): their stars are born. */
  born: Set<string>;
  /** Send result on screen: member → delay before its ring shows. */
  got: Map<string, number> | null;
  /** Member whose result row is hovered. */
  highlight: string | null;
  apiRef: MutableRefObject<CanvasApi | null>;
}

/**
 * Team flow canvas (D53, 12 §2–§3; drawn as the D153 star map, spec 50 §4).
 *
 * xyflow still runs the canvas — dragging, connecting, zooming, keyboard and
 * the minimap — and this file swaps what it draws: members are stars on the
 * node's left edge with a tail of light out to the sending point, flows carry
 * a direction mark mid-curve instead of an arrowhead, automatic flows have two
 * lights running on them, and the sky behind does not pan. Positions come from
 * teams.json `layout` (auto-placed when absent) and persist only on drag end /
 * tidy, never on open.
 *
 * The orbit style (D157, spec 50 §15) is the same canvas drawn round a wire
 * cube: members are planets on one orbit with their words outside it, flows
 * are arcs bending towards the cube with an arrowhead, and its positions are
 * `orbitLayout`. What differs is gathered in `looks.ts`; the drawing is CSS
 * under `:root[data-tv="orbit"]` plus OrbitCore and the edge branch below.
 */
export default function Canvas({
  team,
  skin,
  missing,
  pending,
  lastDelivery,
  busy,
  flowError,
  onClearFlowError,
  selectedId,
  focus,
  onSelect,
  onAddEdge,
  onRemoveEdge,
  onRemoveLine,
  onPersistLayout,
  tidy,
  freshEdge,
  onFreshEdgeDone,
  born,
  got,
  highlight,
  apiRef,
}: Props) {
  const { t } = useTranslation();
  const look = lookOf(skin);
  const orbit = skin === "orbit";
  /** The orbit's plan (one object per team shape — orbitPlan remembers it), or null on the star map. */
  const plan: OrbitPlan | null = orbit ? orbitPlan(team) : null;
  // Only worth saying when there is something to connect: a one-node (or empty)
  // team has no second endpoint, and the empty state already guides.
  const [showHint, setShowHint] = useState(
    () => canvasHintEnabled() && team.members.length > 1,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<MemberNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const boxRef = useRef<HTMLDivElement>(null);
  /** C56: nodes, lines and controls stay hidden while stars fly in, then appear. */
  const [phase, setPhase] = useState<"arriving" | "landed" | null>(() =>
    peekStars(team.id, "open") ? "arriving" : null,
  );
  /** While a connection is being dragged: every node becomes a drop target. */
  const [connecting, setConnecting] = useState(false);
  /** C54 in flight — positions belong to the animation, not to the team. */
  const tidying = useRef(false);

  // Derive nodes from the team. Position precedence: saved layout → current
  // on-canvas position (mid-session, not yet saved) → deterministic auto slot.
  // On the orbit a new shape (a member in or out, a flow added) is a new
  // orbit, so unsaved planets move to their new slots rather than staying
  // where the old orbit put them (spec 50 §19).
  const planRef = useRef<OrbitPlan | null>(null);
  useEffect(() => {
    const reshaped = plan !== planRef.current;
    planRef.current = plan;
    const saved = look.saved(team);
    setNodes((prev) => {
      const before = new Map(prev.map((node) => [node.id, node.position]));
      // xyflow's measured size has to travel with the node. A node object
      // without it counts as unmeasured: every edge touching it is unmounted
      // until it is measured again a frame or two later, and comes back as a
      // new element — so any animation on a line (C59 / C65 drawing a new
      // flow) died with the old one, and every pending count, hover or
      // selection that re-derived the nodes rebuilt every line.
      const measured = new Map(prev.map((node) => [node.id, node.measured]));
      const auto = look.auto(team);
      const outs = new Set(team.edges.map((e) => e.from));
      const autos = new Set(team.edges.filter((e) => e.autoRoute).map((e) => e.from));
      return team.members.map((member) => {
        const id = member.workspaceId;
        const count = pending === null ? null : (pending.get(id) ?? 0);
        const state: StarState = missing.has(id) ? "missing" : count !== null && count > 0 ? "pending" : "ok";
        return {
          id,
          type: "member" as const,
          position: tidying.current
            ? (before.get(id) ?? auto[id])
            : (saved?.[id] ?? (orbit && reshaped ? undefined : before.get(id)) ?? auto[id]),
          deletable: false,
          measured: measured.get(id),
          selected: id === selectedId,
          data: {
            label: member.name,
            root: member.root,
            state,
            pending: count,
            lastDelivery: lastDelivery.get(id) ?? null,
            out: outs.has(id),
            outAuto: autos.has(id),
            got: got?.get(id) ?? null,
            hl: highlight === id,
            born: born.has(id),
            orbit: plan,
          },
        };
      });
    });
    // `look` and `plan` follow `skin` and `team`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team, skin, missing, pending, lastDelivery, selectedId, got, highlight, born, setNodes]);

  // D176: two members that send to each other are one line, drawn along its
  // forward direction and marked as running both ways.
  useEffect(() => {
    const layer = layersOf(team);
    setEdges((prev) => {
      const sel = new Set(prev.filter((e) => e.selected === true).map((e) => e.id));
      return linesOf(team.edges).map(({ ab: edge, ba }) => {
        const from = layer.get(edge.from);
        const to = layer.get(edge.to);
        const id = edgeKey(edge);
        return {
          id,
          source: edge.from,
          target: edge.to,
          type: "flow" as const,
          selected: sel.has(id),
          data: {
            onRemove: ba === null ? () => onRemoveEdge(edge.from, edge.to) : () => onRemoveLine(edge.from, edge.to),
            span: from !== undefined && to !== undefined ? to - from : 1,
            autoRoute: edge.autoRoute,
            back: ba === null ? null : { autoRoute: ba.autoRoute },
            mark: null,
            draw: null,
          },
        };
      });
    });
  }, [team, setEdges, onRemoveEdge, onRemoveLine]);

  /** One edge per line — what the marks, arcs and lights are worked out on. */
  const drawn = useMemo(() => drawnTeam(team), [team]);

  /** Where every node is right now — dragging included. */
  const positions = useMemo(() => {
    const out: Positions = {};
    for (const n of nodes) out[n.id] = n.position;
    return out;
  }, [nodes]);

  // Direction marks avoid stars and each other, so they are placed for the
  // whole team at once and handed to each edge.
  // On the orbit the whole arc is worked out here too: it starts and ends at
  // planets, not at xyflow's handles, and its bolt avoids the cube as well.
  const draws = useMemo(() => (plan === null ? null : orbitDraws(drawn, plan, positions)), [plan, drawn, positions]);
  // The latest arcs and orbit, for work that runs a frame or more later than
  // the render that scheduled it: a new flow's draw (C65) is scheduled as the
  // flow is created, before the team that contains it has rendered.
  const latest = useRef({ plan, draws });
  latest.current = { plan, draws };
  const shown = useMemo(() => {
    if (draws !== null) {
      return edges.map((e) => {
        const d = draws[e.id];
        return e.data === undefined || d === undefined ? e : { ...e, data: { ...e.data, draw: d, mark: { ...d.mark, a: 0 } } };
      });
    }
    const marks = markPoints(drawn, positions);
    return edges.map((e) => (e.data === undefined ? e : { ...e, data: { ...e.data, mark: marks[e.id] ?? null } }));
  }, [edges, positions, drawn, draws]);

  const isValidConnection = useCallback(
    (conn: Connection | FlowEdge) => canConnect(conn.source ?? "", conn.target ?? "", team.edges),
    [team],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (conn.source && conn.target) onAddEdge(conn.source, conn.target);
    },
    [onAddEdge],
  );

  // Mirror of `nodes` for the drag-stop handler. This used to read the live
  // state by calling `setNodes` with an updater that fired `onPersistLayout`
  // from inside it — a side effect in a state updater, which StrictMode
  // double-invokes: every drag issued two concurrent layout writes (one of
  // which failed with "os error 2"), and the parent setState it triggered ran
  // during the render phase, dropping node/edge state until a remount. Read
  // the ref instead and keep the updater pure.
  const nodesRef = useRef<MemberNode[]>(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // Held as a ref rather than via useReactFlow, which would need this
  // component to sit inside a provider it itself renders.
  const flowRef = useRef<ReactFlowInstance<MemberNode, FlowEdge> | null>(null);
  const [ready, setReady] = useState(false);
  /** Hidden until the first fit lands, so the default viewport never shows for a frame. */
  const [fitted, setFitted] = useState(false);

  const boxSize = useCallback(() => {
    const box = boxRef.current;
    return { w: box?.clientWidth ?? 0, h: box?.clientHeight ?? 0 };
  }, []);

  /**
   * Width the inspector covers on the canvas's right, or 0 when it is not
   * there — below 1040 it lies along the bottom edge instead (styles.css).
   */
  const coveredRight = useCallback((): number => {
    const box = boxRef.current;
    const ins = box?.parentElement?.querySelector<HTMLElement>(".canvas-inspector");
    if (box == null || ins == null) return 0;
    const b = box.getBoundingClientRect();
    const r = ins.getBoundingClientRect();
    return r.left > b.left + b.width * 0.3 ? r.width : 0;
  }, []);

  /** The zoom buttons and the minimap, in canvas-local coordinates. */
  const obstacles = useCallback((): Rect[] => {
    const box = boxRef.current;
    if (box === null) return [];
    const b = box.getBoundingClientRect();
    return [".react-flow__controls", ".react-flow__minimap"]
      .map((sel) => box.querySelector(sel)?.getBoundingClientRect())
      .filter((r): r is DOMRect => r !== undefined)
      .map((r) => ({ l: r.left - b.left, t: r.top - b.top, r: r.right - b.left, b: r.bottom - b.top }));
  }, []);

  const fit = useCallback(
    (duration: number) => {
      const flow = flowRef.current;
      if (flow === null) return;
      const ids = team.members.map((m) => m.workspaceId);
      const v = fitViewport(positions, ids, look.fitExtra(team, positions), boxSize(), obstacles(), look.reachLeft);
      void flow.setViewport(v, { duration: motionOff() ? 0 : duration });
    },
    // `look` follows `skin`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [team, skin, positions, boxSize, obstacles],
  );

  // First fit, once per team, after the nodes exist. C56 lands here too: the
  // card's stars were parked on the way out; they fly to where the stars sit
  // once the view is fitted, and the canvas fills in when they land.
  const fittedFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!ready || fittedFor.current === team.id) return;
    if (nodes.length !== team.members.length) return;
    fittedFor.current = team.id;
    fit(0);
    setFitted(true);
    const parked = takeStars(team.id, "open");
    if (parked === null) {
      setPhase(null);
      return;
    }
    // Two frames: the fitted viewport has to have been rendered before the
    // stars it moved are measured.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const to = starCentres(boxRef.current);
      const ids = team.members.map((m) => m.workspaceId);
      const state = (id: string) => nodesRef.current.find((n) => n.id === id)?.data.state ?? "ok";
      // C62: on the orbit the cube flies in with the planets (C56 otherwise).
      const flight = orbit
        ? orbitFlight(ids, flowRef.current?.getZoom() ?? 1, false, state)
        : { ids, state, edges: team.edges };
      void flyStars(flight.ids, parked.from, to, { dur: OPEN_FLY_MS, ...flight }).then(() => {
        setPhase("landed");
        window.setTimeout(() => setPhase((p) => (p === "landed" ? null : p)), 1400);
      });
    }));
  }, [ready, nodes.length, team, fit]);

  // Pan onto the member the rail asked for — into the part of the canvas the
  // inspector leaves open (my-design review F28). The rail's click selects the
  // member too, so the inspector opens in this same commit: measure a frame
  // later, once it has been laid out. And measure what is *drawn*, not the
  // node's slot: the sky's star hangs off the box's left edge, and on the
  // orbit the planet sits to one side of the words, so centring the slot put
  // half a planet under the inspector. When the whole team fits left of the
  // inspector, the effect below moves there instead, in the same frame and
  // after this one — the member is then on screen either way.
  useEffect(() => {
    if (focus === null) return;
    const raf = requestAnimationFrame(() => {
      const flow = flowRef.current;
      const box = boxRef.current;
      const drawn = drawnBox(nodeEl(focus.id));
      if (flow === null || box === null || drawn === null) return;
      const b = box.getBoundingClientRect();
      const dx = b.left + (b.width - coveredRight()) / 2 - (drawn.left + drawn.right) / 2;
      const dy = b.top + b.height / 2 - (drawn.top + drawn.bottom) / 2;
      const v = flow.getViewport();
      void flow.setViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom }, { duration: motionOff() ? 0 : 320 });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  // The inspector opening covers a third of the canvas: if the whole team fits
  // left of it with names still at 12px, move it there (spec 50 §5).
  const wasSelected = useRef<string | null>(null);
  useEffect(() => {
    const opened = selectedId !== null && wasSelected.current === null;
    wasSelected.current = selectedId;
    if (!opened) return;
    requestAnimationFrame(() => {
      const flow = flowRef.current;
      const box = boxRef.current;
      const covered = coveredRight();
      if (flow === null || box === null || covered === 0) return;
      const mini = box.querySelector<HTMLElement>(".react-flow__minimap");
      const miniTop = mini ? mini.getBoundingClientRect().top - box.getBoundingClientRect().top : null;
      const v = viewportLeftOf(
        positions,
        team.members.map((m) => m.workspaceId),
        boxSize(),
        covered,
        miniTop,
        flow.getZoom(),
        orbit
          ? { extra: look.fitExtra(team, positions), halo: 0, min: look.readable }
          : { min: look.readable },
      );
      if (v !== null) void flow.setViewport(v, { duration: motionOff() ? 0 : 240 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  // C54: "Tidy up" — nodes and lines slide together to the auto slots (420ms,
  // ease-out cubic), then the result is saved once.
  const lastTidy = useRef(tidy);
  useEffect(() => {
    if (tidy === lastTidy.current) return;
    lastTidy.current = tidy;
    const to = look.auto(team);
    const from = new Map(nodesRef.current.map((n) => [n.id, n.position]));
    if (motionOff()) {
      setNodes((prev) => prev.map((n) => ({ ...n, position: to[n.id] ?? n.position })));
      onPersistLayout(to);
      return;
    }
    tidying.current = true;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 420);
      const e = 1 - Math.pow(1 - k, 3);
      setNodes((prev) =>
        prev.map((n) => {
          const a = from.get(n.id);
          const b = to[n.id];
          if (a === undefined || b === undefined) return n;
          return { ...n, position: { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e } };
        }),
      );
      if (k < 1) requestAnimationFrame(step);
      else {
        tidying.current = false;
        onPersistLayout(to);
      }
    };
    requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tidy]);

  const viewportEl = useCallback(() => boxRef.current?.querySelector(".react-flow__viewport") ?? null, []);
  const nodeEl = useCallback(
    (id: string) => boxRef.current?.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"] .canvas-node`) ?? null,
    [],
  );

  const bloomAt = useCallback(
    (id: string) => {
      const p = positions[id];
      if (p === undefined) return;
      bloom(viewportEl(), look.anchor(team, p));
      replay(nodeEl(id), "ping", 800);
    },
    // `look` follows `skin`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, viewportEl, nodeEl, team, skin],
  );

  const flare = useCallback(() => flareCore(boxRef.current?.querySelector(".tvo-orb") ?? null), []);

  // C59: a fresh flow draws itself; its target blooms when the line arrives.
  //
  // The line is not on the canvas yet when this runs: the page learns of the
  // new flow with the write's answer, but xyflow's edges are rebuilt in their
  // own effect one render later. Looking once found nothing and skipped the
  // whole draw — the line simply appeared, finished (both styles). So wait,
  // a frame at a time, for the line to exist; give up after half a second.
  useEffect(() => {
    if (freshEdge === null) return;
    let id = 0;
    let tries = 0;
    // A new direction on an existing pair is drawn as part of the line that
    // runs the other way (D176), so look for that too.
    const [freshFrom, freshTo] = freshEdge.split("->");
    const lineKey = (k: string) => boxRef.current?.querySelector(`[data-edge="${CSS.escape(k)}"]`) ?? null;
    const run = () => {
      const g = lineKey(freshEdge) ?? lineKey(`${freshTo}->${freshFrom}`);
      if (g === null && tries++ < 30) {
        id = requestAnimationFrame(run);
        return;
      }
      const path = g?.querySelector<SVGPathElement>(".tm-line") ?? null;
      const to = freshEdge.split("->")[1];
      if (plan !== null) {
        // C65: the arc draws itself, flaring the cube as it passes.
        const marks = g ? Array.from(g.querySelectorAll(".tvo-arrow, .tvo-bolt, .tv-flow, .tv-flow-glow")) : [];
        const now = latest.current;
        const d = now.draws?.[freshEdge] ?? now.draws?.[`${freshTo}->${freshFrom}`];
        drawArc(path, marks, d !== undefined && now.plan !== null ? nearCore(now.plan, d.q) : null, flare, () => bloomAt(to));
      } else {
        const marks = g ? Array.from(g.querySelectorAll(".tsm-chev, .tsm-drop, .tv-flow, .tv-flow-glow")) : [];
        drawFlow(path, viewportEl(), marks, () => bloomAt(to));
      }
      onFreshEdgeDone();
    };
    id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshEdge]);

  // C59: a new member's star flashes as it is born (the growth is CSS).
  const bornKey = [...born].join(" ");
  useEffect(() => {
    if (born.size === 0 || motionOff()) return;
    if (orbit) {
      // C65: show the whole orbit first, then each new planet is launched from
      // the cube onto its place (its words are held back in CSS until it lands).
      fit(0);
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => {
          const core = centreOf(boxRef.current?.querySelector(".tvo-orb"));
          if (core === null) return;
          for (const m of born) {
            const planet = starCentres(nodeEl(m))[m];
            if (planet === undefined) continue;
            const state = nodesRef.current.find((n) => n.id === m)?.data.state ?? "ok";
            void flyStars([m], { [m]: core }, { [m]: planet }, {
              dur: 620,
              state: () => state,
              edges: [],
              bend: 0.2,
              swell: 0.3,
              size: () => [0.3, 1],
            });
          }
        });
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    const id = requestAnimationFrame(() => {
      for (const m of born) {
        const star = nodeEl(m)?.querySelector("[data-star]");
        const r = star?.getBoundingClientRect();
        if (r) fx.flash({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, { r: 70, dur: 620, alpha: 0.6 });
      }
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bornKey]);

  // What the page drives: kept current every render (it reads `positions`).
  apiRef.current = {
    stars: () => starCentres(boxRef.current),
    starOf: (id) => starCentres(nodeEl(id))[id] ?? null,
    frame: (ids, dur = 220) => {
      const flow = flowRef.current;
      const box = boxRef.current;
      if (flow === null || box === null) return;
      const covered = coveredRight();
      const vw = box.clientWidth - (covered > 0 ? covered + 24 : 0);
      const vh = box.clientHeight;
      if (vw < 200) return;
      const { x, y, zoom } = flow.getViewport();
      if (plan !== null) {
        // C64 (the design's tvoFrame): the sender's and receivers' planets and
        // the cube, 40px round. Only ever shrinks, never past the 12px name
        // limit; when even that does not fit, the downstream side is kept in
        // view — that is where the light arrives.
        const pts = [
          ...ids.flatMap((id) => (positions[id] === undefined ? [] : [planetOf(plan, positions[id])])),
          { x: plan.cx, y: plan.cy },
        ];
        const m = 40;
        const ox0 = Math.min(...pts.map((p) => p.x)) - m;
        const ox1 = Math.max(...pts.map((p) => p.x)) + m;
        const oy0 = Math.min(...pts.map((p) => p.y)) - m;
        const oy1 = Math.max(...pts.map((p) => p.y)) + m;
        if (ox0 * zoom + x >= 8 && ox1 * zoom + x <= vw - 8 && oy0 * zoom + y >= 8 && oy1 * zoom + y <= vh - 8) return;
        const z = Math.min(1.75, Math.max(Math.min(zoom, 0.8), Math.min(zoom, (vw - 16) / (ox1 - ox0), (vh - 16) / (oy1 - oy0))));
        const fits = (ox1 - ox0) * z <= vw - 16;
        void flow.setViewport(
          {
            zoom: z,
            x: fits ? (vw - (ox1 - ox0) * z) / 2 - ox0 * z : vw - 8 - ox1 * z,
            y: (vh - (oy1 - oy0) * z) / 2 - oy0 * z,
          },
          { duration: motionOff() ? 0 : dur },
        );
        return;
      }
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const id of ids) {
        const p = positions[id];
        if (p === undefined) continue;
        x0 = Math.min(x0, p.x);
        y0 = Math.min(y0, p.y);
        x1 = Math.max(x1, p.x + NODE_W);
        y1 = Math.max(y1, p.y + NODE_H);
      }
      if (!Number.isFinite(x0)) return;
      const inView = x0 * zoom + x >= 8 && x1 * zoom + x <= vw - 8 && y0 * zoom + y >= 8 && y1 * zoom + y <= vh - 8;
      if (inView) return;
      const z = Math.max(0.3, Math.min(zoom, (vw - 32) / (x1 - x0), (vh - 32) / (y1 - y0)));
      void flow.setViewport(
        { zoom: z, x: (vw - (x1 - x0) * z) / 2 - x0 * z, y: (vh - (y1 - y0) * z) / 2 - y0 * z },
        { duration: motionOff() ? 0 : dur },
      );
    },
    comet: (from, to, delay, dur) => {
      // On a two-way line (D176) the way back is the drawn line run backwards.
      const key = `${from}->${to}`;
      const back = `${to}->${from}`;
      if (plan !== null) {
        const d = draws?.[key];
        if (d !== undefined) {
          comet(viewportEl(), d.d, delay, dur);
          return { core: nearCore(plan, d.q) };
        }
        const r = draws?.[back];
        if (r === undefined) return null;
        const q = reverseBez(r.q);
        comet(viewportEl(), bezPath(q), delay, dur);
        return { core: nearCore(plan, q) };
      }
      const geos = edgeGeos(drawn, positions);
      const g = geos[key];
      if (g !== undefined) {
        comet(viewportEl(), g.d, delay, dur);
        return { core: null };
      }
      const r = geos[back];
      if (r === undefined) return null;
      comet(viewportEl(), reversedPath(r.n), delay, dur);
      return { core: null };
    },
    bloom: bloomAt,
    flare,
    zoom: () => flowRef.current?.getZoom() ?? 1,
  };

  // xyflow's keyboard descriptions for nodes and edges, its aria-live
  // announcements and its Controls button labels are hard-coded English by
  // default (defaultAriaLabelConfig in @xyflow/system); all of them are
  // wired through i18n here.
  //
  // ⚠️ The `keyboardDisabled` key is the opposite of the package's own
  // branch: A11yDescriptions reads exactly `keyboardDisabled` when
  // `disableKeyboardA11y` is false — i.e. when keyboard a11y is *enabled*,
  // which is this project's case. So the "you can move it with the arrow
  // keys" description belongs in this slot. It looks backwards and isn't:
  // set it from the package's behaviour, not from the key's name.
  const ariaLabelConfig = useMemo(
    () => ({
      "node.a11yDescription.default": t("teams.a11yNode"),
      "node.a11yDescription.keyboardDisabled": t("teams.a11yNode"),
      "node.a11yDescription.ariaLiveMessage": ({
        direction,
        x,
        y,
      }: {
        direction: string;
        x: number;
        y: number;
      }) => t("teams.a11yNodeMoved", { direction: dirLabel(direction, t), x, y }),
      "edge.a11yDescription.default": t("teams.a11yEdge"),
      "controls.ariaLabel": t("teams.a11yControls"),
      "controls.zoomIn.ariaLabel": t("teams.a11yZoomIn"),
      "controls.zoomOut.ariaLabel": t("teams.a11yZoomOut"),
      "controls.fitView.ariaLabel": t("teams.a11yFitView"),
      "controls.interactive.ariaLabel": t("teams.a11yControls"),
      "minimap.ariaLabel": t("teams.miniMap"),
      "handle.ariaLabel": t("teams.a11yHandle"),
    }),
    [t],
  );

  const persistNow = useCallback<OnNodeDrag<MemberNode>>(
    (_event, _node, dragged) => {
      const map: Positions = {};
      for (const node of nodesRef.current) {
        map[node.id] = { x: node.position.x, y: node.position.y };
      }
      // The dragged nodes carry the authoritative final positions.
      for (const node of dragged) {
        map[node.id] = { x: node.position.x, y: node.position.y };
      }
      onPersistLayout(map);
    },
    [onPersistLayout],
  );

  return (
    <div
      ref={boxRef}
      className={[
        "tcv",
        phase === "arriving" ? "tv-arriving" : "",
        phase === "landed" ? "tv-landed" : "",
        connecting ? "tcv--connecting" : "",
        showHint ? "tcv--hint" : "",
        fitted ? "" : "tcv--unfit",
      ]
        .filter((c) => c !== "")
        .join(" ")}
    >
      <ReactFlow
        nodes={nodes}
        edges={shown}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onConnect={onConnect}
        onConnectStart={() => setConnecting(true)}
        onConnectEnd={() => setConnecting(false)}
        isValidConnection={isValidConnection}
        connectionLineComponent={ConnectionLine}
        // xyflow's deleteKeyCode listener is attached to **document**, not to
        // the canvas container: as long as the teams page is open and one
        // flow is selected, pressing Delete on any non-input element anywhere
        // on the page removes it — including long after focus moved to the
        // inspector or the member column. Deleting a flow has no confirmation
        // dialog, so this is a misfire that genuinely loses data. The
        // built-in behaviour is disabled and handled on the canvas container
        // instead, pulling the scope back to "focus really is in the canvas".
        deleteKeyCode={null}
        onKeyDown={(e) => {
          // Inside an input, Backspace deletes a character and Enter submits.
          // There is no input in the canvas today, but EdgeLabelRenderer and
          // Panel can both hold arbitrary content — don't let this rule rest
          // on "there happens to be none right now".
          if ((e.target as HTMLElement).closest("input, textarea, select") !== null) return;

          // Keyboard selection (Tab to a node, then Enter or Space) goes
          // through xyflow's built-in selection and does **not** fire
          // onNodeClick — without this, a keyboard user only sees the card
          // light up while the inspector on the right stays shut, and the
          // inspector is exactly where flows are created and members removed.
          //
          // ⚠️ `onSelectionChange` is deliberately **not** used here. Its
          // effect puts the handler itself in the dependency array
          // (`SelectionListenerInner`), and an inline function is a fresh
          // reference on every render, so it re-runs on every render. Mean-
          // while xyflow's internal selection and this component's
          // `selectedId` are two sources of truth that sync one beat apart,
          // so the two chase each other, setState back and forth, and end at
          // "Maximum update depth exceeded" with **the whole screen going
          // black** (reported during the D66 walkthrough). Reading `data-id`
          // off the event itself is one-directional: keyboard → onSelect,
          // subscribing to no store at all.
          if (e.key === "Enter" || e.key === " ") {
            const node = (e.target as HTMLElement).closest<HTMLElement>(".react-flow__node");
            const id = node?.dataset.id;
            if (id !== undefined) onSelect(id);
            return;
          }

          if (busy) return;
          if (e.key !== "Delete" && e.key !== "Backspace") return;
          const picked = edges.filter((edge) => edge.selected === true);
          if (picked.length === 0) return;
          e.preventDefault();
          for (const edge of picked) edge.data?.onRemove();
        }}
        ariaLabelConfig={ariaLabelConfig}
        onNodeClick={(_, node) => onSelect(node.id)}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={persistNow}
        onInit={(instance) => {
          flowRef.current = instance;
          setReady(true);
        }}
        minZoom={0.3}
        maxZoom={1.75}
      >
        <Controls showInteractive={false} showFitView={false}>
          <ControlButton
            className="tm-fit"
            onClick={() => fit(240)}
            aria-label={t("teams.a11yFitView")}
            title={t("teams.a11yFitView")}
          >
            <IconFit size={14} />
          </ControlButton>
        </Controls>
        <MiniMap
          pannable
          zoomable
          ariaLabel={t("teams.miniMap")}
          maskColor="var(--minimap-mask)"
          style={MINI_SIZE}
          nodeBorderRadius={14}
          nodeColor={(node) =>
            (node.data as MemberNodeData | undefined)?.state === "missing"
              ? "var(--text-3)"
              : "var(--agent)"
          }
        />
        {plan !== null && (
          <ViewportPortal>
            <OrbitCore team={team} geo={plan} pos={positions} />
          </ViewportPortal>
        )}
        {showHint && (
          <Panel position="top-center" className="tcv-hint-slot">
            <div className="canvas-hint">
              {orbit ? t("teams.dragHintOrbit") : t("teams.dragHint")}
              <button
                className="btn btn-small"
                onClick={() => {
                  dismissCanvasHint();
                  setShowHint(false);
                }}
              >
                {t("common.gotIt")}
              </button>
            </div>
          </Panel>
        )}
        {flowError !== null && (
          <Panel position="top-center">
            <div className="alert alert-error canvas-alert">
              {flowError}
              <button className="btn btn-ghost" onClick={onClearFlowError}>
                {t("common.close")}
              </button>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

/**
 * What a node draws on screen: its box plus the star or planet and the words,
 * which the skins place partly outside the box. Decorations that trail away
 * (the outgoing tail, the halo) are left out — they are not "the member".
 */
function drawnBox(node: Element | null): { left: number; top: number; right: number; bottom: number } | null {
  if (node === null) return null;
  const parts = [node, ...node.querySelectorAll("[data-star], .cn-head, .cn-meta")];
  const rs = parts.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 || r.height > 0);
  if (rs.length === 0) return null;
  return {
    left: Math.min(...rs.map((r) => r.left)),
    top: Math.min(...rs.map((r) => r.top)),
    right: Math.max(...rs.map((r) => r.right)),
    bottom: Math.max(...rs.map((r) => r.bottom)),
  };
}

function MemberNodeComp({ id, data, selected, positionAbsoluteX, positionAbsoluteY }: NodeProps<MemberNode>) {
  const { t } = useTranslation();
  // On the orbit the words go on the side away from the cube, asked from
  // where the node is right now — so they flip mid-drag (spec 50 §15).
  const side = data.orbit === null ? undefined : sideOf(data.orbit, { x: positionAbsoluteX, y: positionAbsoluteY });
  // While a connection is dragged, the node under the pointer says whether it
  // can take it: a violet frame, or faded with a dashed frame (spec 50 §4).
  const conn = useConnection();
  const over = conn.inProgress && conn.toNode?.id === id;
  const drop = over ? (conn.isValid === true ? "can-drop" : "no-drop") : "";
  return (
    <div
      className={[
        "canvas-node",
        data.state === "missing" ? "canvas-node--missing" : "",
        selected ? "canvas-node--selected" : "",
        data.born ? "tsm-born" : "",
        data.hl ? "tv-hl" : "",
        drop,
      ]
        .filter((c) => c !== "")
        .join(" ")}
      data-side={side}
    >
      <Handle type="target" position={Position.Left} className="tm-h tm-h--tgt" />
      {/* Decorative: the same status already has text in cn-meta (pending
          count / nothing pending) and in the missing chip, so announcing
          it again would only be noise. title is left for mouse users. */}
      <i
        aria-hidden="true"
        className="tsm-dot"
        data-star={id}
        data-dot={data.state}
        title={t(
          data.state === "missing"
            ? "teams.missing"
            : data.state === "pending"
              ? "teams.pending"
              : "teams.nodeIdle",
        )}
      />
      {data.orbit === null && (
        <i
          aria-hidden="true"
          className={`tsm-tail${data.out ? " out" : ""}${data.outAuto ? " auto" : ""}`}
        />
      )}
      <div className="cn-head">
        <span className="canvas-node-name">{data.label}</span>
        {/* No coordinator marker here (D117): the prime is never a member, so
            this canvas draws the flow and nothing above it. Who runs the team
            is a team-level fact and lives in the header. */}
        {data.state === "missing" && <span className="chip team-missing-chip">{t("teams.missing")}</span>}
      </div>
      <PathLabel className="cn-path" path={data.root} actions={false} />
      <div className="cn-meta">
        {data.pending === null ? (
          <span className="skel cn-meta-skel" aria-label={t("common.loading")} />
        ) : (
          <span className={data.pending > 0 ? "cn-meta-hot" : ""}>
            {data.pending > 0 ? t("teams.cardPending", { n: data.pending }) : t("teams.nodeIdle")}
          </span>
        )}
        {data.lastDelivery !== null && (
          <span className="cn-meta-last">{t("teams.nodeLast", { at: data.lastDelivery })}</span>
        )}
      </div>
      {data.pending !== null && data.pending > 0 && (
        <span className="canvas-node-badge" title={t("teams.pending")}>
          {data.pending}
        </span>
      )}
      {data.got !== null && (
        <i
          className="tv-got"
          aria-hidden="true"
          title={t("teams.routeOk")}
          style={{ "--arr": `${data.got}ms` } as CSSProperties}
        />
      )}
      <Handle type="source" position={Position.Right} className="tm-h tm-h--src" />
    </div>
  );
}

/** One full turn of the two lights on an automatic flow (C57). */
const FLOW_MS = 2400;

function FlowEdgeComp({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  selected,
  data,
}: EdgeProps<FlowEdge>) {
  const { t } = useTranslation();
  const geo = edgeGeo({ x: sourceX, y: sourceY }, { x: targetX, y: targetY }, data?.span ?? 1);
  const fwdAuto = data?.autoRoute === true;
  /** A two-way line (D176): the way back, and whether that way is automatic. */
  const back = data?.back ?? null;
  const backAuto = back?.autoRoute === true;
  const auto = fwdAuto || backAuto;
  /** The orbit's arc (D157), drawn from planet to planet rather than handle to handle. */
  const draw = data?.draw ?? null;
  const d = draw?.d ?? geo.d;
  // The two lights keep the global phase: a line redrawn mid-run (a drag, a
  // re-read) carries on where it was instead of starting over.
  const [phase] = useState(() => performance.now() % FLOW_MS);
  const mark = data?.mark ?? null;
  const at = mark ?? { ...geo.mid, a: 0 };
  const deg = (at.a * 180) / Math.PI;
  const tf = `translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) rotate(${deg.toFixed(1)})`;
  return (
    <>
      <g
        className={`tm-edge${auto ? " tm-edge--auto" : ""}${selected === true ? " tm-edge--on" : ""}`}
        data-edge={id}
      >
        <BaseEdge id={id} path={d} className="tm-line" interactionWidth={16} />
        {auto &&
          // The orbit drops them on a selected flow, as the design does: the
          // line itself turns ink and the lights would only cover it.
          !(draw !== null && selected === true) &&
          // Each automatic direction gets its pair of lights; the way back
          // on a two-way line runs them backwards along the same path.
          [
            ...(fwdAuto ? [0, 1].map((k) => ({ k, rev: false })) : []),
            ...(backAuto ? [0, 1].map((k) => ({ k, rev: true })) : []),
          ].map(({ k, rev }) => {
            const style: CSSProperties = {
              animationDelay: `-${Math.round((phase + (k * FLOW_MS) / 2 + (rev ? FLOW_MS / 4 : 0)) % FLOW_MS)}ms`,
              animationDirection: rev ? "reverse" : undefined,
            };
            return (
              <g key={`${rev ? "b" : "f"}${k}`} aria-hidden="true">
                <path className="tv-flow-glow" d={d} pathLength={100} style={style} />
                <path className="tv-flow" d={d} pathLength={100} style={style} />
              </g>
            );
          })}
        {/* The direction mark carries the shape (D64: status never by colour
            alone). Star map — manual: a small chevron along the line;
            automatic: the bolt inside a drop of light whose point faces
            downstream, so direction still reads with the lights stopped.
            Orbit — an arrowhead at the receiving end, and on an automatic
            flow a bolt in a ring, placed clear of planets, the cube and the
            other bolts. */}
        {draw !== null ? (
          <>
            <path className="tvo-arrow" d={ARROW_PATH} transform={draw.arrow} aria-hidden="true" />
            {back !== null && <path className="tvo-arrow" d={ARROW_PATH} transform={draw.back} aria-hidden="true" />}
            {auto && selected !== true && (
              <g className="tvo-bolt" transform={`translate(${draw.mark.x.toFixed(1)} ${draw.mark.y.toFixed(1)})`} aria-hidden="true">
                <title>{t("teams.autoChip")}</title>
                <circle r={9} />
                <path d={BOLT_PATH} transform="scale(.5) translate(-12 -12)" />
              </g>
            )}
          </>
        ) : back !== null ? (
          // Two-way (D176): chevrons pointing both ways, and on an automatic
          // line a round drop with the bolt between them — a drop's point
          // would name one direction.
          <g transform={tf} aria-hidden="true">
            {auto && <title>{t("teams.autoChip")}</title>}
            {auto && (
              <g className="tsm-drop">
                <circle className="tsm-drop-o" r={8} />
                <path className="tsm-bolt" d={BOLT_PATH} transform={`rotate(${(-deg).toFixed(1)}) scale(.5) translate(-12 -12)`} />
              </g>
            )}
            <path
              className="tsm-chev"
              d={auto ? "M-11,-4.5 L-16.5,0 L-11,4.5 M11,-4.5 L16.5,0 L11,4.5" : "M-1.5,-4.5 L-7,0 L-1.5,4.5 M1.5,-4.5 L7,0 L1.5,4.5"}
            />
          </g>
        ) : auto ? (
          <g className="tsm-drop" transform={tf} aria-hidden="true">
            <title>{t("teams.autoChip")}</title>
            <path className="tsm-drop-o" d="M13,0 L4.93,6.3 A8,8 0 1 1 4.93,-6.3 Z" />
            <path className="tsm-bolt" d={BOLT_PATH} transform={`rotate(${(-deg).toFixed(1)}) scale(.5) translate(-12 -12)`} />
          </g>
        ) : (
          <path className="tsm-chev" d="M-3.5,-4.5 L2,0 L-3.5,4.5" transform={tf} aria-hidden="true" />
        )}
      </g>
      {selected === true && data !== undefined && (
        <EdgeLabelRenderer>
          {/* At the mark, not at the curve's midpoint: the mark has already
              stepped clear of every star (the design put this button at
              t = 0.5 and it covered a star in scene 68). */}
          <button
            className="btn btn-small canvas-edge-del nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${at.x}px, ${at.y}px)` }}
            onClick={data.onRemove}
          >
            <IconX size={12} /> {back !== null ? t("teams.removeLine") : t("teams.removeEdge")}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** The line being dragged: dashed, the same curve the flow will become. */
function ConnectionLine({ fromX, fromY, toX, toY }: { fromX: number; fromY: number; toX: number; toY: number }) {
  const g = edgeGeo({ x: fromX, y: fromY }, { x: toX, y: toY }, 1);
  return <path className="tm-conn" d={g.d} />;
}

/** The design's minimap is 180 × 120 (xyflow draws 200 × 150 by default). */
const MINI_SIZE = { width: 180, height: 120 };

const nodeTypes = { member: MemberNodeComp };
const edgeTypes = { flow: FlowEdgeComp };

/**
 * xyflow's aria-live announcements hand in the direction as an English
 * literal ('up'/'down'/'left'/'right'), which a non-English UI has to look
 * up once more. All four `t()` calls are deliberately written as literals
 * rather than built from a dynamic key — D65's programmatic i18n
 * reconciliation works by scanning `t("…")` call sites against the
 * dictionary, and a dynamic key makes the whole group invisible to it.
 */
function dirLabel(direction: string, t: TFunction): string {
  if (direction === "up") return t("teams.dirUp");
  if (direction === "down") return t("teams.dirDown");
  if (direction === "left") return t("teams.dirLeft");
  return t("teams.dirRight");
}
