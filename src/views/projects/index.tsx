import { useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import Modal from "../../components/Modal";
import {
  IconClipboardCheck,
  IconDownload,
  IconFolder,
  IconPlus,
  IconX,
  type IconProps,
} from "../../components/icons";
import type { SystemStatus, TemplateSummary, WorkspaceOverview } from "../../types";
import EmptyState from "../../components/EmptyState";
import { CAT_ALL, categoryOf } from "../../lib/categories";
import InitWizard from "./InitWizard";
import AdoptWizard from "./AdoptWizard";
import ImportForm from "./ImportForm";
import TimeAgo from "../../components/TimeAgo";
import PathLabel from "../../components/PathLabel";

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
  /** Roots with a live terminal session (D50): cards carry a running mark. */
  runningRoots: Set<string>;
}

type ModalKind = "wizard" | "adopt" | "import" | null;
type EntryKind = Exclude<ModalKind, null> | "open";

/**
 * The app's home (D46): every registered project as a card, filtered by the
 * sidebar's template category. The four lifecycle entries live in the
 * toolbar and open as modals; with an empty catalog the view falls back to
 * the first-run hero.
 */
export default function ProjectsHome({
  overview,
  onOverviewChange,
  templates,
  category,
  onClearCategory,
  onLoaded,
  runningRoots,
}: Props) {
  const { t } = useTranslation();
  const [modal, setModal] = useState<ModalKind>(null);
  // Pending "remove from list" target (D46: the registry is the permanent
  // catalog — a stray hover-× would silently lose the pointer, so removal
  // asks first). Files are never touched either way.
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const builtInIds = useMemo(
    () => new Set(templates.filter((tpl) => tpl.source === "built_in").map((tpl) => tpl.id)),
    [templates],
  );
  const rows = overview ?? [];
  const shown =
    category === CAT_ALL ? rows : rows.filter((ws) => categoryOf(ws, builtInIds) === category);

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

  async function openProject(root: string) {
    setError(null);
    try {
      onLoaded(await api.openWorkspace(root));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function removeProject() {
    if (confirmRemove === null) return;
    setError(null);
    try {
      onOverviewChange(await api.removeRecentWorkspace(confirmRemove.root));
      setConfirmRemove(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function trigger(kind: EntryKind) {
    setError(null);
    if (kind === "open") void openExisting();
    else setModal(kind);
  }


  const entries: { kind: EntryKind; icon: ComponentType<IconProps>; title: string; desc: string }[] = [
    { kind: "open", icon: IconFolder, title: t("welcome.openTitle"), desc: t("welcome.openDesc") },
    { kind: "wizard", icon: IconPlus, title: t("welcome.initTitle"), desc: t("welcome.initDesc") },
    { kind: "adopt", icon: IconClipboardCheck, title: t("welcome.adoptTitle"), desc: t("welcome.adoptDesc") },
    { kind: "import", icon: IconDownload, title: t("welcome.importTitle"), desc: t("welcome.importDesc") },
  ];

  // Three states, not two (D65). The registry read is a local JSON file and
  // resolves in tens of ms, so the first-read branch stays deliberately blank
  // rather than flashing a skeleton — what it must never do is fall through
  // to the hero, which tells a returning user their whole catalog is gone.
  if (overview === null) return <div className="view" />;

  return (
    <div className="view">
      {overview.length === 0 ? (
        <div className="projects-empty">
          <div className="welcome-hero">
            <h1>{t("welcome.title")}</h1>
            <p>{t("welcome.subtitle")}</p>
          </div>
          {error && modal === null && confirmRemove === null && (
            <div className="alert alert-error">{error}</div>
          )}
          <div className="entry-grid">
            {entries.map(({ kind, icon: Icon, title, desc }) => (
              <button key={kind} className="entry-card" onClick={() => trigger(kind)}>
                <span className="entry-icon">
                  <Icon size={18} />
                </span>
                <h2>{title}</h2>
                <p>{desc}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <header className="view-header">
            <div className="vh-main">
              <h1>{t("welcome.projectsTitle")}</h1>
              <p className="view-sub">{t("welcome.projectsSubtitle")}</p>
            </div>
            <div className="header-actions">
              {entries.map(({ kind, icon: Icon, title }) => (
                <button
                  key={kind}
                  className={`btn ${kind === "wizard" ? "btn-primary" : ""}`}
                  onClick={() => trigger(kind)}
                >
                  <Icon size={14} /> {title}
                </button>
              ))}
            </div>
          </header>

          {error && modal === null && confirmRemove === null && (
            <div className="alert alert-error">{error}</div>
          )}

          {shown.length === 0 && (
            <EmptyState
              title={t("welcome.emptyCategory")}
              hint={t("welcome.emptyCategoryHint")}
              action={{ label: t("welcome.catAll"), onClick: onClearCategory }}
            />
          )}
          <ul className="ws-card-grid">
            {shown.map((ws) => (
              <li key={ws.root} className={`ws-card ${ws.exists ? "" : "ws-card--missing"}`}>
                <button
                  className="ws-card-open"
                  disabled={!ws.exists}
                  title={ws.root}
                  onClick={() => void openProject(ws.root)}
                >
                  <span className="ws-card-name">
                    {ws.name}
                    {/* "general" is what init writes when nobody said
                        otherwise (init.rs), so on most catalogs every card
                        carried the same chip — one per card of information
                        the grid already has, which is none (r2 3-5). A domain
                        someone actually chose still shows. */}
                    {ws.domain && ws.domain !== "general" && (
                      <span className="chip">{ws.domain}</span>
                    )}
                    {!ws.exists && <span className="chip">{t("welcome.recentMissing")}</span>}
                    {runningRoots.has(ws.root) && (
                      <span className="chip chip-term-running">
                        <span className="dot" aria-hidden="true" />
                        {t("term.runningMark")}
                      </span>
                    )}
                  </span>
                  <PathLabel className="ws-card-path" path={ws.root} copyable={false} />
                  <span className="ws-card-meta">
                    {ws.templateName && <>{ws.templateName}{" · "}</>}
                    {ws.currentPhase && (
                      <>
                        {ws.workflowCompleted
                          ? t("welcome.recentDone")
                          : ws.currentPhaseTitle ?? ws.currentPhase}
                        {" · "}
                      </>
                    )}
                    {ws.taskCounts &&
                      t("welcome.recentTasks", {
                        done: ws.taskCounts.done,
                        total: ws.taskCounts.total,
                      })}
                  </span>
                  <TimeAgo className="ws-card-time" at={ws.lastOpened} />
                </button>
                <button
                  className="btn btn-ghost btn-icon ws-card-remove danger-trigger"
                  title={t("welcome.removeRecent")}
                  aria-label={t("welcome.removeRecent")}
                  onClick={() => {
                    setError(null);
                    setConfirmRemove(ws);
                  }}
                >
                  <IconX size={13} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {modal === "wizard" && (
        <Modal label={t("welcome.initTitle")} onClose={() => setModal(null)}>
          {error && <div className="alert alert-error">{error}</div>}
          <InitWizard
            onCancel={() => setModal(null)}
            onLoaded={onLoaded}
            onError={setError}
          />
        </Modal>
      )}
      {modal === "adopt" && (
        <Modal label={t("welcome.adoptTitle")} onClose={() => setModal(null)}>
          {error && <div className="alert alert-error">{error}</div>}
          <AdoptWizard
            onCancel={() => setModal(null)}
            onLoaded={onLoaded}
            onError={setError}
          />
        </Modal>
      )}
      {modal === "import" && (
        <Modal label={t("welcome.importTitle")} onClose={() => setModal(null)}>
          {error && <div className="alert alert-error">{error}</div>}
          <ImportForm
            onCancel={() => setModal(null)}
            onLoaded={onLoaded}
            onError={setError}
          />
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
              <p className="muted">
                {t("welcome.removeConfirmBody", { name: confirmRemove.name })}
              </p>
              <PathLabel className="ws-card-path" path={confirmRemove.root} />
            </>
          }
          confirmLabel={t("welcome.removeConfirmAction")}
          error={error}
          onConfirm={() => void removeProject()}
          onCancel={() => setConfirmRemove(null)}
        />
      )}
    </div>
  );
}
