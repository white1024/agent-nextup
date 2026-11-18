import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../../api";
import { growTo } from "../../lib/transitions";
import { centreOf as centre, fx, motionOff, tokenRgb, offerLight } from "../../lib/fx";
import { normRoot } from "../../lib/exchange";
import { baseName } from "../../lib/format";
import ConfirmDanger from "../../components/ConfirmDanger";
import ErrorBar from "../../components/ErrorBar";
import Modal from "../../components/Modal";
import Scramble from "../../components/Scramble";
import {
  IconClipboardCheck,
  IconDownload,
  IconFolder,
  IconPlus,
  type IconProps,
} from "../../components/icons";
import type {
  ProjectActivity,
  SystemStatus,
  TemplateSummary,
  TerminalSessionMeta,
  WorkspaceOverview,
} from "../../types";
import EmptyState from "../../components/EmptyState";
import { CAT_ALL, categoryOf } from "../../lib/categories";
import InitWizard from "./InitWizard";
import AdoptWizard from "./AdoptWizard";
import ImportForm from "./ImportForm";
import PathLabel from "../../components/PathLabel";
import ProjectCard, { type CardData } from "./ProjectCard";
import HubOrbit, { type HubHandle, type OrbitSession } from "../../components/HubOrbit";
import LiveFeed, { type FeedItem } from "./LiveFeed";
import Welcome from "./Welcome";
import { useProjectsActivity } from "../../hooks/useProjectsActivity";
import { fadeCards, riseIn, settleCards, spotsOf } from "./motion";
import {
  activityByRoot,
  callsToday,
  feedRows,
  keyedCalls,
  latestAt,
  sessionFor,
  sessionLabel,
  shortName,
  waitKey,
  waitingKeys,
  waitingTotal,
  type FeedRow,
} from "./overviewModel";

interface Props {
  /** Registry catalog rows (App-owned, shared with the sidebar categories).
   *  `null` until the first read resolves — distinct from `[]`, see below. */
  overview: WorkspaceOverview[] | null;
  onOverviewChange: (rows: WorkspaceOverview[]) => void;
  templates: TemplateSummary[];
  /** Active category from the sidebar (CAT_ALL / built-in id / custom / none). */
  category: string;
  /** Back to All — the category rail lives in the sidebar, so a category
   *  that matched nothing has no way out from inside this view (D65). */
  onClearCategory: () => void;
  /** Workspace opened or created — App swaps status and lands on the dashboard. */
  onLoaded: (status: SystemStatus) => void;
  /** Running terminal sessions (D50): the hub's orbit, the cards' running mark. */
  sessions: TerminalSessionMeta[];
}

type ModalKind = "wizard" | "adopt" | "import" | null;
type EntryKind = Exclude<ModalKind, null> | "open";

/** How long the page-entry choreography owns the cards (spec 20 §1, entry). */
const ENTER_MS = 1700;
/** C7 timing: chip → orb, then orb → card, landing at 1020 ms. */
const LAND_MS = 1020;
const LAND_YOU_MS = 860;
const WAVE_KEEP_MS = 13000;

/**
 * The app's home (D46, spec 20 §1–§3): every registered project as a card,
 * filtered by the sidebar's template category, with the hub of running
 * sessions above and the live stream of agent calls beside. With an empty
 * catalog the view is the first-run welcome (§5).
 */
export default function ProjectsHome({
  overview,
  onOverviewChange,
  templates,
  category,
  onClearCategory,
  onLoaded,
  sessions,
}: Props) {
  const { t } = useTranslation();
  const [modal, setModal] = useState<ModalKind>(null);
  // Pending "remove from list" target (D46: the registry is the permanent
  // catalog — a stray hover-× would silently lose the pointer, so removal
  // asks first). Files are never touched either way.
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const gridRef = useRef<HTMLUListElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const hubRef = useRef<HubHandle>(null);
  const [enter, setEnter] = useState(true);
  useEffect(() => {
    const id = window.setTimeout(() => setEnter(false), ENTER_MS);
    return () => window.clearTimeout(id);
  }, []);

  const builtInIds = useMemo(
    () => new Set(templates.filter((tpl) => tpl.source === "built_in").map((tpl) => tpl.id)),
    [templates],
  );
  const rows = overview ?? [];

  // C230: the grid follows the sidebar's category through its own state, so
  // the cards that leave can fade before React drops them.
  const [shownCat, setShownCat] = useState(category);
  const inCat = (ws: WorkspaceOverview, cat: string) =>
    cat === CAT_ALL || categoryOf(ws, builtInIds) === cat;
  const shown = rows.filter((ws) => inCat(ws, shownCat));
  useEffect(() => {
    if (category === shownCat) return;
    const grid = gridRef.current;
    const keep = new Set(rows.filter((ws) => inCat(ws, category)).map((ws) => normRoot(ws.root)));
    const leaving = [...(grid?.querySelectorAll<HTMLElement>(":scope > [data-row]") ?? [])].filter(
      (el) => !keep.has(normRoot(el.dataset.row ?? "")),
    );
    let cancelled = false;
    void fadeCards(leaving).then(() => {
      if (cancelled) return;
      const before = spotsOf(gridRef.current);
      flushSync(() => setShownCat(category));
      settleCards(gridRef.current, before);
      if (keep.size === 0) riseIn(emptyRef.current);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  // ── Cross-project activity (D155) ────────────────────────────────────────
  //
  // `activity` is what was read; `landedActivity` is what the page shows. New
  // calls swap the second one in only when their light lands (C7 / C30), so
  // the stream, the counts and the waiting marks change *as* the beam arrives
  // rather than a second before it.
  const activity = useProjectsActivity(true);
  const [landedActivity, setLandedActivity] = useState<ProjectActivity[] | null>(null);
  const [landed, setLanded] = useState<Record<string, { n: number; you: boolean }>>({});
  const [waves, setWaves] = useState<Record<string, number[]>>({});
  const seen = useRef<Set<string> | null>(null);
  const latest = useRef({ sessions, rows });
  latest.current = { sessions, rows };

  useEffect(() => {
    if (activity === null) return;
    const calls = keyedCalls(activity);
    if (seen.current === null) {
      // First read: the baseline, absorbed without light. Calls from the last
      // few seconds still seed the waveforms, so a busy project does not open
      // flat.
      seen.current = new Set(calls.map((c) => c.key));
      const now = Date.now();
      const seeded: Record<string, number[]> = {};
      for (const c of calls) {
        const at = Date.parse(c.at);
        if (now - at < WAVE_KEEP_MS) (seeded[normRoot(c.root)] ??= []).push(at);
      }
      setWaves(seeded);
      setLandedActivity(activity);
      return;
    }
    const fresh = calls.filter((c) => !seen.current!.has(c.key));
    for (const c of calls) seen.current.add(c.key);
    if (fresh.length === 0) {
      setLandedActivity(activity);
      return;
    }
    // A burst (the app was hidden, an agent ran a script) lights only its
    // newest few; the rest land with them.
    const lit = fresh.slice(-3);
    let last = 0;
    lit.forEach((call, i) => {
      last = Math.max(last, i * 350 + flyCall(call, i * 350));
    });
    const id = window.setTimeout(() => {
      setLandedActivity(activity);
      // The cards' counts come from the registry overview, which knows nothing
      // of other projects' edits — re-read it as the light lands (C9 / C10).
      void api.recentWorkspaces().then(onOverviewChange).catch(() => undefined);
    }, last);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity]);

  /** Fires the light for one new call; returns when it lands (ms from now). */
  function flyCall(call: FeedRow, delay: number): number {
    const you = call.outcome === "denied";
    const key = normRoot(call.root);
    const landAt = motionOff() ? 200 : you ? LAND_YOU_MS : LAND_MS;
    window.setTimeout(() => {
      const hub = hubRef.current;
      const session = sessionFor(latest.current.sessions, call.root, call.actor);
      const chip = session ? (hub?.chip(String(session.id)) ?? null) : null;
      const orb = hub?.orb() ?? null;
      const card = gridRef.current?.querySelector<HTMLElement>(
        `:scope > [data-row="${CSS.escape(cardRootOf(call.root))}"]`,
      );
      const rgb = you ? tokenRgb("--orange") : undefined;
      if (chip && session && hub) {
        hub.flash(String(session.id), you);
        fx.beam(centre(chip), centre(orb), { dur: you ? 400 : 460, bend: -0.22, width: you ? 2.4 : 2.2, rgb });
      }
      const second = chip ? (you ? 340 : 400) : 0;
      window.setTimeout(() => {
        hub?.pulse(you);
        // C30 splits here: the notification's half of the light leaves the
        // core now (the toast stack draws it, F15).
        const core = centre(orb);
        if (you && core !== null) offerLight("toast-you", core);
        if (card) {
          const r = card.getBoundingClientRect();
          fx.beam(centre(orb), { x: r.left + r.width / 2, y: r.top + 4 }, {
            dur: you ? 520 : 640,
            bend: you ? 0.2 : 0.16,
            width: 3,
            rgb,
          });
        }
      }, second);
      window.setTimeout(() => {
        setLanded((m) => ({ ...m, [key]: { n: (m[key]?.n ?? 0) + 1, you } }));
        const now = Date.now();
        setWaves((w) => ({
          ...w,
          [key]: [...(w[key] ?? []).filter((at) => now - at < WAVE_KEEP_MS), now],
        }));
      }, landAt);
    }, delay);
    return landAt;
  }

  /** The grid's `data-row` for a root, spelled the way the registry spells it. */
  function cardRootOf(root: string): string {
    const k = normRoot(root);
    return latest.current.rows.find((w) => normRoot(w.root) === k)?.root ?? root;
  }

  // ── Derived for render ──────────────────────────────────────────────────

  const anon = t("term.identityAnon");
  const nameOf = (root: string) => {
    const k = normRoot(root);
    return rows.find((w) => normRoot(w.root) === k)?.name ?? baseName(root);
  };
  const byRoot = activityByRoot(landedActivity);
  const waitSet = waitingKeys(landedActivity);
  const runningByRoot = new Set(sessions.map((s) => normRoot(s.root)));

  const orbit: OrbitSession[] = sessions.map((s) => ({
    id: String(s.id),
    label: sessionLabel(s, anon),
    project: shortName(nameOf(s.root)),
    waiting: waitSet.has(waitKey(s.root, s.identity)),
  }));

  const feed: FeedItem[] | null =
    landedActivity === null
      ? null
      : feedRows(keyedCalls(landedActivity)).map((r) => {
          const s = sessionFor(sessions, r.root, r.actor);
          return {
            ...r,
            who: s ? sessionLabel(s, anon) : (r.actor ?? anon),
            project: shortName(nameOf(r.root)),
          };
        });

  const waitingN = waitingTotal(rows, landedActivity);
  const today = callsToday(landedActivity);

  function cardData(ws: WorkspaceOverview): CardData {
    const act = byRoot.get(normRoot(ws.root));
    const lastCall = act?.calls[act.calls.length - 1]?.at;
    return {
      root: ws.root,
      name: ws.name,
      domain: ws.domain,
      templateName: ws.templateName,
      exists: ws.exists,
      taskCounts: ws.taskCounts,
      phaseIndex: ws.currentPhaseIndex,
      phaseCount: ws.phaseCount,
      phaseTitle: ws.currentPhaseTitle ?? ws.currentPhase,
      workflowCompleted: ws.workflowCompleted,
      at: latestAt(ws.lastOpened, lastCall),
    };
  }

  function waitingLabels(ws: WorkspaceOverview): string[] {
    const act = byRoot.get(normRoot(ws.root));
    return (act?.waiting ?? []).map((w) => {
      const s = sessionFor(sessions, ws.root, w.actor);
      return `${s ? sessionLabel(s, anon) : (w.actor ?? anon)} ${t("welcome.waitAuth")}`;
    });
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  async function openExisting() {
    setError(null);
    try {
      const dir = await open({ directory: true });
      if (typeof dir !== "string") return;
      onLoaded(await api.openWorkspace(dir));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function openProject(root: string, card: Element | null) {
    setError(null);
    try {
      const status = await api.openWorkspace(root);
      // C13 (D153): the card opens into the project's dashboard.
      void growTo(
        {
          from: card,
          to: () => document.querySelector("main.content .view"),
          look: "card",
          lift: 0.03,
        },
        () => onLoaded(status),
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removeProject() {
    if (confirmRemove === null) return;
    const target = confirmRemove;
    setError(null);
    try {
      const next = await api.removeRecentWorkspace(target.root);
      setConfirmRemove(null);
      // C217: the card fades where it stands, then the rest close the gap.
      const card = gridRef.current?.querySelector<HTMLElement>(
        `:scope > [data-row="${CSS.escape(target.root)}"]`,
      );
      if (card) await fadeCards([card], 220);
      const before = spotsOf(gridRef.current);
      flushSync(() => onOverviewChange(next));
      settleCards(gridRef.current, before);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * C38 / C40 (spec 20 section 9): a wizard made a project and has charged its
   * preview card; the card now grows into the new dashboard. The wizard and the
   * overview under it go into the transition's picture together, so the dialog
   * must not also play its own closing sink on top of the new page.
   */
  function created(status: SystemStatus, card: HTMLElement | null) {
    for (const el of document.querySelectorAll<HTMLElement>(".modal-backdrop")) el.dataset.exit = "none";
    void growTo(
      {
        from: card,
        to: () => document.querySelector("main.content .view"),
        look: "card",
        lift: 0.03,
      },
      () => onLoaded(status),
    );
  }

  function trigger(kind: EntryKind) {
    setError(null);
    if (kind === "open") void openExisting();
    else setModal(kind);
  }

  // The primary entry goes last, where the header's row ends (spec 20 §1).
  const entries: { kind: EntryKind; icon: ComponentType<IconProps>; title: string; desc: string }[] = [
    { kind: "open", icon: IconFolder, title: t("welcome.openTitle"), desc: t("welcome.openDesc") },
    { kind: "adopt", icon: IconClipboardCheck, title: t("welcome.adoptTitle"), desc: t("welcome.adoptDesc") },
    { kind: "import", icon: IconDownload, title: t("welcome.importTitle"), desc: t("welcome.importDesc") },
    { kind: "wizard", icon: IconPlus, title: t("welcome.initTitle"), desc: t("welcome.initDesc") },
  ];

  // Three states, not two (D65). The registry read is a local JSON file and
  // resolves in tens of ms, so the first-read branch stays deliberately blank
  // rather than flashing a skeleton — what it must never do is fall through
  // to the welcome, which tells a returning user their whole catalog is gone.
  if (overview === null) return <div className="view" />;

  const pageError = modal === null && confirmRemove === null ? error : null;

  return (
    <>
      {overview.length === 0 ? (
        <Welcome entries={entries} error={pageError} onEntry={trigger} />
      ) : (
        <div className={`view view--projects${enter ? " ov-enter" : ""}`}>
          <header className="ov-head">
            <div className="ov-title">
              <h1>{t("welcome.projectsTitle")}</h1>
              <p className="hubline">
                <span>
                  <i className={`dot-run${motionOff() ? "" : " amb"}`} aria-hidden="true" />
                  <Count text={t("welcome.hubAgents", { n: MARK })} n={sessions.length} />
                </span>
                <span className="you">
                  <i className="mk-y" aria-hidden="true" />
                  <Count text={t("welcome.hubWaiting", { n: MARK })} n={waitingN} />
                </span>
                <span>
                  <Count
                    text={t("welcome.hubCalls", { n: MARK })}
                    n={today?.n ?? null}
                    plus={today?.floor ?? false}
                  />
                </span>
              </p>
            </div>
            <div className="ov-acts">
              {entries.map(({ kind, icon: Icon, title, desc }) => (
                <button
                  key={kind}
                  className={`btn ${kind === "wizard" ? "btn-primary" : ""}`}
                  title={desc}
                  onClick={() => trigger(kind)}
                >
                  <Icon size={15} /> {title}
                </button>
              ))}
            </div>
          </header>

          <ErrorBar error={pageError} />

          <HubOrbit ref={hubRef} sessions={orbit} />

          <div className="ov-body">
            <div className="ov-main">
              {shown.length === 0 && (
                <div ref={emptyRef} className="ov-empty">
                  <EmptyState
                    title={t("welcome.emptyCategory")}
                    hint={t("welcome.emptyCategoryHint")}
                    action={{ label: t("welcome.catAll"), onClick: onClearCategory }}
                  />
                </div>
              )}
              <ul className="ws-card-grid" ref={gridRef}>
                {shown.map((ws, j) => {
                  const k = normRoot(ws.root);
                  const running = runningByRoot.has(k);
                  return (
                    <ProjectCard
                      key={ws.root}
                      data={cardData(ws)}
                      index={j}
                      running={running}
                      waiting={waitingLabels(ws)}
                      waveEvents={running ? (waves[k] ?? []) : undefined}
                      landed={landed[k]?.n ?? 0}
                      landedYou={landed[k]?.you ?? false}
                      confirming={confirmRemove?.root === ws.root}
                      onOpen={(card) => void openProject(ws.root, card)}
                      onRemove={() => {
                        setError(null);
                        setConfirmRemove(ws);
                      }}
                    />
                  );
                })}
              </ul>
            </div>
            <LiveFeed rows={feed} />
          </div>
        </div>
      )}

      {modal !== null && (
        <Modal
          label={
            modal === "wizard"
              ? t("welcome.initTitle")
              : modal === "adopt"
                ? t("welcome.adoptTitle")
                : t("welcome.importTitle")
          }
          wizard
          onClose={() => setModal(null)}
        >
          {modal === "wizard" && (
            <InitWizard error={error} onCancel={() => setModal(null)} onLoaded={created} onError={setError} />
          )}
          {modal === "adopt" && (
            <AdoptWizard error={error} onCancel={() => setModal(null)} onLoaded={created} onError={setError} />
          )}
          {modal === "import" && (
            <ImportForm error={error} onCancel={() => setModal(null)} onLoaded={created} onError={setError} />
          )}
        </Modal>
      )}
      {confirmRemove !== null && (
        <ConfirmDanger
          heading={t("welcome.removeConfirmHeading")}
          // The copy says the folder is left alone; the path says *which*
          // folder, and it is the only thing on screen that can tell two
          // same-named projects apart. The sidebar switcher confirms the same
          // action with the text alone — there the workspace is already the one
          // you are standing in, here you are picking one out of a grid.
          body={
            <>
              <p className="muted">{t("welcome.removeConfirmBody", { name: confirmRemove.name })}</p>
              <div className="rm-path">
                <PathLabel path={confirmRemove.root} />
              </div>
            </>
          }
          confirmLabel={t("welcome.removeConfirmAction")}
          error={error}
          onConfirm={() => void removeProject()}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}

/** Where the number goes in a counted label ("{{n}} waiting"). Private use, never shown. */
const MARK = "";

/** A header count: the label around a bold, scrambling number (C10). Blank until known. */
function Count({ text, n, plus = false }: { text: string; n: number | null; plus?: boolean }) {
  const [before, after = ""] = text.split(MARK);
  return (
    <>
      {before}
      <b>{n === null ? "" : <Scramble value={`${n}${plus ? "+" : ""}`} />}</b>
      {after}
    </>
  );
}

