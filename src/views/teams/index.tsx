import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { api, errorMessage } from "../../api";
import { normRoot, readBoxes, sameRoot } from "../../lib/exchange";
import { useFlash, useGuardedMutation, useWorkspaceData } from "../../hooks";
import ConfirmDanger from "../../components/ConfirmDanger";
import EmptyState from "../../components/EmptyState";
import FlashBar from "../../components/FlashBar";
import Modal from "../../components/Modal";
import { IconPlus, IconRefresh, IconX } from "../../components/icons";
import type { ImportPreview, Team, WorkspaceOverview } from "../../types";
import { ExportDialog, ImportDialog, pickTeamFile } from "./TeamTransfer";
import type { ToastSpec } from "../../lib/teamAutoRoute";
import { motionOff, type Point } from "../../lib/fx";
import { afterPaint, fadeRowsOut, rowTops, slideRows, EASE_OUT } from "../../lib/listMotion";
import { growTo } from "../../lib/transitions";
import TeamDetail from "./Detail";
import TeamSky from "./TeamSky";
import TeamOrbit from "./TeamOrbit";
import { BACK_FLY_MS, OPEN_OUT_MS, flyStars, orbitFlight, parkStars, starCentres, takeStars, type StarState } from "./motion";
import { teamSkin } from "../../lib/prefs";

interface Props {
  refreshKey: number;
  /** App-level toast sink — the detail view's auto-send sweep announces through it (D71). */
  pushToast: (spec: ToastSpec) => void;
}

/** Member names shown on a card before the rest fold into "+N more" (invariant 16). */
const CARD_NAMES = 6;

/**
 * App-level teams home (D52 — promoted from a seg switcher to the app-wide
 * card-list → full-page-detail convention): every team as a card with its
 * constellation (D153 star map, spec 50 §1), member / edge / pending counts and
 * member names; opening one lands in the full-page detail, the card's stars
 * flying to their places on the canvas (C56).
 *
 * With the orbit style (D157) the card's picture is a small orbit instead
 * (TeamOrbit, C61/C134) and its cube flies along with the planets (C62).
 */
export default function TeamsHome({ refreshKey, pushToast }: Props) {
  const { t } = useTranslation();
  /** Star map or orbit (D157): read once — Settings is another page, so it cannot change under this one. */
  const [skin] = useState(teamSkin);
  /** Pending-envelope count per outbox root (normalized); missing key = unread yet. */
  const [pendingByRoot, setPendingByRoot] = useState<Map<string, number>>(new Map());
  /** Has the cross-workspace fan-out landed at least once? Never goes back to
   *  false — a later refresh must not re-skeleton counts already on screen. */
  const [pendingLoaded, setPendingLoaded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Team | null>(null);
  /** Carrying teams to another machine (D173 ②). */
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState<{ file: string; preview: ImportPreview } | null>(null);
  const { flash, showFlash } = useFlash(6000);
  /** C55: the cards and their stars come in once, when the page is entered. */
  const [entering, setEntering] = useState(true);
  /** C56 in progress: which card is opening (the rest sink), or the team flown back to. */
  const [leaving, setLeaving] = useState<string | null>(null);
  const [landing, setLanding] = useState<{ id: string; phase: "landing" | "landed" } | null>(null);
  const gridRef = useRef<HTMLUListElement>(null);
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
  const registry: WorkspaceOverview[] = useMemo(() => data?.registry ?? [], [data]);
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

  useEffect(() => {
    const id = window.setTimeout(() => setEntering(false), 1600);
    return () => window.clearTimeout(id);
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

  /**
   * Is a member's folder gone? The list only asks the registry — a positive
   * "no longer exists" — and does not probe: a member the registry has never
   * seen is not accused here (the detail view probes, as before).
   */
  const goneOf = useCallback(
    (root: string) => registry.some((r) => sameRoot(r.root, root) && !r.exists),
    [registry],
  );

  /** A member's star: amber only once the outbox read has landed. */
  const stateOf = useCallback(
    (team: Team) =>
      (id: string): StarState => {
        const m = team.members.find((x) => x.workspaceId === id);
        if (m === undefined) return "ok";
        if (goneOf(m.root)) return "missing";
        if (!pendingLoaded) return "ok";
        return (pendingByRoot.get(normRoot(m.root)) ?? 0) > 0 ? "pending" : "ok";
      },
    [goneOf, pendingLoaded, pendingByRoot],
  );

  const open = useMemo(
    () => teams?.find((team) => team.id === openId) ?? null,
    [teams, openId],
  );

  // Drop a stale selection (team deleted from another surface).
  useEffect(() => {
    if (openId !== null && teams !== null && open === null) setOpenId(null);
  }, [openId, teams, open]);

  const cardOf = (id: string) =>
    gridRef.current?.querySelector<HTMLElement>(`[data-team="${CSS.escape(id)}"]`) ?? null;

  /**
   * C56: the other cards sink, this card's words fade, and its stars are
   * measured and handed to the canvas, which flies them in. A team with no
   * members has no stars to fly — the card grows into the page instead (C49),
   * which is also what happens when the card is scrolled out of sight.
   */
  function openTeam(team: Team) {
    if (leaving !== null) return;
    const card = cardOf(team.id);
    if (motionOff() || card === null) {
      setOpenId(team.id);
      return;
    }
    const r = card.getBoundingClientRect();
    const seen = r.bottom > 0 && r.top < window.innerHeight;
    const from = starCentres(card);
    if (team.members.length === 0 || !seen || Object.keys(from).length === 0) {
      void growTo(
        { from: card, to: () => document.querySelector("main.content .view"), look: "card", lift: 0.03 },
        () => setOpenId(team.id),
      );
      return;
    }
    setLeaving(team.id);
    window.setTimeout(() => {
      parkStars(team.id, "open", from);
      setLeaving(null);
      setOpenId(team.id);
    }, OPEN_OUT_MS);
  }

  /** Back from the detail: stars fly home to the card (C56 / C62), or the page folds into it (C49). */
  function backFrom(team: Team, stars: Record<string, Point> | null, scale = 1) {
    if (stars === null || motionOff()) {
      if (motionOff() || team.members.length > 0) {
        setOpenId(null);
        return;
      }
      void growTo({ from: null, back: true, look: "card", to: () => cardOf(team.id) }, () => setOpenId(null));
      return;
    }
    parkStars(team.id, "back", stars, scale);
    setLanding({ id: team.id, phase: "landing" });
    setOpenId(null);
  }

  // The list is back on screen: its card's stars are hidden until the canvas's
  // stars land on them.
  useLayoutEffect(() => {
    if (landing === null || landing.phase !== "landing" || openId !== null) return;
    const team = teams?.find((x) => x.id === landing.id);
    const parked = takeStars(landing.id, "back");
    const card = cardOf(landing.id);
    if (team === undefined || parked === null || card === null) {
      setLanding(null);
      return;
    }
    const to = starCentres(card);
    const ids = team.members.map((m) => m.workspaceId);
    const flight =
      skin === "orbit"
        ? orbitFlight(ids, parked.scale, true, stateOf(team))
        : { ids, state: stateOf(team), edges: team.edges };
    void flyStars(flight.ids, parked.from, to, { dur: BACK_FLY_MS, back: true, ...flight }).then(() => {
      setLanding({ id: team.id, phase: "landed" });
      window.setTimeout(() => setLanding((l) => (l?.id === team.id && l.phase === "landed" ? null : l)), 900);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landing, openId]);

  function createTeam() {
    const name = teamName.trim();
    if (name === "") return;
    return run(async () => {
      setError(null);
      const before = new Set((teams ?? []).map((team) => team.id));
      const list = await api.teamCreate(name);
      // The dialog does not sink: the new card grows into its page (C49).
      for (const el of document.querySelectorAll<HTMLElement>(".modal-backdrop")) el.dataset.exit = "none";
      setTeams(list);
      setTeamName("");
      setCreating(false);
      // Land straight in the fresh team (D51 create→editor precedent).
      const fresh = list.find((team) => !before.has(team.id));
      if (fresh === undefined) return;
      await afterPaint();
      void growTo(
        { from: cardOf(fresh.id), to: () => document.querySelector("main.content .view"), look: "card", lift: 0.03 },
        () => setOpenId(fresh.id),
      );
    });
  }

  function removeTeam() {
    if (confirmDelete === null) return;
    const gone = confirmDelete;
    return run(async () => {
      setError(null);
      const list = await api.teamDelete(gone.id);
      setConfirmDelete(null);
      // C217: the card fades where it stands, then the rest close the gap.
      const before = rowTops(gridRef.current);
      await fadeRowsOut([cardOf(gone.id)]);
      setTeams(list);
      await afterPaint();
      slideRows(gridRef.current, before, { duration: 360, easing: EASE_OUT });
    });
  }

  /**
   * Pick a team file and read what importing it would do. A file that is not
   * a team file is refused here, on the page, before any dialog opens.
   */
  async function startImport() {
    setError(null);
    let file: string | null;
    try {
      file = await pickTeamFile(t("teams.fileKind"));
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (file === null) return;
    const picked = file;
    await run(async () => {
      setImporting({ file: picked, preview: await api.teamImportPreview(picked) });
    });
  }

  if (teams === null) {
    // Local JSON, read in a blink: blank, no skeleton (invariant 10(c)).
    return <div className="view tms" />;
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
        onBack={(stars, scale) => backFrom(open, stars, scale)}
        pushToast={pushToast}
      />
    );
  }

  return (
    <div
      className={[
        "view tms",
        entering && landing === null ? "enter" : "",
        leaving !== null ? "tv-leaving" : "",
        landing !== null ? "tv-back" : "",
      ]
        .filter((c) => c !== "")
        .join(" ")}
    >
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("teams.heading")}</h1>
          <p className="view-sub">{t("teams.subtitle")}</p>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost btn-icon tm-refresh"
            title={t("teams.refresh")}
            aria-label={t("teams.refresh")}
            onClick={() => setCrossRefresh((k) => k + 1)}
          >
            <IconRefresh size={14} />
          </button>
          {/* D173 ②: the graph lives on this machine only; these carry it. */}
          <button className="btn" disabled={busy || teams.length === 0} onClick={() => setExporting(true)}>
            {t("teams.export")}
          </button>
          <button className="btn" disabled={busy} onClick={() => void startImport()}>
            {t("teams.import")}
          </button>
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> {t("teams.create")}
          </button>
        </div>
      </header>

      <FlashBar message={flash} />
      {error && confirmDelete === null && !creating && <div className="alert alert-error">{error}</div>}

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
        <ul className="tm-grid" ref={gridRef}>
          {teams.map((team, j) => {
            const pending = pendingOf(team);
            const names = team.members.slice(0, CARD_NAMES);
            const more = team.members.length - names.length;
            const land = landing?.id === team.id ? landing.phase : null;
            return (
              <li
                key={team.id}
                data-team={team.id}
                data-row={team.id}
                className={[
                  "panel tm-card",
                  leaving === team.id ? "tv-picked" : "",
                  land === "landing" ? "tv-landing" : "",
                  land === "landed" ? "tv-landed" : "",
                ]
                  .filter((c) => c !== "")
                  .join(" ")}
                style={{ "--j": j } as CSSProperties}
              >
                <button className="tm-card-open" onClick={() => openTeam(team)}>
                  {skin === "orbit" ? (
                    <TeamOrbit team={team} state={stateOf(team)} j={j} />
                  ) : (
                    <TeamSky team={team} state={stateOf(team)} />
                  )}
                  <span className="tm-card-name">
                    <b>{team.name}</b>
                    {/* The only genuinely slow read in the app: one outbox per
                        member root, across workspaces the watcher does not
                        follow. Until it lands, an absent chip would read as
                        "nothing pending" — so hold the slot instead (D65). */}
                    {!pendingLoaded && team.members.length > 0 ? (
                      <span className="tm-pending tm-pending--skel" aria-label={t("common.loading")} />
                    ) : (
                      pending > 0 && (
                        <span className="tm-pending">
                          <i className="mk-y" aria-hidden="true" />
                          {t("teams.cardPending", { n: pending })}
                        </span>
                      )
                    )}
                  </span>
                  <span className="tm-card-meta">
                    {t("teams.cardMembers", { n: team.members.length })} ·{" "}
                    {t("teams.cardEdges", { n: team.edges.length })}
                  </span>
                  {team.members.length > 0 && (
                    <span className="tm-card-ws">
                      {names.map((m) => {
                        const gone = goneOf(m.root);
                        return (
                          <span key={m.workspaceId} className={gone ? "gone" : undefined}>
                            {m.name}
                            {gone && <span className="sr-only"> ({t("teams.missing")})</span>}
                          </span>
                        );
                      })}
                      {more > 0 && <span className="tm-card-more">{t("teams.cardMore", { n: more })}</span>}
                    </span>
                  )}
                </button>
                <button
                  className="btn btn-ghost btn-icon tm-card-x danger-trigger"
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
        <Modal label={t("teams.create")} narrow onClose={() => setCreating(false)}>
          <div className="form">
            <h2 className="form-heading">{t("teams.create")}</h2>
            {/* The dialog covers the page header, so a failure has to be said in here. */}
            {error && <div className="alert alert-error">{error}</div>}
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

      {exporting && (
        <ExportDialog
          teams={teams}
          onClose={() => setExporting(false)}
          onDone={(message) => {
            setExporting(false);
            showFlash(message);
          }}
        />
      )}

      {importing && (
        <ImportDialog
          file={importing.file}
          preview={importing.preview}
          onClose={() => setImporting(null)}
          onTeams={setTeams}
        />
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
