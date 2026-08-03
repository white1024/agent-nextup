import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  getBezierPath,
  useEdgesState,
  useNodesState,
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

import { IconBolt, IconX } from "../../components/icons";
import { ROW, autoPositions, canConnect, layersOf } from "./layout";
import type { Team } from "../../types";
import PathLabel from "../../components/PathLabel";
import { canvasHintEnabled, dismissCanvasHint } from "../../lib/prefs";

type MemberNodeData = {
  label: string;
  root: string;
  missing: boolean;
  pending: number;
  /** Preformatted arrival time of this member's latest delivery, if any. */
  lastDelivery: string | null;
};
type MemberNode = Node<MemberNodeData, "member">;
/** `span` = how many layers the edge crosses; ≥2 means it bypasses a node. */
type FlowEdgeData = { onRemove: () => void; span: number; autoRoute: boolean };
type FlowEdge = Edge<FlowEdgeData, "flow">;

interface Props {
  team: Team;
  missing: Set<string>;
  /** Pending outbox envelope count per member workspaceId (node badge). */
  pending: Map<string, number>;
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
  /** Full position map after a drag ends (D53 §4 — the only write moments). */
  onPersistLayout: (positions: Record<string, { x: number; y: number }>) => void;
}

/**
 * Team flow canvas (D53, 12 §2–§3): xyflow canvas with member nodes and
 * delivery edges. Edges are drawn by dragging from a node's source handle to
 * a target handle; `isValidConnection` pre-blocks self/duplicate/cycle so an
 * invalid edge cannot be dropped — core stays the enforcer. Node positions
 * come from teams.json `layout` (auto-placed when absent) and persist only on
 * drag end / auto-tidy, never on open.
 */
export default function Canvas({
  team,
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
  onPersistLayout,
}: Props) {
  const { t } = useTranslation();
  // Only worth saying when there is something to connect: a one-node (or empty)
  // team has no second endpoint, and the empty state already guides.
  const [showHint, setShowHint] = useState(
    () => canvasHintEnabled() && team.members.length > 1,
  );
  const [nodes, setNodes, onNodesChange] = useNodesState<MemberNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  // Derive nodes from the team. Position precedence: saved layout → current
  // on-canvas position (mid-session, not yet saved) → deterministic auto slot.
  useEffect(() => {
    setNodes((prev) => {
      const before = new Map(prev.map((node) => [node.id, node.position]));
      const auto = autoPositions(team);
      return team.members.map((member) => ({
        id: member.workspaceId,
        type: "member" as const,
        position:
          team.layout?.[member.workspaceId] ??
          before.get(member.workspaceId) ??
          auto[member.workspaceId],
        deletable: false,
        selected: member.workspaceId === selectedId,
        data: {
          label: member.name,
          root: member.root,
          missing: missing.has(member.workspaceId),
          pending: pending.get(member.workspaceId) ?? 0,
          lastDelivery: lastDelivery.get(member.workspaceId) ?? null,
        },
      }));
    });
  }, [team, missing, pending, lastDelivery, selectedId, setNodes]);

  useEffect(() => {
    const layer = layersOf(team);
    setEdges(
      team.edges.map((edge) => {
        const from = layer.get(edge.from);
        const to = layer.get(edge.to);
        return {
          id: `${edge.from}->${edge.to}`,
          source: edge.from,
          target: edge.to,
          type: "flow" as const,
          // Automatic edges get the accent colour on both the line and the
          // arrow, drawing "this one delivers by itself" onto the canvas
          // (D71: edges previously didn't reflect autoRoute at all, so you
          // had to click into each node to find out).
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 16,
            height: 16,
            color: edge.autoRoute ? "var(--accent)" : "var(--text-3)",
          },
          data: {
            onRemove: () => onRemoveEdge(edge.from, edge.to),
            span: from !== undefined && to !== undefined ? to - from : 1,
            autoRoute: edge.autoRoute,
          },
        };
      }),
    );
  }, [team, setEdges, onRemoveEdge]);

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

  // Pan onto the member the rail asked for. Held as a ref rather than via
  // useReactFlow, which would need this component to sit inside a provider it
  // itself renders.
  const flowRef = useRef<ReactFlowInstance<MemberNode, FlowEdge> | null>(null);
  useEffect(() => {
    if (focus === null) return;
    const flow = flowRef.current;
    const node = flow?.getNode(focus.id);
    if (flow === null || node === undefined) return;
    flow.setCenter(
      node.position.x + (node.measured?.width ?? 230) / 2,
      node.position.y + (node.measured?.height ?? 70) / 2,
      { zoom: flow.getZoom(), duration: 320 },
    );
  }, [focus]);

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
      const map: Record<string, { x: number; y: number }> = {};
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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
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
      }}
      fitView
      fitViewOptions={FIT_VIEW}
      minZoom={0.3}
      maxZoom={1.75}
    >
      {/* --border on the canvas's --surface-1 is only 1.27:1, so in dark the
          dot grid effectively doesn't exist (same token pair and same
          surface D57 fixed for node borders). The dots are material, not a
          control boundary, so this takes --border-strong rather than being
          pushed to 3:1 — that would turn into a very noisy grid. */}
      <Background
        variant={BackgroundVariant.Dots}
        gap={22}
        size={1.4}
        color="var(--border-strong)"
      />
      <Controls showInteractive={false} />
      <MiniMap
        pannable
        zoomable
        ariaLabel={t("teams.miniMap")}
        maskColor="var(--minimap-mask)"
        nodeColor={(node) =>
          (node.data as MemberNodeData | undefined)?.missing === true
            ? "var(--text-3)"
            : "var(--accent)"
        }
      />
      {showHint && (
        <Panel position="top-center">
          <div className="canvas-hint">
            {t("teams.dragHint")}
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
  );
}

function MemberNodeComp({ data, selected }: NodeProps<MemberNode>) {
  const { t } = useTranslation();
  const state = data.missing ? "missing" : data.pending > 0 ? "pending" : "ok";
  return (
    <div
      className={[
        "canvas-node",
        data.missing ? "canvas-node--missing" : "",
        selected ? "canvas-node--selected" : "",
      ]
        .filter((c) => c !== "")
        .join(" ")}
    >
      <Handle type="target" position={Position.Left} />
      <div className="cn-head">
        {/* Decorative: the same status already has text in cn-meta (pending
            count / nothing pending) and in the missing chip, so announcing
            it again would only be noise. title is left for mouse users. */}
        <span
          aria-hidden="true"
          className={`cn-dot cn-dot--${state}`}
          title={t(
            state === "missing"
              ? "teams.missing"
              : state === "pending"
                ? "teams.pending"
                : "teams.nodeIdle",
          )}
        />
        <span className="canvas-node-name">{data.label}</span>
        {data.missing && <span className="chip team-missing-chip">{t("teams.missing")}</span>}
      </div>
      <PathLabel className="cn-path" path={data.root} copyable={false} />
      <div className="cn-meta">
        <span className={data.pending > 0 ? "cn-meta-hot" : ""}>
          {data.pending > 0 ? t("teams.cardPending", { n: data.pending }) : t("teams.nodeIdle")}
        </span>
        {data.lastDelivery !== null && (
          <span className="cn-meta-last">{t("teams.nodeLast", { at: data.lastDelivery })}</span>
        )}
      </div>
      {data.pending > 0 && (
        <span className="canvas-node-badge" title={t("teams.pending")}>
          {data.pending}
        </span>
      )}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

function FlowEdgeComp({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
  markerEnd,
}: EdgeProps<FlowEdge>) {
  const { t } = useTranslation();
  // An edge that skips a layer runs straight through whatever sits between its
  // endpoints — and nodes paint over edges, so the flow reads as "a line that
  // vanishes into a box". Bow those over the top instead. `autoPositions` also
  // steps bypassed nodes off the line; this covers hand-dragged layouts.
  const bowed = (data?.span ?? 1) >= 2 && Math.abs(targetY - sourceY) < ROW * 0.75;
  let path: string;
  let labelX: number;
  let labelY: number;
  if (bowed) {
    const dx = targetX - sourceX;
    const lift = Math.min(110, Math.max(46, Math.abs(dx) * 0.22));
    path =
      `M ${sourceX},${sourceY} ` +
      `C ${sourceX + dx * 0.35},${sourceY - lift} ` +
      `${targetX - dx * 0.35},${targetY - lift} ` +
      `${targetX},${targetY}`;
    labelX = (sourceX + targetX) / 2;
    labelY = (sourceY + targetY) / 2 - lift * 0.75;
  } else {
    [path, labelX, labelY] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    });
  }
  const auto = data?.autoRoute === true;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={auto ? AUTO_EDGE_STYLE : undefined} />
      {/* The ⚡ marker carries shape rather than colour (D64: status never
          conveyed by colour alone). Purely visual and not clickable, so it
          doesn't block selecting the edge; when selected it yields entirely
          to the delete button so the two don't stack at the midpoint. */}
      {auto && selected !== true && (
        <EdgeLabelRenderer>
          <div
            className="canvas-edge-auto nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={t("teams.autoChip")}
          >
            <IconBolt size={11} />
          </div>
        </EdgeLabelRenderer>
      )}
      {selected === true && data !== undefined && (
        <EdgeLabelRenderer>
          <button
            className="btn btn-small canvas-edge-del nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            onClick={data.onRemove}
          >
            <IconX size={12} /> {t("teams.removeEdge")}
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

/** Line style for automatic edges: a solid accent stroke, slightly thicker
 *  than the default so it reads over the grey ones. Kept as a module-level
 *  constant to keep the reference stable. */
const AUTO_EDGE_STYLE = { stroke: "var(--accent)", strokeWidth: 2 };

const nodeTypes = { member: MemberNodeComp };
const edgeTypes = { flow: FlowEdgeComp };

/**
 * A module-level constant rather than an inline object literal:
 * `fitViewOptions` is listed in xyflow's `reactFlowFieldsToTrack`, so a
 * fresh reference on every render means one more store write each time.
 * This one can't close a loop the way `onSelectionChange` did (it never
 * calls back into this component), but the same file just blacked out the
 * screen once over an unstable reference — no reason to leave a second.
 */
const FIT_VIEW = { padding: 0.25, maxZoom: 1.2 };

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

