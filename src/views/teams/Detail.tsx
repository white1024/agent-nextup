import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { readBoxes, sameRoot } from "../../lib/exchange";
import { useGuardedMutation } from "../../hooks";
import { useFreshKeys } from "../../hooks/anim";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import { Switch } from "../../components/controls";
import { autoRouteSweep, type ToastSpec } from "../../lib/teamAutoRoute";
import {
  IconArrowRight,
  IconCaretDown,
  IconCheck,
  IconEnvelope,
  IconFolder,
  IconMinus,
  IconPlus,
  IconStar,
  IconX,
} from "../../components/icons";
import Canvas, { type CanvasApi } from "./Canvas";
import { canConnect } from "./layout";
import TimeAgo from "../../components/TimeAgo";
import { relativeTime } from "../../lib/time";
import { splitAroundCount } from "../../lib/format";
import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import { fadeRowsOut } from "../../lib/listMotion";
import PathLabel from "../../components/PathLabel";
import { BACK_OUT_MS, arriveAt, fadeDialog, foldLetter, peekStars, replay, sendTiming } from "./motion";
import { teamSkin } from "../../lib/prefs";
import { RelinkLine, pickSearchFolder } from "./TeamTransfer";
import { mergeRelink, scopeReport } from "./transfer";
import type {
  DeliverySummary,
  RelinkReport,
  RouteOutcome,
  Team,
  TeamMember,
  WorkspaceOverview,
} from "../../types";

interface Props {
  /** The team being viewed (a row of `teams` — parent keeps it fresh). */
  team: Team;
  /** All teams — routing candidates are the cross-team union (09 §5). */
  teams: Team[];
  registry: WorkspaceOverview[];
  refreshKey: number;
  /** Every mutation returns the full list; push it up so list + detail stay one source. */
  onTeams: (teams: Team[]) => void;
  /** Back to the list, handing over where the stars stood (C56) — null for no flight. */
  /** `scale` is the canvas's zoom as it was left — the orbit's cube flies home from that size (C62). */
  onBack: (stars: Record<string, Point> | null, scale?: number) => void;
  /** App-level toast sink — the auto-send sweep announces through it (D71). */
  pushToast: (spec: ToastSpec) => void;
}

/** One routing candidate: an edge target for the publishing workspace. */
interface RouteCandidate {
  teamId: string;
  teamName: string;
  workspaceId: string;
  root: string;
  name: string;
  /** The carrying edge's policy — shown as an "Auto" chip in the send modal. */
  autoRoute: boolean;
}

/** One arrival: an envelope sitting in a member inbox, deliveredVia this team. */
interface ArrivalRow {
  key: string;
  from: string;
  to: string;
  /** Receiving member's workspaceId — keys the per-node "last delivery". */
  toId: string;
  at: string;
  note: string | null;
}

/**
 * A send result as the page shows it (spec 50 §9): which envelope, from whom,
 * and one row per downstream with the team it went through. The core's
 * outcome carries names only; the picked candidates fill in the rest.
 */
interface ShownOutcome {
  envelope: { id: string; note: string | null; at: string };
  from: string;
  delivered: { workspaceId: string; teamId: string; name: string; teamName: string }[];
  alreadyDelivered: string[];
  failed: RouteOutcome["failed"];
  /** Rows appear as the light reaches them (C58); false = at once. */
  live: boolean;
}

/** History rows shown at once — honest cap, D47 precedent. */
const HISTORY_CAP = 50;

/**
 * Full-page team canvas (D53, 12 §2; drawn as the D153 star map, spec 50
 * §3–§9): a summary line, the member rail, the flow canvas with its inspector,
 * and the delivery history under it. Routing still happens here and only here
 * — the human at the Send button is the fan-out point (team module design §5).
 */
export default function TeamDetail({
  team,
  teams,
  registry,
  refreshKey,
  onTeams,
  onBack,
  pushToast,
}: Props) {
  const { t, i18n } = useTranslation();
  // `null` until the cross-workspace fan-out lands (D65, invariant 10). Same read
  // the team cards put a skeleton behind — here it used to fall through to
  // "nothing pending", which is a claim about another project's outbox made
  // before that outbox was opened.
  const [outboxes, setOutboxes] = useState<
    | { workspaceId: string; name: string; root: string; rows: DeliverySummary[]; error: string | null }[]
    | null
  >(null);
  const [missing, setMissing] = useState<Set<string>>(new Set());
  /** What the last "find automatically" did, for this team's members (D173 ①). */
  const [relinkReport, setRelinkReport] = useState<RelinkReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One instance across `run`, `runFlow` and `routeNow`: they shared a single
  // `busy` that gates 15 disabled bindings, and splitting them would quietly
  // widen what stays clickable mid-write. `runFlow` overrides only the error
  // sink, per call.
  const { busy, run: runMutation } = useGuardedMutation(setError);

  // Inline rename.
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState("");

  // Member surfaces.
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState("");
  // Coordinator surface — team-level, so it is not tied to the selected node.
  const [primePicking, setPrimePicking] = useState(false);
  const [primeFilter, setPrimeFilter] = useState("");
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null);
  /** Node selected on the canvas → right inspector. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Rail-driven "pan onto this node" request; the nonce re-fires on re-click. */
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);

  // Edge/canvas failures render on the canvas, not in the page-level slot.
  const [flowError, setFlowError] = useState<string | null>(null);

  /** Inspector's "send to" picker — the keyboard-reachable way to draw an edge. */
  const [edgeDraft, setEdgeDraft] = useState("");

  // Bottom history dock; `dockIn` marks the moment it opens (C52 plays once).
  const [dockOpen, setDockOpen] = useState(false);
  const [dockIn, setDockIn] = useState(false);

  // Send modal: the envelope being routed + per-candidate checkboxes.
  const [routing, setRouting] = useState<{
    root: string;
    workspaceId: string;
    delivery: DeliverySummary;
    candidates: RouteCandidate[];
    checked: Set<string>;
  } | null>(null);
  const [outcome, setOutcome] = useState<ShownOutcome | null>(null);
  /** A result row is hovered: its member's star lights up on the canvas. */
  const [hl, setHl] = useState<string | null>(null);

  // C54 / C59 triggers for the canvas, and what the page drives on it.
  const [tidy, setTidy] = useState(0);
  const [freshEdge, setFreshEdge] = useState<string | null>(null);
  /** The inspector row of a flow just created (C51) — kept past the canvas's own draw. */
  const [flowFresh, setFlowFresh] = useState<string | null>(null);
  const canvasApi = useRef<CanvasApi | null>(null);
  /** Star map or orbit (D157): read once — Settings is another page, so it cannot change under this one. */
  const [skin] = useState(teamSkin);
  const pageRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const sendFormRef = useRef<HTMLDivElement>(null);

  // C56: arriving from the card, the page's blocks rise while the stars fly;
  // leaving, its words fade first.
  const [entering, setEntering] = useState(() => peekStars(team.id, "open"));
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (!entering) return;
    const id = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(id);
  }, [entering]);

  // Pending outboxes of the members (per-member reads so one offline folder
  // cannot hide the others).
  const loadOutboxes = useCallback(async () => {
    const reads = await readBoxes(team.members, (member) => member.root, "outbox");
    return reads.map(({ target: member, rows, error }) => ({
      workspaceId: member.workspaceId,
      name: member.name,
      root: member.root,
      rows,
      error,
    }));
  }, [team]);

  useEffect(() => {
    let cancelled = false;
    void loadOutboxes().then(async (result) => {
      if (cancelled) return;
      setOutboxes(result);
      // Auto-send sweep (D71), call site ②: only members with something
      // waiting are worth a sweep. Converge with one re-read — never by
      // subscribing this effect to the state it writes.
      let moved = false;
      for (const box of result) {
        if (box.error !== null || box.rows.length === 0) continue;
        moved = (await autoRouteSweep(box.root, { pushToast, t })) || moved;
      }
      if (moved && !cancelled) {
        const fresh = await loadOutboxes();
        // Re-check after the await: a re-run (teams/refreshKey changed) may
        // have written newer rows while this read was in flight.
        if (!cancelled) setOutboxes(fresh);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [loadOutboxes, refreshKey, teams, pushToast, t]);

  // Delivery history = arrival log (11 §5): the member inboxes ARE the record
  // — deliveredVia/deliveredAt are stamped by routing, so no ledger read and
  // no new IPC. An unreachable member's arrivals are simply absent (hinted).
  const [history, setHistory] = useState<ArrivalRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  /** Latest arrival per member workspaceId, as an ISO string (formatted at render). */
  const [lastAtByMember, setLastAtByMember] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let cancelled = false;
    // An unreachable member simply contributes no arrivals (hinted in the
    // dock) — `readBoxes` hands back empty rows for it.
    void readBoxes(team.members, (member) => member.root, "inbox").then((reads) => {
      if (cancelled) return;
      const all = reads
        .flatMap(({ target: member, rows }) =>
          rows
            .filter((row) => row.deliveredVia?.teamId === team.id)
            .map((row) => ({
              key: `${row.id}:${member.workspaceId}`,
              from: row.from.name,
              to: member.name,
              toId: member.workspaceId,
              at: row.deliveredAt ?? row.publishedAt,
              note: row.note ?? null,
            })),
        )
        .sort((a, b) => b.at.localeCompare(a.at));
      setHistoryTotal(all.length);
      setHistory(all.slice(0, HISTORY_CAP));
      // Computed over every arrival, not the capped page — a quiet member's
      // last delivery can sit well past row 50.
      const latest = new Map<string, string>();
      for (const row of all) if (!latest.has(row.toId)) latest.set(row.toId, row.at);
      setLastAtByMember(latest);
    });
    return () => {
      cancelled = true;
    };
  }, [team, refreshKey]);

  // Member liveness — registry first, probe fallback. A probe failure does not
  // accuse: only a positive "folder gone / no longer a workspace" marks missing.
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      team.members.map(async (member) => {
        const row = registry.find((r) => sameRoot(r.root, member.root));
        if (row !== undefined) return [member.workspaceId, !row.exists] as const;
        const parts = splitRoot(member.root);
        if (parts === null) return [member.workspaceId, true] as const;
        try {
          const probe = await api.probeInitTarget(parts.parent, parts.folder);
          return [member.workspaceId, !(probe.exists && probe.isWorkspace)] as const;
        } catch {
          return [member.workspaceId, false] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled)
        setMissing(new Set(entries.filter(([, gone]) => gone).map(([id]) => id)));
    });
    return () => {
      cancelled = true;
    };
  }, [team, registry, refreshKey]);

  /** All edge targets of `workspaceId`, across every team (09 §5 — the union). */
  const candidatesFor = useCallback(
    (workspaceId: string): RouteCandidate[] => {
      const rows: RouteCandidate[] = [];
      for (const one of teams) {
        for (const edge of one.edges) {
          if (edge.from !== workspaceId) continue;
          const target = one.members.find((m) => m.workspaceId === edge.to);
          if (!target) continue;
          rows.push({
            teamId: one.id,
            teamName: one.name,
            workspaceId: target.workspaceId,
            root: target.root,
            name: target.name,
            autoRoute: edge.autoRoute,
          });
        }
      }
      return rows;
    },
    [teams],
  );

  /**
   * Registry workspaces holding no seat in this team yet — the candidates for
   * *either* seat, because one workspace cannot hold both (D117). Both pickers
   * read this one list; splitting it would be two names for one rule, and the
   * two copies would drift the first time the rule changed.
   */
  const joinable = registry.filter(
    (row) =>
      row.exists &&
      !team.members.some((m) => sameRoot(m.root, row.root)) &&
      !(team.prime && sameRoot(team.prime.root, row.root)),
  );
  const search = (q: string) => {
    const needle = q.trim().toLowerCase();
    if (needle === "") return joinable;
    return joinable.filter(
      (row) =>
        row.name.toLowerCase().includes(needle) || row.root.toLowerCase().includes(needle),
    );
  };
  const filtered = search(filter);
  const primeFiltered = search(primeFilter);

  const edgesOf = useCallback(
    (workspaceId: string) =>
      team.edges.filter((e) => e.from === workspaceId || e.to === workspaceId).length,
    [team],
  );

  function run(action: () => Promise<Team[]>) {
    return runMutation(async () => {
      setError(null);
      onTeams(await action());
    });
  }

  const runFlow = useCallback(
    (action: () => Promise<Team[]>) =>
      // Edge/canvas failures render on the canvas, not the page-level slot.
      runMutation(async () => {
        setFlowError(null);
        onTeams(await action());
      }, setFlowError),
    [onTeams, runMutation],
  );

  // Stable canvas callbacks (the edge-sync effect in Canvas depends on them).
  // D176: drawing a line connects both ways; a one-way line is a direction
  // removed afterwards in the inspector.
  const addEdge = useCallback(
    (from: string, to: string) =>
      void runFlow(async () => {
        const list = await api.teamLink(team.id, from, to);
        // C59: the new line draws itself once the canvas has it; C51: its row
        // slides into the inspector.
        const key = `${from}->${to}`;
        setFreshEdge(key);
        setFlowFresh(key);
        window.setTimeout(() => setFlowFresh((k) => (k === key ? null : k)), 1200);
        return list;
      }),
    [runFlow, team.id],
  );
  const removeEdge = useCallback(
    (from: string, to: string) => void runFlow(() => api.teamRemoveEdge(team.id, from, to)),
    [runFlow, team.id],
  );
  const removeLine = useCallback(
    (a: string, b: string) => void runFlow(() => api.teamUnlink(team.id, a, b)),
    [runFlow, team.id],
  );
  const setEdgeAuto = useCallback(
    (from: string, to: string, autoRoute: boolean) =>
      void runFlow(() => api.teamSetEdgeAutoRoute(team.id, from, to, autoRoute)),
    [runFlow, team.id],
  );
  /** Batch key: one click over every edge of this team (13 §2.1 — no batch IPC). */
  async function setAllAuto(target: boolean) {
    const stale = team.edges.filter((e) => e.autoRoute !== target);
    if (stale.length === 0) return;
    await run(async () => {
      let latest: Team[] = teams;
      for (const edge of stale) {
        latest = await api.teamSetEdgeAutoRoute(team.id, edge.from, edge.to, target);
      }
      return latest;
    });
  }
  const persistLayout = useCallback(
    (positions: Record<string, { x: number; y: number }>) =>
      void runFlow(() => api.teamSetLayout(team.id, positions, skin)),
    [runFlow, team.id, skin],
  );
  /** Null until the outboxes are read — the canvas keeps every star violet till then. */
  const pendingCount = useMemo(
    () => (outboxes === null ? null : new Map(outboxes.map((box) => [box.workspaceId, box.rows.length]))),
    [outboxes],
  );

  async function saveName() {
    const name = nameDraft.trim();
    setRenaming(false);
    if (name === "" || name === team.name) return;
    await run(() => api.teamRename(team.id, name));
  }

  /**
   * Hand this team's coordination to a workspace's agent, or take it back
   * (D116/D117). Takes a root — the prime is not a member, so there is no
   * member row to have resolved a workspaceId already.
   *
   * Deliberately no confirmation: it grants nothing on its own. That project
   * also needs its `prime` module on and the app_scope tools granted in its
   * own catalog, and clearing is instant and lossless — a reversible action,
   * so the third tier of D102 applies (no red, no modal).
   */
  async function setPrime(root: string | null) {
    setPrimePicking(false);
    setPrimeFilter("");
    await run(() => api.teamSetPrime(team.id, root));
  }

  /** Re-link a moved member: pick its new folder, core matches the stable id. */
  async function rebind(member: TeamMember) {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await run(() => api.teamRebindWorkspace(member.workspaceId, dir));
  }

  /**
   * Find missing members by their stable id (D173 ①) — the graph's own paths
   * and this machine's project list, plus `dir` and the folders directly
   * under it when the person picked one. The pass covers every team; the line
   * speaks about this one. A follow-up folder search folds into the line
   * already showing, so what was found stays said.
   */
  function relinkNow(dir: string | null) {
    return runMutation(async () => {
      setError(null);
      const done = await api.teamRelink(dir);
      onTeams(done.teams);
      const here = done.teams.filter((x) => x.id === team.id);
      const report = scopeReport(done.report, here);
      setRelinkReport((before) => (dir !== null && before !== null ? mergeRelink(before, report) : report));
    });
  }

  async function relinkInFolder() {
    const dir = await pickSearchFolder();
    if (dir !== null) await relinkNow(dir);
  }

  const railRow = (id: string) =>
    railRef.current?.querySelector<HTMLElement>(`[data-member="${CSS.escape(id)}"]`) ?? null;

  // The one place the ref gate is not a nicety: `teamRouteDelivery` is not
  // idempotent and it writes into *other* workspaces, so a same-tick double
  // click used to drop the same envelope into a teammate's inbox twice, with
  // nothing on either side able to take it back.
  function routeNow() {
    if (routing === null) return;
    const picked = routing.candidates.filter((c) => routing.checked.has(candidateKey(c)));
    if (picked.length === 0) return;
    const sending = routing;
    return runMutation(async () => {
      setError(null);
      const result = await api.teamRouteDelivery(
        sending.root,
        sending.delivery.id,
        picked.map((c) => ({ root: c.root, teamId: c.teamId, teamName: c.teamName })),
      );
      // C58 starts where the dialog is: measure the envelope before it goes
      // (an envelope with no note folds out of the dialog's title instead).
      const form = sendFormRef.current;
      const noteBox = (noteRef.current ?? form?.querySelector(".form-heading"))?.getBoundingClientRect() ?? null;
      const live = !motionOff() && noteBox !== null;
      if (live) fadeDialog(form?.closest<HTMLElement>(".modal-backdrop") ?? null);
      const shown = toShown(result, sending, picked, live);
      setOutcome(shown);
      setRouting(null);
      if (live) playSend(sending, shown, noteBox);
      onTeams(await api.teamsList());
      setOutboxes(await loadOutboxes());
    });
  }

  /**
   * C58: the envelope folds into light and flies to the sender's star; from
   * there one light per delivered downstream runs along its flow, 130ms
   * apart, and blooms on arrival. A downstream reached through another team
   * has no line here — its light runs between the two rail rows instead.
   *
   * C64 on the orbit: the same, with the lights leaving 40ms apart (one light
   * splitting) and the cube flaring once, the first moment any of them passes
   * through it.
   */
  function playSend(sending: NonNullable<typeof routing>, shown: ShownOutcome, noteBox: DOMRect | null) {
    const api = canvasApi.current;
    if (api === null || noteBox === null) return;
    const send = sendTiming(skin);
    api.frame([sending.workspaceId, ...shown.delivered.map((d) => d.workspaceId)]);
    void foldLetter(noteBox, sending.delivery.note ?? sending.delivery.id.slice(0, 8), () =>
      api.starOf(sending.workspaceId),
    );
    window.setTimeout(() => {
      let flare = Infinity;
      shown.delivered.forEach((d, k) => {
        const delay = k * send.stag;
        const local = d.teamId === team.id ? api.comet(sending.workspaceId, d.workspaceId, delay, send.along) : null;
        if (local !== null) {
          if (local.core !== null) flare = Math.min(flare, delay + local.core * send.along);
          window.setTimeout(() => {
            api.bloom(d.workspaceId);
            replay(railRow(d.workspaceId), "lit", 800);
          }, send.along + delay);
          return;
        }
        const a = centreOf(railRow(sending.workspaceId)?.querySelector(".tmr-dot"));
        const b = centreOf(railRow(d.workspaceId)?.querySelector(".tmr-dot"));
        if (a !== null && b !== null) fx.beam(a, b, { dur: send.along, delay, bend: 0.5, width: 2.2 });
      });
      if (Number.isFinite(flare)) window.setTimeout(() => api.flare(), Math.round(flare));
    }, send.fold + send.fly);
  }

  /** Leaving for the list: words fade, the stars stay to fly home (C56). */
  function goBack() {
    if (leaving) return;
    const stars = canvasApi.current?.stars() ?? {};
    const scale = canvasApi.current?.zoom() ?? 1;
    if (motionOff() || team.members.length === 0 || Object.keys(stars).length === 0) {
      onBack(null);
      return;
    }
    setLeaving(true);
    window.setTimeout(() => onBack(stars, scale), BACK_OUT_MS);
  }

  const lastDeliveryBy = useMemo(() => {
    const map = new Map<string, string>();
    for (const [id, at] of lastAtByMember) map.set(id, relativeTime(at, i18n.language));
    return map;
  }, [lastAtByMember, i18n.language]);

  const pendingTotal = useMemo(
    () => (outboxes ?? []).reduce((sum, box) => sum + box.rows.length, 0),
    [outboxes],
  );
  const lastOverall = useMemo(() => {
    let latest: string | null = null;
    for (const at of lastAtByMember.values()) {
      if (latest === null || at.localeCompare(latest) > 0) latest = at;
    }
    return latest === null ? null : relativeTime(latest, i18n.language);
  }, [lastAtByMember, i18n.language]);

  const selectedMember = team.members.find((m) => m.workspaceId === selectedId) ?? null;
  const selectedBox = outboxes?.find((box) => box.workspaceId === selectedId) ?? null;

  const nameOf = useCallback(
    (workspaceId: string) =>
      team.members.find((m) => m.workspaceId === workspaceId)?.name ?? workspaceId,
    [team.members],
  );

  // Edges touching the selected member, split by direction, plus the members it
  // may still send to. `canConnect` is shared with the canvas drag path so the
  // two entry points cannot disagree about what a legal edge is.
  const flowsOf = useMemo(() => {
    if (selectedId === null) return null;
    return {
      upstream: team.edges.filter((e) => e.to === selectedId),
      downstream: team.edges.filter((e) => e.from === selectedId),
      targets: team.members.filter((m) =>
        canConnect(selectedId, m.workspaceId, team.edges),
      ),
    };
  }, [selectedId, team.edges, team.members]);

  // Clear a stale pick when the selection moves or the graph changes under it —
  // otherwise the picker keeps showing a member who is no longer a legal target
  // and Create fails against core instead of never being offered.
  useEffect(() => {
    if (flowsOf === null) return;
    if (edgeDraft !== "" && !flowsOf.targets.some((m) => m.workspaceId === edgeDraft)) {
      setEdgeDraft("");
    }
  }, [flowsOf, edgeDraft]);

  // C51: a member just added drops into the rail with a sweep, and its star is
  // born on the canvas (C59); a flow just created slides into the inspector.
  const freshMembers = useFreshKeys(
    team.members.map((m) => m.workspaceId),
    1200,
    true,
  );

  /** Node/rail status: missing wins, then pending (once read), else idle. */
  function dotOf(workspaceId: string): "missing" | "pending" | "ok" {
    if (missing.has(workspaceId)) return "missing";
    return (pendingCount?.get(workspaceId) ?? 0) > 0 ? "pending" : "ok";
  }

  /** Each delivered member's ring shows when its light lands (C58). */
  const got = useMemo(() => {
    if (outcome === null) return null;
    const map = new Map<string, number>();
    outcome.delivered.forEach((d, k) => {
      if (d.teamId === team.id) map.set(d.workspaceId, outcome.live ? arriveAt(k, skin) : 0);
    });
    return map;
  }, [outcome, team.id, skin]);

  // Whole-team auto-route state — the header tri-state doubles as the at-a-glance
  // indicator (D71 walkthrough feedback: the per-edge switches were the only way
  // to see this, one node at a time). Three states, not two: all auto /
  // partial N/M / all manual.
  const edgeTotal = team.edges.length;
  const autoCount = team.edges.filter((e) => e.autoRoute).length;
  const allAuto = edgeTotal > 0 && autoCount === edgeTotal;
  const someAuto = autoCount > 0 && autoCount < edgeTotal;

  const [fromBefore, fromAfter] = splitAroundCount((n) => t("teams.resultFrom", { name: n }));

  return (
    <div
      ref={pageRef}
      className={["view tmd", entering ? "tv-in" : "", leaving ? "tv-leaving" : ""].filter((c) => c !== "").join(" ")}
    >
      <header className="view-header tmd-head">
        <div className="vh-main">
          {renaming ? (
            <div className="field-row tmd-rename">
              <input
                autoFocus
                aria-label={t("teams.rename")}
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void saveName();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
              <button className="btn btn-primary" disabled={busy} onClick={() => void saveName()}>
                {t("teams.saveName")}
              </button>
            </div>
          ) : (
            <h1>{team.name}</h1>
          )}
          <p className="view-sub">
            {t("teams.detailSub")}
            {/* Who runs the team is a team-level fact, so it reads next to the
                team's own subtitle rather than on any node (D117). */}
            {team.prime && (
              <span className="team-prime-chip">
                <IconStar size={11} /> {t("teams.primeChip", { name: team.prime.name })}
              </span>
            )}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={goBack}>
            {t("teams.back")}
          </button>
          {!renaming && (
            <button
              className="btn"
              onClick={() => {
                setNameDraft(team.name);
                setRenaming(true);
              }}
            >
              {t("teams.rename")}
            </button>
          )}
          <button
            className="btn"
            disabled={busy || team.members.length === 0}
            onClick={() => setTidy((n) => n + 1)}
          >
            {t("teams.autoTidy")}
          </button>
          {/* One tri-state checkbox replaces the old All auto / All manual pair: it
              shows the current whole-team state (empty/half/full) AND toggles it.
              From all-manual or partial → all-auto; from all-auto → all-manual (the partial→all-auto
              direction is the browser "select all" convention). */}
          <button
            className="btn team-auto-all"
            role="checkbox"
            aria-checked={allAuto ? "true" : someAuto ? "mixed" : "false"}
            disabled={busy || edgeTotal === 0}
            onClick={() => void setAllAuto(!allAuto)}
          >
            <span
              className={`tri-box ${allAuto ? "tri-box--all" : someAuto ? "tri-box--some" : ""}`}
              aria-hidden="true"
            >
              {allAuto ? <IconCheck size={11} /> : someAuto ? <IconMinus size={11} /> : null}
            </span>
            {t("teams.autoRouteAll")}
            {someAuto && (
              <span className="team-auto-count">
                {t("teams.autoRoutePartial", { n: autoCount, total: edgeTotal })}
              </span>
            )}
          </button>
          <button className="btn" disabled={busy} onClick={() => setPrimePicking(true)}>
            <IconStar size={14} /> {t("teams.primeAction")}
          </button>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={14} /> {t("teams.addMember")}
          </button>
        </div>
      </header>

      {error && confirmRemove === null && <div className="alert alert-error">{error}</div>}
      {outcome && (
        <section className={`panel tmd-result${outcome.live ? " live" : ""}`}>
          <div className="panel-head">
            <h2 className="panel-title">{t("teams.routeResult")}</h2>
            <div className="spacer" />
            <button
              className="btn btn-ghost btn-icon"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => {
                setOutcome(null);
                setHl(null);
              }}
            >
              <IconX size={14} />
            </button>
          </div>
          <div className="tv-res-body">
            <div className="tv-res-env">
              <span className="tv-res-ic" aria-hidden="true">
                <IconEnvelope size={18} />
              </span>
              <div>
                <p className="tv-res-note">{outcome.envelope.note ?? outcome.envelope.id.slice(0, 8)}</p>
                <p className="tv-res-meta">
                  <code>{outcome.envelope.id.slice(0, 8)}</code>
                  {" · "}
                  {fromBefore}
                  <b>{outcome.from}</b>
                  {fromAfter}
                  {" · "}
                  {t("teams.resultDownstream", { n: outcome.delivered.length })}
                  {" · "}
                  <TimeAgo at={outcome.envelope.at} />
                </p>
              </div>
            </div>
            <ul className="tv-res-list">
              {outcome.delivered.map((d, k) => (
                <li
                  key={`ok-${d.teamId}-${d.workspaceId}`}
                  style={{ "--arr": `${outcome.live ? arriveAt(k, skin) : 0}ms` } as CSSProperties}
                  onPointerEnter={() => setHl(d.teamId === team.id ? d.workspaceId : null)}
                  onPointerLeave={() => setHl(null)}
                >
                  <i className="tv-res-dot" aria-hidden="true" />
                  <span className="chip route-chip--ok">{t("teams.routeOk")}</span>
                  <span className="tv-res-name">{d.name}</span>
                  <span className="tv-res-via">
                    {t("teams.viaTeam")} {d.teamName}
                  </span>
                </li>
              ))}
              {outcome.alreadyDelivered.map((name) => (
                <li key={`dup-${name}`}>
                  <i className="tv-res-dot" aria-hidden="true" />
                  <span className="chip">{t("teams.routeDupe")}</span>
                  <span className="tv-res-name">{name}</span>
                </li>
              ))}
              {outcome.failed.map((f) => (
                <li key={`fail-${f.root}`}>
                  <i className="tv-res-dot off" aria-hidden="true" />
                  <span className="chip route-chip--fail">{t("teams.routeFail")}</span>
                  <span className="tv-res-name">
                    {f.root} — {f.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

      <div className="tmd-sum">
        <span>{t("teams.cardMembers", { n: team.members.length })}</span>
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        <span>{t("teams.cardEdges", { n: team.edges.length })}</span>
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        {/* Not "0 pending" before the outboxes are read (invariant 10(a)). */}
        {outboxes === null ? (
          <span className="tm-pending tm-pending--skel" aria-label={t("common.loading")} />
        ) : (
          <span className={pendingTotal > 0 ? "ts-hot" : ""}>{t("teams.cardPending", { n: pendingTotal })}</span>
        )}
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        {history === null ? (
          <span className="tm-pending tm-pending--skel tm-skel-wide" aria-label={t("common.loading")} />
        ) : (
          <span>
            {lastOverall === null
              ? t("teams.summaryNever")
              : t("teams.summaryLast", { at: lastOverall })}
          </span>
        )}
        {missing.size > 0 && (
          <>
            <span className="chip team-missing-chip ts-missing">
              {t("teams.summaryMissing", { n: missing.size })}
            </span>
            <button className="btn btn-small ts-relink" disabled={busy} onClick={() => void relinkNow(null)}>
              {t("teams.relink")}
            </button>
          </>
        )}
      </div>
      {relinkReport !== null && (
        <RelinkLine
          report={relinkReport}
          busy={busy}
          onSearch={() => void relinkInFolder()}
          onClose={() => setRelinkReport(null)}
        />
      )}

      <div className="tmd-stage">
        <aside className="panel tmd-rail">
          <div className="tmr-head">
            {t("teams.membersHeading")}
            <span className="tmr-n">{team.members.length}</span>
          </div>
          <div className="tmr-list" ref={railRef}>
            {team.members.length === 0 && (
              <EmptyState
                className="tr-empty"
                title={t("teams.railEmpty")}
                hint={t("teams.railEmptyHint")}
              />
            )}
            {team.members.map((member) => {
              const dot = dotOf(member.workspaceId);
              const n = pendingCount?.get(member.workspaceId) ?? 0;
              return (
                <div
                  key={member.workspaceId}
                  data-member={member.workspaceId}
                  className={[
                    "tmr",
                    selectedId === member.workspaceId ? "on" : "",
                    freshMembers.has(member.workspaceId) ? "fresh" : "",
                  ]
                    .filter((c) => c !== "")
                    .join(" ")}
                >
                  <button
                    className="tmr-main"
                    title={member.root}
                    onClick={() => {
                      setSelectedId(member.workspaceId);
                      setFocus((cur) => ({
                        id: member.workspaceId,
                        nonce: (cur?.nonce ?? 0) + 1,
                      }));
                    }}
                  >
                    {/* This row carries only a name, so the status has no
                        equivalent visible text to lean on — unlike a canvas
                        node, where cn-meta already spells it out. Hence the
                        sr-only text (D64). */}
                    <span aria-hidden="true" className="tmr-dot" data-dot={dot} />
                    <span className="sr-only">
                      {t(
                        dot === "missing"
                          ? "teams.missing"
                          : dot === "pending"
                            ? "teams.pending"
                            : "teams.nodeIdle",
                      )}
                    </span>
                    <span className="tmr-name">{member.name}</span>
                    {n > 0 && <span className="tmr-n tmr-n--hot">{n}</span>}
                  </button>
                  {/* In-row removal: goes through the same confirmation
                      dialog as the one at the bottom of the inspector
                      (including the "this also removes N flows" warning) — it
                      never bypasses confirmation. Appears on hover or when
                      the row takes keyboard focus (:focus-within lets the
                      keyboard summon it), and its space is always reserved so
                      the name never shifts. */}
                  <button
                    className="btn btn-ghost btn-icon tmr-x danger-trigger"
                    disabled={busy}
                    title={t("teams.removeTitle")}
                    aria-label={t("teams.removeMemberOf", { name: member.name })}
                    onClick={() => {
                      setError(null);
                      setConfirmRemove(member);
                    }}
                  >
                    <IconX size={13} />
                  </button>
                </div>
              );
            })}
          </div>
          {/* The same action as the header's, in reach of the end of the
              list. It is a convenience, not a second main action, so it does
              not wear the same coat — two identical primaries on one screen
              read as two different things (r2 3-3). */}
          <div className="tmr-foot">
            <button className="btn btn-small btn-ghost" onClick={() => setAdding(true)}>
              <IconPlus size={13} /> {t("teams.addMember")}
            </button>
          </div>
        </aside>

        <div className={`team-canvas${selectedMember !== null ? " team-canvas--inspecting" : ""}`}>
          <Canvas
            team={team}
            skin={skin}
            missing={missing}
            pending={pendingCount}
            lastDelivery={lastDeliveryBy}
            busy={busy}
            flowError={flowError}
            onClearFlowError={() => setFlowError(null)}
            selectedId={selectedId}
            focus={focus}
            onSelect={setSelectedId}
            onAddEdge={addEdge}
            onRemoveEdge={removeEdge}
            onRemoveLine={removeLine}
            onPersistLayout={persistLayout}
            tidy={tidy}
            freshEdge={freshEdge}
            onFreshEdgeDone={() => setFreshEdge(null)}
            born={freshMembers}
            got={got}
            highlight={hl}
            apiRef={canvasApi}
          />

          {team.members.length === 0 && (
            <div className="canvas-empty">
              {/* No action: "Add to team" already sits in the header and at the
                  foot of the member rail right beside this card — three copies
                  of one button was the pre-existing state; step 1 names the
                  rail instead (D65 walkthrough feedback). */}
              <EmptyState
                className="canvas-empty-card"
                variant="guide"
                title={t("teams.guideTitle")}
                steps={[t("teams.guide1"), t("teams.guide2"), t("teams.guide3")]}
              />
            </div>
          )}

          {selectedMember !== null && (
            <aside className="canvas-inspector">
              <div className="ci-head">
                <div className="ci-title">
                  {/* Own element so it can truncate — see .ci-name in styles.css */}
                  <span className="ci-name">{selectedMember.name}</span>
                  {missing.has(selectedMember.workspaceId) && (
                    <span className="chip team-missing-chip">{t("teams.missing")}</span>
                  )}
                </div>
                <button
                  className="btn btn-ghost btn-icon"
                  title={t("common.close")}
                  aria-label={t("common.close")}
                  onClick={() => setSelectedId(null)}
                >
                  <IconX size={14} />
                </button>
              </div>
              <PathLabel className="ci-path" path={selectedMember.root} />

              {missing.has(selectedMember.workspaceId) && (
                <div className="tmi-miss">
                  <p>{t("teams.missingHint")}</p>
                  <div className="tmi-miss-actions">
                    <button className="btn btn-small" disabled={busy} onClick={() => void relinkNow(null)}>
                      {t("teams.relink")}
                    </button>
                    <button
                      className="btn btn-small"
                      disabled={busy}
                      onClick={() => void rebind(selectedMember)}
                    >
                      <IconFolder size={13} /> {t("teams.rebind")}
                    </button>
                  </div>
                </div>
              )}

              {/* The coordinator control used to live here, on the node panel
                  — which is exactly what made the prime read as a member
                  (D117). It is a team-level fact now, so it lives in the
                  header with the other team-level ones. */}

              <div className="ci-section">
                <div className="ci-section-title">
                  {t("teams.pending")}
                  {selectedBox !== null && selectedBox.rows.length > 0 && (
                    <span className="tmr-n tmr-n--hot">{selectedBox.rows.length}</span>
                  )}
                </div>
                {outboxes === null && (
                  <div aria-label={t("common.loading")}>
                    <span className="skel-bar" />
                    <span className="skel-bar skel-bar--short" />
                  </div>
                )}
                {selectedBox?.error != null && (
                  <p className="tmi-hint">
                    {/* ASCII parentheses, not fullwidth: they wrap a Latin
                        technical error string in both locales. */}
                    {t("teams.outboxUnreadable")} ({selectedBox.error})
                  </p>
                )}
                {outboxes !== null &&
                  (selectedBox?.rows ?? []).length === 0 &&
                  selectedBox?.error == null && (
                    <EmptyState title={t("teams.noPending")} hint={t("teams.noPendingHint")} />
                  )}
                {(selectedBox?.rows ?? []).map((row) => (
                  <div className={`tmi-row${row.supersededBy ? " superseded" : ""}`} key={row.id}>
                    <div className="tmi-rb">
                      <div className="tmi-rt">
                        {row.note ?? row.id.slice(0, 8)}
                        {/* The publisher corrected itself: a later envelope in
                            this same outbox replaces this one. Marked rather
                            than hidden — what to send stays the user's call. */}
                        {row.supersededBy && (
                          <span className="pill superseded">{t("teams.superseded")}</span>
                        )}
                      </div>
                      <div className="tmi-rd">
                        <TimeAgo at={row.publishedAt} />
                        {/* D176: the publisher named who it is for. */}
                        {row.addressedTo && row.addressedTo.length > 0 &&
                          ` · ${t("teams.addressedTo", { names: row.addressedTo.map((d) => d.name).join(t("teams.listSep")) })}`}
                        {row.supersededBy && ` · ${t("teams.supersededBy", { id: row.supersededBy.slice(0, 8) })}`}
                      </div>
                    </div>
                    {/* Named per row: N buttons all reading "Send" tell a
                        screen-reader user which action they are on and not
                        which envelope it acts on — the one thing the row's
                        visual position was carrying (2026-08-01 UI review). */}
                    <button
                      className={row.supersededBy ? "btn btn-small" : "btn btn-small btn-primary"}
                      disabled={busy}
                      aria-label={t("teams.routeOf", {
                        summary: (row.note ?? row.id).split("\n")[0].slice(0, 60),
                      })}
                      onClick={() => {
                        const candidates = candidatesFor(selectedMember.workspaceId);
                        // D176: an addressed envelope starts with only the
                        // projects it names ticked; the person can still change it.
                        const named = new Set((row.addressedTo ?? []).map((d) => d.workspaceId));
                        const preset = named.size > 0 ? candidates.filter((c) => named.has(c.workspaceId)) : candidates;
                        setRouting({
                          root: selectedMember.root,
                          workspaceId: selectedMember.workspaceId,
                          delivery: row,
                          candidates,
                          checked: new Set(preset.map(candidateKey)),
                        });
                      }}
                    >
                      {t("teams.route")}
                    </button>
                  </div>
                ))}
              </div>

              {/* Flows: dragging a connection on the canvas is mouse-only
                  (xyflow's Handle is a non-focusable div, so its built-in
                  connectOnClick can never be reached from the keyboard).
                  This section is the equivalent keyboard path, and it also
                  turns "who this member sits between" into a readable list
                  — on the graph you have to trace the lines by eye. */}
              {flowsOf !== null && (
                <div className="ci-section">
                  <div className="ci-section-title">{t("teams.flowsHeading")}</div>

                  {flowsOf.upstream.length === 0 && flowsOf.downstream.length === 0 && (
                    <EmptyState
                      title={t("teams.flowNone")}
                      hint={
                        flowsOf.targets.length === 0
                          ? t("teams.flowNoTarget")
                          : skin === "orbit"
                            ? t("teams.flowNoneHintOrbit")
                            : t("teams.flowNoneHint")
                      }
                    />
                  )}

                  {flowsOf.upstream.map((edge) => (
                    <div
                      className={`tmi-flow${flowFresh === `${edge.from}->${edge.to}` ? " fresh" : ""}`}
                      key={`up-${edge.from}`}
                    >
                      <div className="tmi-fl">
                        <b>{nameOf(edge.from)}</b>
                        <IconArrowRight size={13} aria-hidden="true" />
                        <span className="tmi-me">{t("teams.flowThisOne")}</span>
                      </div>
                      <button
                        className="btn btn-ghost btn-icon"
                        disabled={busy}
                        title={t("teams.removeEdge")}
                        aria-label={t("teams.removeEdgeOf", {
                          from: nameOf(edge.from),
                          to: selectedMember.name,
                        })}
                        onClick={() => removeEdge(edge.from, edge.to)}
                      >
                        <IconX size={13} />
                      </button>
                    </div>
                  ))}

                  {flowsOf.downstream.map((edge) => (
                    <div
                      className={`tmi-flow${flowFresh === `${edge.from}->${edge.to}` ? " fresh" : ""}`}
                      key={`down-${edge.to}`}
                    >
                      <div className="tmi-fl">
                        <span className="tmi-me">{t("teams.flowThisOne")}</span>
                        <IconArrowRight size={13} aria-hidden="true" />
                        <b>{nameOf(edge.to)}</b>
                      </div>
                      {/* Sending is the from-side's decision, so only these
                          downstream rows carry the auto toggle — on an
                          upstream row it would edit another node's policy. */}
                      <Switch
                        checked={edge.autoRoute}
                        disabled={busy}
                        onChange={(v) => setEdgeAuto(edge.from, edge.to, v)}
                        ariaLabel={t("teams.autoRouteOf", { to: nameOf(edge.to) })}
                      />
                      <button
                        className="btn btn-ghost btn-icon"
                        disabled={busy}
                        title={t("teams.removeEdge")}
                        aria-label={t("teams.removeEdgeOf", {
                          from: selectedMember.name,
                          to: nameOf(edge.to),
                        })}
                        onClick={() => removeEdge(edge.from, edge.to)}
                      >
                        <IconX size={13} />
                      </button>
                    </div>
                  ))}

                  {flowsOf.upstream.length + flowsOf.downstream.length > 0 && (
                    <p className="tmi-hint">{t("teams.twoWayHint")}</p>
                  )}
                  {flowsOf.downstream.length > 0 && (
                    <p className="tmi-hint">{t("teams.autoRouteHint")}</p>
                  )}

                  {flowsOf.targets.length > 0 && (
                    <div className="tmi-add">
                      <label className="field">
                        <span>{t("teams.addFlowLabel")}</span>
                        <select
                          value={edgeDraft}
                          disabled={busy}
                          onChange={(e) => setEdgeDraft(e.target.value)}
                        >
                          <option value="">{t("teams.addFlowPlaceholder")}</option>
                          {flowsOf.targets.map((m) => (
                            <option key={m.workspaceId} value={m.workspaceId}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        className="btn btn-small"
                        disabled={busy || edgeDraft === ""}
                        onClick={() => {
                          addEdge(selectedMember.workspaceId, edgeDraft);
                          setEdgeDraft("");
                        }}
                      >
                        <IconPlus size={13} /> {t("teams.addFlow")}
                      </button>
                    </div>
                  )}
                </div>
              )}

              <div className="ci-foot">
                <button
                  className="btn btn-ghost"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setConfirmRemove(selectedMember);
                  }}
                >
                  {t("teams.removeTitle")}
                </button>
              </div>
            </aside>
          )}
        </div>
      </div>

      {/* Below the canvas, not floating over it: as an overlay the bar covered
          whatever node sat at the bottom of the graph (reported during the
          D53 walkthrough). */}
      <div className={`panel tmd-dock${dockOpen ? " open" : ""}`}>
        <button
          className="tmd-dock-bar"
          aria-expanded={dockOpen}
          onClick={() => {
            const next = !dockOpen;
            setDockOpen(next);
            // C52: the rows float up as the dock opens, not on later re-reads.
            if (next && !motionOff()) {
              setDockIn(true);
              window.setTimeout(() => setDockIn(false), 900);
            }
          }}
        >
          <span>{t("teams.history")}</span>
          <span className="tmr-n">{historyTotal}</span>
          <span className="caret" aria-hidden="true">
            <IconCaretDown size={14} />
          </span>
        </button>
        {dockOpen && (
          <div className={`tmd-dock-body${dockIn ? " in" : ""}`}>
            {missing.size > 0 && <p className="tmi-hint">{t("teams.historyMissing")}</p>}
            {history !== null && history.length === 0 && (
              <EmptyState title={t("teams.noHistory")} hint={t("teams.noHistoryHint")} />
            )}
            {(history ?? []).length > 0 && (
              <ul>
                {(history ?? []).map((row, j) => (
                  <li className="arr" key={row.key} style={{ "--j": j } as CSSProperties}>
                    {/* Same clipping as the inbox rows, for the same reason: the
                        note is unbounded prose and used to set the row's height
                        (2026-08-01 UI review, P1 1-1 — this list has the defect
                        the review found next door). */}
                    <span className="arr-route">
                      {row.from} <IconArrowRight size={13} aria-hidden="true" /> {row.to}
                    </span>
                    <span className="arr-note">{row.note ?? ""}</span>
                    <TimeAgo className="arr-at" at={row.at} />
                  </li>
                ))}
              </ul>
            )}
            {historyTotal > HISTORY_CAP && (
              <p className="tmi-hint">{t("teams.historyCap", { n: HISTORY_CAP })}</p>
            )}
          </div>
        )}
      </div>

      {adding && (
        <Modal label={t("teams.addMemberTitle")} narrow onClose={() => setAdding(false)}>
          <div className="form">
            <h2 className="form-heading">{t("teams.addMemberTitle")}</h2>
            <label className="field">
              <span>{t("teams.pickWorkspace")}</span>
              <input
                autoFocus
                value={filter}
                placeholder={t("teams.filterPlaceholder")}
                onChange={(e) => setFilter(e.target.value)}
              />
            </label>
            <div className={`dlg-picks${filtered.length > 0 ? " dlg-picks--fade" : ""}`}>
              {/* "Nothing left to add" and "your search matched nothing" are
                  different states — the old copy blamed the registry for both
                  and never mentioned the box the user just typed in (D65). */}
              {filtered.length === 0 &&
                (joinable.length === 0 ? (
                  <EmptyState title={t("teams.noJoinable")} hint={t("teams.noJoinableHint")} />
                ) : (
                  <EmptyState
                    title={t("teams.noJoinableMatch")}
                    hint={t("teams.noJoinableMatchHint")}
                    action={{ label: t("teams.clearFilter"), onClick: () => setFilter("") }}
                  />
                ))}
              {filtered.map((row) => (
                <button
                  key={row.root}
                  className="dlg-pick"
                  disabled={busy}
                  onClick={() => {
                    setAdding(false);
                    setFilter("");
                    void run(() => api.teamAddMember(team.id, row.root));
                  }}
                >
                  <b>{row.name}</b>
                  <PathLabel className="dlg-pick-path" path={row.root} actions={false} />
                </button>
              ))}
            </div>
            <p className="dlg-hint">{t("teams.addMemberHint")}</p>
            <div className="form-actions">
              <button className="btn" onClick={() => setAdding(false)}>
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {primePicking && (
        <Modal
          label={t("teams.primeTitle")}
          narrow
          onClose={() => {
            setPrimePicking(false);
            setPrimeFilter("");
          }}
        >
          <div className="form">
            <h2 className="form-heading">{t("teams.primeTitle")}</h2>
            <p className="muted">{team.prime ? t("teams.primeOn") : t("teams.primeOff")}</p>

            {team.prime && (
              <div className="dlg-prime">
                <div>
                  <b>{team.prime.name}</b>
                  <PathLabel className="dlg-pick-path" path={team.prime.root} actions={false} />
                </div>
                {/* Clearing takes authority away and deletes nothing — the
                    reversible tier of D102, so no red and no confirmation. */}
                <button className="btn btn-small" disabled={busy} onClick={() => void setPrime(null)}>
                  {t("teams.primeClear")}
                </button>
              </div>
            )}

            <label className="field">
              <span>{team.prime ? t("teams.primeReplace") : t("teams.pickWorkspace")}</span>
              <input
                autoFocus
                value={primeFilter}
                placeholder={t("teams.filterPlaceholder")}
                onChange={(e) => setPrimeFilter(e.target.value)}
              />
            </label>
            <div className={`dlg-picks${primeFiltered.length > 0 ? " dlg-picks--fade" : ""}`}>
              {primeFiltered.length === 0 &&
                (joinable.length === 0 ? (
                  <EmptyState title={t("teams.noPrimeable")} hint={t("teams.noPrimeableHint")} />
                ) : (
                  <EmptyState
                    title={t("teams.noJoinableMatch")}
                    hint={t("teams.noJoinableMatchHint")}
                    action={{ label: t("teams.clearFilter"), onClick: () => setPrimeFilter("") }}
                  />
                ))}
              {primeFiltered.map((row) => (
                <button
                  key={row.root}
                  className="dlg-pick"
                  disabled={busy}
                  onClick={() => void setPrime(row.root)}
                >
                  <b>{row.name}</b>
                  <PathLabel className="dlg-pick-path" path={row.root} actions={false} />
                </button>
              ))}
            </div>
            <p className="dlg-hint">{t("teams.primeHint")}</p>
            <div className="form-actions">
              <button
                className="btn"
                onClick={() => {
                  setPrimePicking(false);
                  setPrimeFilter("");
                }}
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmRemove && (
        <ConfirmDanger
          heading={t("teams.removeTitle")}
          // The second half is conditional because the cost is: with edges the
          // flows go too, without them nothing else moves. Saying "and its
          // flows" to someone removing an unconnected member invents a loss and
          // teaches them the warning is boilerplate.
          body={
            <>
              <p className="muted">{t("teams.removeConfirm", { name: confirmRemove.name })}</p>
              <p className="muted">
                {edgesOf(confirmRemove.workspaceId) > 0
                  ? t("teams.removeEdgesWarn", { n: edgesOf(confirmRemove.workspaceId) })
                  : t("teams.removeNoEdges")}
              </p>
            </>
          }
          confirmLabel={t("teams.removeTitle")}
          busy={busy}
          error={error}
          onConfirm={() => {
            const id = confirmRemove.workspaceId;
            setConfirmRemove(null);
            if (selectedId === id) setSelectedId(null);
            void run(async () => {
              const list = await api.teamRemoveMember(team.id, id);
              // C217: the rail row fades where it stands before it goes.
              await fadeRowsOut([railRow(id)]);
              return list;
            });
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}

      {routing && (
        <Modal label={t("teams.route")} narrow onClose={() => setRouting(null)}>
          <div className="form" ref={sendFormRef}>
            <h2 className="form-heading">{t("teams.route")}</h2>
            {routing.delivery.note && (
              <p className="dlg-note" ref={noteRef}>
                {routing.delivery.note}
              </p>
            )}
            {routing.candidates.length === 0 ? (
              <EmptyState title={t("teams.noRoutes")} hint={t("teams.noRoutesHint")} />
            ) : (
              <>
                <p className="dlg-hint">{t("teams.routeHint")}</p>
                <div className="dlg-cands">
                  {routing.candidates.map((candidate) => {
                    const key = candidateKey(candidate);
                    return (
                      <label key={key} className="dlg-cand">
                        <span>
                          <b>{candidate.name}</b>
                          {candidate.autoRoute && <span className="chip">{t("teams.autoChip")}</span>}
                          <small>
                            {t("teams.viaTeam")} {candidate.teamName}
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={routing.checked.has(key)}
                          onChange={(e) => {
                            const next = new Set(routing.checked);
                            if (e.target.checked) next.add(key);
                            else next.delete(key);
                            setRouting({ ...routing, checked: next });
                          }}
                        />
                      </label>
                    );
                  })}
                </div>
              </>
            )}
            <div className="form-actions">
              <button className="btn" onClick={() => setRouting(null)}>
                {t("common.cancel")}
              </button>
              {routing.candidates.length > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={busy || routing.checked.size === 0}
                  onClick={() => void routeNow()}
                >
                  {t("teams.routeConfirm")}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function candidateKey(c: RouteCandidate): string {
  return `${c.teamId}:${c.workspaceId}`;
}

/**
 * The core answers with downstream names in three buckets, in the order the
 * destinations were given. Walk the picked candidates in that same order to
 * put each delivered name back with the member and the team it went through.
 */
function toShown(
  result: RouteOutcome,
  sending: { workspaceId: string; delivery: DeliverySummary },
  picked: RouteCandidate[],
  live: boolean,
): ShownOutcome {
  const reached = picked.filter((c) => !result.failed.some((f) => sameRoot(f.root, c.root)));
  const delivered: ShownOutcome["delivered"] = [];
  let di = 0;
  let ai = 0;
  for (const c of reached) {
    if (result.alreadyDelivered[ai] !== undefined && result.alreadyDelivered[ai] === c.name) {
      ai++;
      continue;
    }
    if (result.delivered[di] !== undefined) {
      delivered.push({ workspaceId: c.workspaceId, teamId: c.teamId, name: result.delivered[di], teamName: c.teamName });
      di++;
    } else {
      ai++;
    }
  }
  return {
    envelope: { id: sending.delivery.id, note: sending.delivery.note ?? null, at: new Date().toISOString() },
    from: sending.delivery.from.name,
    delivered,
    alreadyDelivered: result.alreadyDelivered,
    failed: result.failed,
    live,
  };
}

/** Split an absolute root into parent + folder for the probe IPC. */
function splitRoot(root: string): { parent: string; folder: string } | null {
  const norm = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return null;
  const parent = norm.slice(0, idx);
  const folder = norm.slice(idx + 1);
  if (parent === "" || folder === "") return null;
  return { parent, folder };
}
