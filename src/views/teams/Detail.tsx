import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api } from "../../api";
import { readBoxes, sameRoot } from "../../lib/exchange";
import { useGuardedMutation } from "../../hooks";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import { Switch } from "../../components/controls";
import { autoRouteSweep, type ToastSpec } from "../../lib/teamAutoRoute";
import {
  IconArrowRight,
  IconCaretDown,
  IconCheck,
  IconFolder,
  IconMinus,
  IconPlus,
  IconX,
} from "../../components/icons";
import Canvas from "./Canvas";
import { autoPositions, canConnect } from "./layout";
import TimeAgo from "../../components/TimeAgo";
import { relativeTime } from "../../lib/time";
import PathLabel from "../../components/PathLabel";
import type {
  DeliverySummary,
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
  onBack: () => void;
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

/** History rows shown at once — honest cap, D47 precedent. */
const HISTORY_CAP = 50;

/**
 * Full-page team canvas (D53, 12 §2): the flow canvas is the page. Clicking a
 * member node opens the right inspector (path / liveness / pending envelopes
 * with Send / removal); delivery history lives in a collapsible bottom dock
 * (n8n's executions slot). Routing still happens here and only here — the
 * human at the Send button is the fan-out point (team module design §5).
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
  const [confirmRemove, setConfirmRemove] = useState<TeamMember | null>(null);
  /** Node selected on the canvas → right inspector. */
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Rail-driven "pan onto this node" request; the nonce re-fires on re-click. */
  const [focus, setFocus] = useState<{ id: string; nonce: number } | null>(null);

  // Edge/canvas failures render on the canvas, not in the page-level slot.
  const [flowError, setFlowError] = useState<string | null>(null);

  /** Inspector's "send to" picker — the keyboard-reachable way to draw an edge. */
  const [edgeDraft, setEdgeDraft] = useState("");

  // Bottom history dock.
  const [dockOpen, setDockOpen] = useState(false);

  // Send modal: the envelope being routed + per-candidate checkboxes.
  const [routing, setRouting] = useState<{
    root: string;
    delivery: DeliverySummary;
    candidates: RouteCandidate[];
    checked: Set<string>;
  } | null>(null);
  const [outcome, setOutcome] = useState<RouteOutcome | null>(null);

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
      // Auto-send sweep (D71), call site ②: this fan-out already paid for the
      // outbox reads, so hand them over. Converge with one re-read — never by
      // subscribing this effect to the state it writes.
      let moved = false;
      for (const box of result) {
        if (box.error !== null || box.rows.length === 0) continue;
        moved =
          (await autoRouteSweep(box.root, { pushToast, t }, { teams, outbox: box.rows })) || moved;
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

  const joinable = registry.filter(
    (row) => row.exists && !team.members.some((m) => sameRoot(m.root, row.root)),
  );
  const filtered = joinable.filter((row) => {
    const q = filter.trim().toLowerCase();
    if (q === "") return true;
    return row.name.toLowerCase().includes(q) || row.root.toLowerCase().includes(q);
  });

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
  const addEdge = useCallback(
    (from: string, to: string) => void runFlow(() => api.teamAddEdge(team.id, from, to)),
    [runFlow, team.id],
  );
  const removeEdge = useCallback(
    (from: string, to: string) => void runFlow(() => api.teamRemoveEdge(team.id, from, to)),
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
      void runFlow(() => api.teamSetLayout(team.id, positions)),
    [runFlow, team.id],
  );
  const pendingCount = useMemo(
    () => new Map((outboxes ?? []).map((box) => [box.workspaceId, box.rows.length])),
    [outboxes],
  );

  async function saveName() {
    const name = nameDraft.trim();
    setRenaming(false);
    if (name === "" || name === team.name) return;
    await run(() => api.teamRename(team.id, name));
  }

  /** Re-link a moved member: pick its new folder, core matches the stable id. */
  async function rebind(member: TeamMember) {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await run(() => api.teamRebindWorkspace(member.workspaceId, dir));
  }

  // The one place the ref gate is not a nicety: `teamRouteDelivery` is not
  // idempotent and it writes into *other* workspaces, so a same-tick double
  // click used to drop the same envelope into a teammate's inbox twice, with
  // nothing on either side able to take it back.
  function routeNow() {
    if (routing === null) return;
    const picked = routing.candidates.filter((c) => routing.checked.has(candidateKey(c)));
    if (picked.length === 0) return;
    return runMutation(async () => {
      setError(null);
      const result = await api.teamRouteDelivery(
        routing.root,
        routing.delivery.id,
        picked.map((c) => ({ root: c.root, teamId: c.teamId, teamName: c.teamName })),
      );
      setOutcome(result);
      setRouting(null);
      onTeams(await api.teamsList());
      setOutboxes(await loadOutboxes());
    });
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

  /** Node/rail status dot: missing wins, then pending, else idle. */
  function dotOf(workspaceId: string): string {
    if (missing.has(workspaceId)) return "missing";
    return (pendingCount.get(workspaceId) ?? 0) > 0 ? "pending" : "ok";
  }

  // Whole-team auto-route state — the header tri-state doubles as the at-a-glance
  // indicator (D71 walkthrough feedback: the per-edge switches were the only way
  // to see this, one node at a time). Three states, not two: all auto /
  // partial N/M / all manual.
  const edgeTotal = team.edges.length;
  const autoCount = team.edges.filter((e) => e.autoRoute).length;
  const allAuto = edgeTotal > 0 && autoCount === edgeTotal;
  const someAuto = autoCount > 0 && autoCount < edgeTotal;

  return (
    <div className="view view--canvas">
      <header className="view-header">
        <div className="vh-main">
          {renaming ? (
            <div className="field-row">
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
          <p className="view-sub">{t("teams.detailSub")}</p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={onBack}>
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
            onClick={() => void runFlow(() => api.teamSetLayout(team.id, autoPositions(team)))}
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
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            <IconPlus size={14} /> {t("teams.addMember")}
          </button>
        </div>
      </header>

      {error && confirmRemove === null && <div className="alert alert-error">{error}</div>}
      {outcome && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("teams.routeResult")}</h2>
            <div className="spacer" />
            <button
              className="btn btn-ghost btn-icon"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => setOutcome(null)}
            >
              <IconX size={14} />
            </button>
          </div>
          <ul className="route-result">
            {outcome.delivered.map((name) => (
              <li key={`ok-${name}`}>
                <span className="chip route-chip--ok">{t("teams.routeOk")}</span>
                <span>{name}</span>
              </li>
            ))}
            {outcome.alreadyDelivered.map((name) => (
              <li key={`dup-${name}`}>
                <span className="chip">{t("teams.routeDupe")}</span>
                <span>{name}</span>
              </li>
            ))}
            {outcome.failed.map((f) => (
              <li key={`fail-${f.root}`}>
                <span className="chip route-chip--fail">{t("teams.routeFail")}</span>
                <span>
                  {f.root} — {f.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="team-summary">
        <span>{t("teams.cardMembers", { n: team.members.length })}</span>
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        <span>{t("teams.cardEdges", { n: team.edges.length })}</span>
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        <span className={pendingTotal > 0 ? "ts-hot" : ""}>
          {t("teams.cardPending", { n: pendingTotal })}
        </span>
        <span className="ts-sep" aria-hidden="true">
          ·
        </span>
        <span>
          {lastOverall === null
            ? t("teams.summaryNever")
            : t("teams.summaryLast", { at: lastOverall })}
        </span>
        {missing.size > 0 && (
          <span className="chip team-missing-chip ts-missing">
            {t("teams.summaryMissing", { n: missing.size })}
          </span>
        )}
      </div>

      <div className="team-stage">
        <aside className="team-rail">
          <div className="tr-head">
            {t("teams.membersHeading")}
            <span className="canvas-dock-count">{team.members.length}</span>
          </div>
          <div className="tr-list">
            {team.members.length === 0 && (
              <EmptyState
                className="tr-empty"
                title={t("teams.railEmpty")}
                hint={t("teams.railEmptyHint")}
              />
            )}
            {team.members.map((member) => (
              <div
                key={member.workspaceId}
                className={`tr-row ${selectedId === member.workspaceId ? "tr-row--on" : ""}`}
              >
                <button
                  className="tr-main"
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
                  <span
                    aria-hidden="true"
                    className={`cn-dot cn-dot--${dotOf(member.workspaceId)}`}
                  />
                  <span className="sr-only">
                    {t(
                      dotOf(member.workspaceId) === "missing"
                        ? "teams.missing"
                        : dotOf(member.workspaceId) === "pending"
                          ? "teams.pending"
                          : "teams.nodeIdle",
                    )}
                  </span>
                  <span className="tr-name">{member.name}</span>
                  {(pendingCount.get(member.workspaceId) ?? 0) > 0 && (
                    <span className="canvas-dock-count">
                      {pendingCount.get(member.workspaceId)}
                    </span>
                  )}
                </button>
                {/* In-row removal: goes through the same confirmation
                    dialog as the one at the bottom of the inspector
                    (including the "this also removes N flows" warning) — it
                    never bypasses confirmation. Appears on hover or when
                    the row takes keyboard focus (:focus-within lets the
                    keyboard summon it), and its space is always reserved so
                    the name never shifts. */}
                <button
                  className="btn btn-ghost btn-icon tr-remove danger-trigger"
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
            ))}
          </div>
          {/* The same action as the header's, in reach of the end of the
              list. It is a convenience, not a second main action, so it does
              not wear the same coat — two identical primaries on one screen
              read as two different things (r2 3-3). */}
          <div className="tr-foot">
            <button className="btn btn-small btn-ghost" onClick={() => setAdding(true)}>
              <IconPlus size={13} /> {t("teams.addMember")}
            </button>
          </div>
        </aside>

        <div className="team-canvas">
          <Canvas
            team={team}
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
            onPersistLayout={persistLayout}
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
                  {selectedMember.name}
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
                <div>
                  <div className="team-member-hint">{t("teams.missingHint")}</div>
                  <button
                    className="btn team-rebind"
                    disabled={busy}
                    onClick={() => void rebind(selectedMember)}
                  >
                    <IconFolder size={13} /> {t("teams.rebind")}
                  </button>
                </div>
              )}

              <div className="ci-section">
                <div className="ci-section-title">
                  {t("teams.pending")}
                  {selectedBox !== null && selectedBox.rows.length > 0 && (
                    <span className="canvas-dock-count">{selectedBox.rows.length}</span>
                  )}
                </div>
                {selectedBox?.error != null && (
                  <p className="muted">
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
                  <div className="settings-row" key={row.id}>
                    <div className="sr-body">
                      <div className="sr-title">
                        {row.note ?? row.id.slice(0, 8)}
                        {/* The publisher corrected itself: a later envelope in
                            this same outbox replaces this one. Marked rather
                            than hidden — what to send stays the user's call. */}
                        {row.supersededBy && (
                          <span className="pill superseded">{t("teams.superseded")}</span>
                        )}
                      </div>
                      <div className="sr-desc">
                        <TimeAgo at={row.publishedAt} />
                        {row.supersededBy && ` · ${t("teams.supersededBy", { id: row.supersededBy.slice(0, 8) })}`}
                      </div>
                    </div>
                    {/* Named per row: N buttons all reading "Send" tell a
                        screen-reader user which action they are on and not
                        which envelope it acts on — the one thing the row's
                        visual position was carrying (2026-08-01 UI review). */}
                    <button
                      className={row.supersededBy ? "btn" : "btn btn-primary"}
                      disabled={busy}
                      aria-label={t("teams.routeOf", {
                        summary: (row.note ?? row.id).split("\n")[0].slice(0, 60),
                      })}
                      onClick={() => {
                        const candidates = candidatesFor(selectedMember.workspaceId);
                        setRouting({
                          root: selectedMember.root,
                          delivery: row,
                          candidates,
                          checked: new Set(candidates.map(candidateKey)),
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
                        flowsOf.targets.length > 0
                          ? t("teams.flowNoneHint")
                          : t("teams.flowNoTarget")
                      }
                    />
                  )}

                  {flowsOf.upstream.map((edge) => (
                    <div className="settings-row ci-flow-row" key={`up-${edge.from}`}>
                      <div className="sr-body">
                        <div className="sr-title ci-flow-line">
                          <span className="ci-flow-peer">{nameOf(edge.from)}</span>
                          <IconArrowRight size={13} aria-hidden="true" />
                          <span className="muted">{t("teams.flowThisOne")}</span>
                        </div>
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
                    <div className="settings-row ci-flow-row" key={`down-${edge.to}`}>
                      <div className="sr-body">
                        <div className="sr-title ci-flow-line">
                          <span className="muted">{t("teams.flowThisOne")}</span>
                          <IconArrowRight size={13} aria-hidden="true" />
                          <span className="ci-flow-peer">{nameOf(edge.to)}</span>
                        </div>
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

                  {flowsOf.downstream.length > 0 && (
                    <p className="section-hint">{t("teams.autoRouteHint")}</p>
                  )}

                  {flowsOf.targets.length > 0 && (
                    <div className="ci-add-flow">
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
                        className="btn"
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
      <div className={`canvas-dock ${dockOpen ? "canvas-dock--open" : ""}`}>
        <button className="canvas-dock-bar" onClick={() => setDockOpen((v) => !v)}>
          <span>{t("teams.history")}</span>
          <span className="canvas-dock-count">{historyTotal}</span>
          <span className={`canvas-dock-caret ${dockOpen ? "up" : ""}`}>
            <IconCaretDown size={14} />
          </span>
        </button>
        {dockOpen && (
          <div className="canvas-dock-body">
            {missing.size > 0 && <p className="section-hint">{t("teams.historyMissing")}</p>}
            {history !== null && history.length === 0 && (
              <EmptyState title={t("teams.noHistory")} hint={t("teams.noHistoryHint")} />
            )}
            {(history ?? []).map((row) => (
              <div className="settings-row mail-row" key={row.key}>
                <div className="sr-body">
                  {/* Same clipping as the inbox rows, for the same reason: the
                      note is unbounded prose and used to set the row's height
                      (2026-08-01 UI review, P1 1-1 — this list has the defect
                      the review found next door). */}
                  <div className="sr-title mail-line">
                    <span className="mail-from">
                      {row.from} <IconArrowRight size={13} /> {row.to}
                    </span>
                    {row.note && <span className="mail-note">{row.note}</span>}
                  </div>
                </div>
                <div className="mail-meta">
                  <TimeAgo at={row.at} />
                </div>
              </div>
            ))}
            {historyTotal > HISTORY_CAP && (
              <p className="section-hint">{t("teams.historyCap", { n: HISTORY_CAP })}</p>
            )}
          </div>
        )}
      </div>

      {adding && (
        <Modal label={t("teams.addMemberTitle")} onClose={() => setAdding(false)}>
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
            <div className="team-pick-list">
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
                  className="team-pick-row"
                  disabled={busy}
                  onClick={() => {
                    setAdding(false);
                    setFilter("");
                    void run(() => api.teamAddMember(team.id, row.root));
                  }}
                >
                  <span className="team-member-name">{row.name}</span>
                  <PathLabel className="team-member-path" path={row.root} copyable={false} />
                </button>
              ))}
            </div>
            <p className="section-hint">{t("teams.addMemberHint")}</p>
            <div className="form-actions">
              <button className="btn" onClick={() => setAdding(false)}>
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
            void run(() => api.teamRemoveMember(team.id, id));
          }}
          onCancel={() => setConfirmRemove(null)}
        />
      )}

      {routing && (
        <Modal label={t("teams.route")} onClose={() => setRouting(null)}>
          <div className="form">
            <h2 className="form-heading">{t("teams.route")}</h2>
            {routing.delivery.note && <p>{routing.delivery.note}</p>}
            {routing.candidates.length === 0 ? (
              <EmptyState title={t("teams.noRoutes")} hint={t("teams.noRoutesHint")} />
            ) : (
              <>
                <p className="section-hint">{t("teams.routeHint")}</p>
                <div>
                  {routing.candidates.map((candidate) => {
                    const key = candidateKey(candidate);
                    return (
                      <label key={key} className="settings-row" style={{ cursor: "pointer" }}>
                        <div className="sr-body">
                          <div className="sr-title">
                            {candidate.name}{" "}
                            {candidate.autoRoute && (
                              <span className="chip">{t("teams.autoChip")}</span>
                            )}
                          </div>
                          <div className="sr-desc">
                            {t("teams.viaTeam")} {candidate.teamName}
                          </div>
                        </div>
                        <input
                          type="checkbox"
                          style={{ accentColor: "var(--accent)" }}
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
                <div className="form-actions">
                  <button className="btn" onClick={() => setRouting(null)}>
                    {t("common.cancel")}
                  </button>
                  <button
                    className="btn btn-primary"
                    disabled={busy || routing.checked.size === 0}
                    onClick={() => void routeNow()}
                  >
                    {t("teams.routeConfirm")}
                  </button>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function candidateKey(c: RouteCandidate): string {
  return `${c.teamId}:${c.workspaceId}`;
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
