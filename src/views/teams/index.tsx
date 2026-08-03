import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api } from "../../api";
import { normRoot, readBoxes } from "../../lib/exchange";
import { useGuardedMutation, useWorkspaceData } from "../../hooks";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import { IconPlus, IconRefresh, IconX } from "../../components/icons";
import type { Team, WorkspaceOverview } from "../../types";
import type { ToastSpec } from "../../lib/teamAutoRoute";
import TeamDetail from "./Detail";

interface Props {
  refreshKey: number;
  /** App-level toast sink — the detail view's auto-send sweep announces through it (D71). */
  pushToast: (spec: ToastSpec) => void;
}

/**
 * App-level teams home (D52 — promoted from a seg switcher to the app-wide
 * card-list → full-page-detail convention): every team as a card with member /
 * edge / pending counts; opening one lands in the full-page detail.
 */
export default function TeamsHome({ refreshKey, pushToast }: Props) {
  const { t } = useTranslation();
  /** Pending-envelope count per outbox root (normalized); missing key = unread yet. */
  const [pendingByRoot, setPendingByRoot] = useState<Map<string, number>>(new Map());
  /** Has the cross-workspace fan-out landed at least once? Never goes back to
   *  false — a later refresh must not re-skeleton counts already on screen. */
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  /**
   * Extra refresh signal for cross-workspace data (D62 walkthrough feedback).
   *
   * The counts on this page come from *other* workspaces' outboxes, and the
   * watcher only follows the one workspace that is open — so an upstream
   * publish produces no event here and the page would sit on the snapshot it
   * took when it mounted. Regaining window focus is the natural moment to
   * re-read (came back from doing something elsewhere); the toolbar button
   * covers the case this was found in — sitting on the page, watching.
   */
  const [crossRefresh, setCrossRefresh] = useState(0);

  // Two sources, one three-state (invariant 10): the graph and the registry
  // are read together because a card cannot be drawn without both. Both terms
  // of the key only ever increment, so their sum is a valid refresh key.
  const { data, setData, error, setError } = useWorkspaceData(
    async () => {
      const [teams, registry] = await Promise.all([api.teamsList(), api.recentWorkspaces()]);
      return { teams, registry };
    },
    refreshKey + crossRefresh,
  );
  const teams = data?.teams ?? null;
  const registry: WorkspaceOverview[] = data?.registry ?? [];
  // Every team mutation answers with the whole list; adopt it without waiting
  // for a re-read (unchanged behaviour — the registry half is untouched by it).
  const setTeams = useCallback(
    (list: Team[]) => setData((prev) => ({ teams: list, registry: prev?.registry ?? [] })),
    [setData],
  );
  // Shared by create and delete, as before — they live in mutually exclusive
  // modals. `teamCreate` is not idempotent, so the ref gate stops a same-tick
  // double click producing two identically named teams.
  const { busy, run } = useGuardedMutation(setError);

  useEffect(() => {
    const unlisten = getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) setCrossRefresh((k) => k + 1);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Card badges: one outbox read per unique member root (error-isolated —
  // an unreachable folder just counts 0 here; the detail view surfaces it).
  useEffect(() => {
    if (teams === null) return;
    const roots = new Map<string, string>();
    for (const team of teams) {
      for (const member of team.members) {
        roots.set(normRoot(member.root), member.root);
      }
    }
    let cancelled = false;
    // An unreachable folder counts 0 here (the detail view surfaces the
    // message) — that is `readBoxes`' degrade path, unchanged.
    void readBoxes([...roots.entries()], ([, root]) => root, "outbox").then((reads) => {
      if (cancelled) return;
      setPendingByRoot(new Map(reads.map((r) => [r.target[0], r.rows.length])));
      setPendingLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [teams, refreshKey, crossRefresh]);

  const pendingOf = useCallback(
    (team: Team) =>
      team.members.reduce((sum, m) => sum + (pendingByRoot.get(normRoot(m.root)) ?? 0), 0),
    [pendingByRoot],
  );

  const open = useMemo(
    () => teams?.find((team) => team.id === openId) ?? null,
    [teams, openId],
  );

  // Drop a stale selection (team deleted from another surface).
  useEffect(() => {
    if (openId !== null && teams !== null && open === null) setOpenId(null);
  }, [openId, teams, open]);

  function createTeam() {
    const name = teamName.trim();
    if (name === "") return;
    return run(async () => {
      setError(null);
      const before = new Set((teams ?? []).map((team) => team.id));
      const list = await api.teamCreate(name);
      setTeams(list);
      setTeamName("");
      setCreating(false);
      // Land straight in the fresh team (D51 create→editor precedent).
      const fresh = list.find((team) => !before.has(team.id));
      if (fresh) setOpenId(fresh.id);
    });
  }

  function removeTeam() {
    if (confirmDelete === null) return;
    return run(async () => {
      setError(null);
      setTeams(await api.teamDelete(confirmDelete.id));
      setConfirmDelete(null);
    });
  }

  if (teams === null) {
    return <div className="view muted">{t("common.loading")}</div>;
  }

  if (open !== null) {
    return (
      <TeamDetail
        team={open}
        teams={teams}
        registry={registry}
        // Both terms only ever increment, so the sum is monotonic — the detail
        // view's cross-workspace reads refresh on focus too.
        refreshKey={refreshKey + crossRefresh}
        onTeams={setTeams}
        onBack={() => setOpenId(null)}
        pushToast={pushToast}
      />
    );
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("teams.heading")}</h1>
          <p className="view-sub">{t("teams.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost btn-icon"
            title={t("teams.refresh")}
            aria-label={t("teams.refresh")}
            onClick={() => setCrossRefresh((k) => k + 1)}
          >
            <IconRefresh size={14} />
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> {t("teams.create")}
          </button>
        </div>
      </header>

      {error && confirmDelete === null && <div className="alert alert-error">{error}</div>}

      {teams.length === 0 ? (
        <section className="panel">
          {/* No action: the header already carries an identical "Create team"
              primary button in the same viewport, so step 1 points at it
              instead of offering a second copy (D65 walkthrough feedback). */}
          <EmptyState
            variant="guide"
            title={t("teams.empty")}
            hint={t("teams.emptyHint")}
            steps={[t("teams.step1"), t("teams.step2"), t("teams.step3")]}
          />
        </section>
      ) : (
        <ul className="ws-card-grid">
          {teams.map((team) => {
            const pending = pendingOf(team);
            return (
              <li key={team.id} className="ws-card">
                <button className="ws-card-open" onClick={() => setOpenId(team.id)}>
                  <span className="ws-card-name">
                    {team.name}
                    {/* The only genuinely slow read in the app: one outbox per
                        member root, across workspaces the watcher does not
                        follow. Until it lands, an absent chip would read as
                        "nothing pending" — so hold the slot instead (D65). */}
                    {!pendingLoaded && team.members.length > 0 ? (
                      <span
                        className="chip skel skel-chip"
                        aria-label={t("common.loading")}
                      />
                    ) : (
                      pending > 0 && (
                        <span className="chip team-pending-chip">
                          {t("teams.cardPending", { n: pending })}
                        </span>
                      )
                    )}
                  </span>
                  <span className="ws-card-meta">
                    {t("teams.cardMembers", { n: team.members.length })} ·{" "}
                    {t("teams.cardEdges", { n: team.edges.length })}
                  </span>
                </button>
                <button
                  className="btn btn-ghost btn-icon ws-card-remove danger-trigger"
                  title={t("teams.deleteTeam")}
                  aria-label={t("teams.deleteTeam")}
                  onClick={() => {
                    setError(null);
                    setConfirmDelete(team);
                  }}
                >
                  <IconX size={13} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {creating && (
        <Modal label={t("teams.create")} onClose={() => setCreating(false)}>
          <div className="form">
            <h2 className="form-heading">{t("teams.create")}</h2>
            <label className="field">
              <span>{t("teams.nameLabel")}</span>
              <input
                autoFocus
                value={teamName}
                placeholder={t("teams.namePlaceholder")}
                onChange={(e) => setTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void createTeam();
                }}
              />
            </label>
            <div className="form-actions">
              <button className="btn" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy || teamName.trim() === ""}
                onClick={() => void createTeam()}
              >
                {t("teams.create")}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {confirmDelete && (
        <ConfirmDanger
          heading={t("teams.deleteTeam")}
          // Two paragraphs, because the two halves are about different things:
          // what goes (the team and its edges) and what does not (the member
          // workspaces, which live on disk and outlive any team).
          body={
            <>
              <p className="muted">{t("teams.deleteConfirm", { name: confirmDelete.name })}</p>
              <p className="muted">{t("teams.deleteHint")}</p>
            </>
          }
          confirmLabel={t("common.delete")}
          busy={busy}
          error={error}
          onConfirm={() => void removeTeam()}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

