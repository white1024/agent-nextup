import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useFlash, useGuardedMutation } from "../hooks";
import ErrorBar from "../components/ErrorBar";
import FlashBar from "../components/FlashBar";
import InfoTip from "../components/InfoTip";
import Scramble from "../components/Scramble";
import { Check, Switch } from "../components/controls";
import { IconLock } from "../components/icons";
import {
  DOMAIN_SUGGESTIONS,
  dirtyFields,
  formOf,
  nameMissing,
  renames,
  splitLines,
  type ContextField,
  type ContextForm,
} from "../lib/contextForm";
import { baseName } from "../lib/format";
import { MODULE_CATALOG, type ModuleId } from "../lib/modules";
import { centreOf, fx, lightNav, motionOff, navItem, tokenRgb } from "../lib/fx";
import {
  BOX_CLOSE_MS,
  BOX_OPEN_MS,
  EASE_IN,
  EASE_OUT,
  boxClose,
  boxOf,
  boxOpen,
  pictureOf,
  settleBox,
} from "../lib/listMotion";
import { growTo, projectCard } from "../lib/transitions";
import { modeSwitchKey } from "../lib/workflowMode";
import type { ProjectContext, SystemStatus, WorkflowStatus, WorkspaceModules } from "../types";

interface Props {
  status: SystemStatus;
  /** Closing the project: the app re-homes to the projects page. */
  onStatusChange: (status: SystemStatus) => void;
  /** A newer read of this same project: the shell catches up, the page stays. */
  onStatusRefreshed: (status: SystemStatus) => void;
  /** Current workspace modules (loaded by App via modules_get; null while unknown). */
  modules: WorkspaceModules | null;
  /** Propagate a toggle up so the sidebar nav reflects it immediately. */
  onModulesChange: (modules: WorkspaceModules) => void;
  /** Jump to the machine-wide settings page (product review §5-10). */
  onGoToAppSettings: () => void;
  /** Jump to this workspace's Tools page — where a rename's curriculum upgrade waits (D151). */
  onGoToTools: () => void;
}

/** Minimum passphrase length (the engine refuses shorter; the counter counts to it). */
const PASS_MIN = 8;

/** What the backup card (C202) shows while it seals and slides away. */
interface BackupCard {
  name: string;
  file: string;
  art: boolean;
  /** Where the card sits in the section: over the warning and the form. */
  top: number;
  sealed: boolean;
}

/**
 * Timers that die with the page: every staged moment below (a result line
 * that waits for its light, a card that slides off) is cancelled on unmount
 * rather than landing on a page that is gone.
 */
function useLater() {
  const ids = useRef<number[]>([]);
  useEffect(() => () => ids.current.forEach((id) => window.clearTimeout(id)), []);
  return useCallback((ms: number, fn: () => void) => {
    ids.current.push(window.setTimeout(fn, ms));
  }, []);
}

/**
 * Workspace-scoped settings (D55): project info (D142), modules, the AI
 * takeover layer, backup and closing the workspace. Split out of the app-level Settings page so project
 * settings live in the workspace nav rather than buried below the machine-wide
 * ones (D49's single page put them at the bottom of a long scroll). Only
 * mounted with a workspace open, so it always has one.
 *
 * Its motion is spec 10's project-settings section (my-design review F8: the
 * page had none): C198 / C199 / C237 in the info panel, C200 on the module
 * switches, C201 for the takeover files, C202 for the backup, C204 when the
 * info arrives or an export fails, and C13 backwards when the workspace closes.
 * Every one of them is started by an event or a diff, never by a render, and
 * under reduced motion each goes straight to its result.
 *
 * The API-keys panel that used to sit between modules and bootstrap was removed
 * (D88): its only consumer is the dormant orchestrator, so the panel invited
 * users to store a credential nothing would ever read. The IPC commands and the
 * encrypted store stay — see `api.ts` — and the panel comes back with B14.
 */
export default function ProjectSettings({
  status,
  onStatusChange,
  onStatusRefreshed,
  modules,
  onModulesChange,
  onGoToAppSettings,
  onGoToTools,
}: Props) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [includeArtifacts, setIncludeArtifacts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { busy: exporting, run } = useGuardedMutation(setError);
  const { flash, showFlash } = useFlash(3000);
  // A rename's follow-up stays until acted on or replaced: it carries a
  // button, and a 3-second flash would be gone before anyone pressed it.
  const [renamed, setRenamed] = useState(false);
  /** The files the last "fill in" wrote, one row each (C201). */
  const [files, setFiles] = useState<string[]>([]);
  const [card, setCard] = useState<BackupCard | null>(null);
  const later = useLater();
  const pageRef = useRef<HTMLDivElement>(null);
  const bootRef = useRef<HTMLElement>(null);
  const backupRef = useRef<HTMLElement>(null);
  const warnRef = useRef<HTMLParagraphElement>(null);
  const backupFormRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  // The save dialog is awaited outside the guard on purpose: it is modal, and
  // cancelling it must leave the form untouched rather than flash a busy state.
  async function exportBackup() {
    setError(null);
    const name = status.workspace?.name ?? "agent-nextup";
    const suggested = `${name}-backup.zip`;
    let dest: string | null;
    try {
      dest = await save({
        defaultPath: suggested,
        filters: [{ name: "Agent NextUp backup", extensions: ["zip"] }],
      });
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    if (typeof dest !== "string") return;
    const target = dest;
    await run(async () => {
      const written = await api.exportBackup(target, passphrase, includeArtifacts);
      const done = () => {
        showFlash(`${t("settings.exportedTo")} ${written}`);
        setPassphrase("");
      };
      sealBackup({ name, file: baseName(written), art: includeArtifacts }, done);
    });
  }

  /**
   * C202: an empty frame grows out of the form into a backup card — the
   * project's files on one side, the sealed half with its lock on the other —
   * the lock snaps shut, and the card slides off to the right before the
   * result line says where it went. The passphrase stays in the field until
   * then, and the button stays off while the card is out.
   */
  function sealBackup(c: Omit<BackupCard, "top" | "sealed">, done: () => void) {
    const sec = backupRef.current;
    const form = backupFormRef.current;
    if (motionOff() || sec === null || form === null) {
      done();
      return;
    }
    const from = boxOf(form);
    const picture = pictureOf(form);
    flushSync(() => setCard({ ...c, top: (warnRef.current ?? form).offsetTop, sealed: false }));
    const el = cardRef.current;
    if (el === null) {
      setCard(null);
      done();
      return;
    }
    settleBox();
    boxOpen({ host: sec, from, picture, dst: el, cls: "pcf-ghost pcf-ghost-card" });
    later(BOX_OPEN_MS + 160, () => setCard((x) => (x === null ? x : { ...x, sealed: true })));
    later(BOX_OPEN_MS + 900, () => {
      const leave = el.animate(
        [
          { opacity: 1, transform: "none" },
          { opacity: 0, transform: "translateX(56px)" },
        ],
        { duration: 460, easing: "cubic-bezier(.4,0,.6,1)", fill: "forwards" },
      );
      void leave.finished.catch(() => undefined).then(() => setCard(null));
      later(300, done);
    });
  }

  /**
   * Closing folds the page back into this project's card on the overview (C13
   * backwards, R-10-63) — the same way out as the sidebar's "All projects".
   * The engine closes first, so a failure stays here with its error.
   */
  async function closeWorkspace() {
    setError(null);
    const root = status.workspace?.root ?? null;
    let next: SystemStatus;
    try {
      next = await api.closeWorkspace();
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    void growTo({ from: null, back: true, look: "card", to: () => projectCard(root) }, () =>
      onStatusChange(next),
    );
  }

  /**
   * How many deliveries are still sitting in the outbox unsent. Read before a
   * team-module switch-off, never after: the engine's `require_module` guard
   * refuses `exchange_list` once the module is off, so asking afterwards would
   * always answer zero (D103).
   */
  async function countUnsentDeliveries(): Promise<number> {
    const root = status.workspace?.root;
    if (!root) return 0;
    try {
      const outbox = await api.exchangeList(root, "outbox");
      return outbox.filter((d) => !d.deliveredAt).length;
    } catch {
      // Not worth an error banner — the toggle itself still works, and the
      // fallback message says the same thing without a number.
      return 0;
    }
  }

  /**
   * Module switches stay reversible and unconfirmed (D61, D102 ③-tier): turning
   * the team module off hides the inbox and the hub tools but deletes nothing —
   * envelopes, guides and your own edits all come back on re-enable. What it
   * does *not* do is say so, which is why switching off announces what went
   * quiet rather than gating it behind a confirmation (D103).
   *
   * C200: the sidebar entry the module owns grows out of the switch, or folds
   * back into it.
   */
  async function setModuleEnabled(id: ModuleId, enabled: boolean) {
    setError(null);
    const unsent = id === "team" && !enabled ? await countUnsentDeliveries() : null;
    try {
      const next = await api.moduleSetEnabled(id, enabled);
      const view = MODULE_CATALOG.find((m) => m.id === id)?.view ?? null;
      const sw = pageRef.current?.querySelector<HTMLElement>(`[data-mod="${id}"] .switch`) ?? null;
      navEntryMotion(view, enabled, sw, () => onModulesChange(next));
      if (unsent !== null) {
        showFlash(
          unsent > 0 ? t("settings.teamOffUnsent", { n: unsent }) : t("settings.teamOff"),
        );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /**
   * C201: the files that were missing are written out one row at a time, each
   * lighting once with a pop of its mark (CSS, staged by row); the result line
   * follows the last one. With nothing missing, a light sweeps the block.
   */
  async function scaffoldBootstrap() {
    setError(null);
    try {
      const created = await api.scaffoldBootstrap();
      if (created.length === 0) {
        setFiles([]);
        const band = bootRef.current?.querySelector(".pcf-sweepbox > i");
        if (band instanceof HTMLElement && !motionOff()) {
          band.animate(
            [
              { opacity: 1, transform: "translateX(-100%)" },
              { opacity: 0, transform: "translateX(100%)" },
            ],
            { duration: 900, easing: "ease-out" },
          );
        }
        showFlash(t("settings.bootstrapNone"));
        return;
      }
      setFiles(created);
      const msg = `${t("settings.bootstrapCreated")} ${created.join(", ")}`;
      if (motionOff()) showFlash(msg);
      else later(FILE_FIRST_MS + created.length * FILE_STEP_MS + 160, () => showFlash(msg));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  const passOk = passphrase.length >= PASS_MIN;

  return (
    <div className="view view--wide" ref={pageRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("settings.projectHeading")}</h1>
          <p className="view-sub">
            {t("settings.projectSubtitle")}
            {/* C237: a rename settles into the new name (the sidebar's own
                name does the same). */}
            {status.workspace && (
              <Scramble className="sz-name" value={status.workspace.name} durationMs={640} />
            )}
          </p>
        </div>
      </header>

      <p className="scope-hint">
        {t("settings.lookingForApp")}{" "}
        <button className="btn-link" onClick={onGoToAppSettings}>
          {t("settings.heading")}
        </button>
      </p>

      <ErrorBar error={error} />
      <FlashBar message={flash} />
      {/* Long and kept until acted on, so it does not stick to the top over
          half the form (spec 10, project settings). */}
      <FlashBar message={renamed ? t("settings.renamedNotice") : null} className="flash-bar--static">
        <button className="btn-link" onClick={onGoToTools}>
          {t("settings.renamedGoToTools")}
        </button>
      </FlashBar>

      {/* Two columns (D153): what the project is on the left; what it can do,
          its handoff layer, its backup and the workspace itself on the right. */}
      <div className="settings-cols settings-cols--project">
        <div className="settings-col">
          <ProjectInfoPanel
            root={status.workspace?.root ?? ""}
            onError={setError}
            onSaved={() => {
              // The dashboard's domain chip and the sidebar's name read
              // system_status; the engine has already refreshed its cached
              // copy, this just fetches it. Right away: a rename's names
              // settle now (C237), the words about it come with the light.
              api.systemStatus().then(onStatusRefreshed).catch(() => {});
            }}
            onAnnounce={(wasRename) => {
              setRenamed(wasRename);
              if (!wasRename) showFlash(t("settings.projectInfoSaved"));
            }}
          />
          <WorkflowModePanel onError={setError} onAnnounce={showFlash} />
        </div>

        <div className="settings-col">
          <section className="panel settings-sec">
            <div className="panel-head">
              <h2 className="panel-title">{t("settings.modules")}</h2>
              <InfoTip label={t("common.moreInfo")}>{t("settings.modulesHint")}</InfoTip>
            </div>
            {MODULE_CATALOG.map(({ id }) => {
              const on = modules?.enabled.includes(id) ?? false;
              return (
                <div
                  className={`settings-row${modules === null ? " is-loading" : ""}`}
                  key={id}
                  data-mod={id}
                >
                  <div className="sr-body">
                    <div className="sr-title">{t(`settings.module_${id}`)}</div>
                    {/* Unknown until read, then it settles into the new
                        sentence each time the switch is thrown (C200). */}
                    {modules !== null && (
                      <Scramble
                        className="sr-desc"
                        value={on ? t(`settings.moduleOn_${id}`) : t(`settings.moduleOff_${id}`)}
                        durationMs={640}
                      />
                    )}
                  </div>
                  <Switch
                    checked={on}
                    onChange={(v) => void setModuleEnabled(id, v)}
                    disabled={modules === null}
                    ariaLabel={t(`settings.module_${id}`)}
                  />
                </div>
              );
            })}
          </section>

          <section className="panel settings-sec pcf-sec" ref={bootRef}>
            <div className="pcf-sweepbox" aria-hidden="true">
              <i />
            </div>
            <div className="panel-head">
              <h2 className="panel-title">{t("settings.bootstrap")}</h2>
              <InfoTip label={t("common.moreInfo")}>{t("settings.bootstrapHint")}</InfoTip>
              <span className="spacer" />
              <button className="btn btn-small" onClick={() => void scaffoldBootstrap()}>
                {t("settings.bootstrapButton")}
              </button>
            </div>
            {files.length > 0 && (
              <ul className="pcf-files">
                {files.map((f, k) => (
                  <li className="pcf-file" key={f} style={{ ["--k" as string]: k }}>
                    <i className="mk-e" aria-hidden="true" />
                    <code>{f}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel settings-sec pcf-sec pcf-clip" ref={backupRef}>
            <div className="panel-head">
              <h2 className="panel-title">{t("settings.backup")}</h2>
            </div>
            {/* A rule, not teaching (invariant 17(c)): stays on screen. */}
            <p className="section-hint settings-warn" ref={warnRef}>
              {t("settings.backupHint")}
            </p>
            <div className="backup-form" ref={backupFormRef}>
              <label className="field grow">
                <span>{t("settings.passphrase")}</span>
                <span className="pcf-pw">
                  <input
                    type="password"
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                  />
                  {/* How far along the minimum is; the label already says
                      the rule, so this is for the eye. */}
                  <span className={`pcf-count${passOk ? " ok" : ""}`} aria-hidden="true">
                    {Math.min(passphrase.length, PASS_MIN)} / {PASS_MIN}
                  </span>
                </span>
              </label>
              <Check checked={includeArtifacts} onChange={setIncludeArtifacts}>
                {t("settings.includeArtifacts")}
              </Check>
              <button
                className="btn btn-primary"
                onClick={() => void exportBackup()}
                disabled={exporting || card !== null || !passOk}
              >
                {exporting ? t("settings.exporting") : t("settings.exportButton")}
              </button>
            </div>
            {card !== null && (
              <div
                ref={cardRef}
                className={`pcf-card${card.sealed ? " seal" : ""}`}
                style={{ top: card.top }}
                aria-hidden="true"
              >
                <div className="pcf-card-h">
                  <b>{card.name}</b>
                  <code>{card.file}</code>
                </div>
                <div className="pcf-cells">
                  <div className="pcf-cell">
                    <div>
                      <b>{t("settings.backupCardFiles")}</b>
                      <span>
                        {t("settings.backupCardFilesSub")} ·{" "}
                        {card.art ? t("settings.backupCardArt") : t("settings.backupCardNoArt")}
                      </span>
                    </div>
                  </div>
                  <div className="pcf-cell sealed">
                    <span className="pcf-lock">
                      <IconLock size={20} />
                    </span>
                    <div>
                      <b>{t("settings.backupCardSealed")}</b>
                      <span>{t("settings.backupCardSealedSub")}</span>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section className="panel settings-sec">
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">{t("settings.workspace")}</div>
              </div>
              <button className="btn" onClick={() => void closeWorkspace()}>
                {t("settings.closeWorkspace")}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

/** C201's rows: the first one at 120ms, then one every 260ms (the CSS uses the same). */
const FILE_FIRST_MS = 120;
const FILE_STEP_MS = 260;

/**
 * C200 on the sidebar. Switching a module on grows its entry out of the
 * switch: the entry is put in place first, the ones below slide down to make
 * room, an empty frame trailing a light travels from the switch to it, and
 * the icon and name show once the frame arrives. Switching off runs it
 * backwards: the name fades, the frame shrinks from the entry back into the
 * switch, and the entries below slide up.
 *
 * `swap` is the plain state change — the sidebar shows the entry because the
 * module is on (App's `moduleOn`), not because of this — so with no entry to
 * move (prime has none), no switch on screen, or reduced motion, it just runs.
 */
function navEntryMotion(view: string | null, on: boolean, sw: HTMLElement | null, swap: () => void) {
  const nav = document.querySelector<HTMLElement>(".sidebar .nav");
  if (view === null || nav === null || sw === null || motionOff()) {
    swap();
    return;
  }
  const entries = () => [...nav.querySelectorAll<HTMLElement>("[data-view]")];
  const before = new Map(entries().map((b) => [b.dataset.view ?? "", b.getBoundingClientRect().top]));
  const gone = on ? null : navItem(view);
  const goneBox = gone === null ? null : boxOf(gone);
  const goneOut = gone === null ? null : pictureOf(gone);
  settleBox();
  flushSync(swap);
  const slide = (timing: KeyframeAnimationOptions) => {
    for (const b of entries()) {
      const was = before.get(b.dataset.view ?? "");
      if (was === undefined) continue;
      const dy = was - b.getBoundingClientRect().top;
      if (Math.abs(dy) > 0.5) b.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing);
    }
  };
  if (on) {
    const entry = navItem(view);
    if (entry === null) return;
    slide({ duration: BOX_OPEN_MS, easing: EASE_OUT });
    boxOpen({ host: document.body, from: boxOf(sw), picture: pictureOf(sw), dst: entry, cls: "pcf-ghost" });
    fx.beam(centreOf(sw), centreOf(entry), { dur: BOX_OPEN_MS + 40, bend: 0.1, width: 1.8 });
    return;
  }
  slide({ duration: BOX_CLOSE_MS, delay: 60, easing: EASE_IN, fill: "backwards" });
  if (goneBox !== null) {
    boxClose({ host: document.body, from: goneBox, to: boxOf(sw), out: goneOut, src: sw, cls: "pcf-ghost", done: () => {} });
  }
}

/**
 * The context fields a person may edit after creation (D142; the name since
 * D151). Loads from disk rather than from `status`, which carries only
 * name/domain/description.
 *
 * Sends every field; the engine decides what changed and writes nothing when
 * nothing did. A rename is the display name only — the folder stays — and the
 * app carries it into the team graph and the registry; the page then points at
 * the curriculum upgrade, the one copy that waits for the user.
 *
 * Motion (spec 10): each edited field carries an amber line and the Save
 * button charges while there is something to save (C198); saving turns the
 * edited lines cyan and sweeps a light down each, then a light runs to the
 * sidebar's Ledger — where the edit was just written — before the result
 * line (C199). The fields fade in when the info arrives (C204).
 */
/**
 * Staged ⇄ ongoing (D171 ③). A person's switch with no hub tool behind it.
 * It goes both ways and keeps the history, so it is tier 3 — no confirmation,
 * no red — and says what changed instead (D103 ③). Absent on a legacy
 * workspace with no harness: there is nothing to switch.
 */
function WorkflowModePanel({
  onError,
  onAnnounce,
}: {
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  // Ongoing needs instructions: the project's own copy, or — on a
  // workflow.json from before D171 — its template's, looked up by id.
  const [canOngoing, setCanOngoing] = useState(true);
  const { busy, run } = useGuardedMutation((m) => onError(m));

  useEffect(() => {
    let stale = false;
    api
      .workflowStatus()
      .then(async (read) => {
        if (stale) return;
        setStatus(read);
        if ((read.workflow.ongoingInstructions ?? []).length > 0) return;
        try {
          const list = await api.listTemplates();
          if (!stale) setCanOngoing(list.find((tpl) => tpl.id === read.workflow.templateId)?.supportsOngoing ?? false);
        } catch {
          if (!stale) setCanOngoing(false);
        }
      })
      .catch(() => {
        // No harness (a legacy workspace): nothing to switch, so no panel.
      });
    return () => {
      stale = true;
    };
  }, []);

  if (status === null) return null;
  const staged = status.workflow.mode !== "ongoing";
  const template = status.workflow.templateName;

  function setStaged(next: boolean) {
    void run(async () => {
      onError(null);
      const read = await api.setWorkflowMode(next ? "staged" : "ongoing");
      setStatus(read);
      const phase =
        read.workflow.phases.find((p) => p.id === read.workflow.state.currentPhase)?.title ??
        read.workflow.state.currentPhase;
      // A finished workflow comes back finished: no phase to return to, and
      // nothing is asked for again (workflow.rs set_mode).
      onAnnounce(t(`settings.${modeSwitchKey(next, read.workflow.state)}`, { phase }));
    });
  }

  return (
    <section className="panel settings-sec">
      <div className="panel-head">
        <h2 className="panel-title">{t("settings.workflow")}</h2>
        <InfoTip label={t("common.moreInfo")}>{t("settings.workflowHint")}</InfoTip>
      </div>
      <div className="settings-row">
        <div className="sr-body">
          <div className="sr-title">{t("settings.workflowStaged")}</div>
          <Scramble
            className="sr-desc"
            durationMs={640}
            value={
              staged && !canOngoing
                ? t("settings.workflowNoOngoing")
                : staged
                  ? t("settings.workflowOnStaged", { template })
                  : t("settings.workflowOnOngoing", { template })
            }
          />
        </div>
        <Switch
          checked={staged}
          onChange={setStaged}
          disabled={busy || (staged && !canOngoing)}
          ariaLabel={t("settings.workflowStaged")}
        />
      </div>
    </section>
  );
}

function ProjectInfoPanel({
  root,
  onError,
  onSaved,
  onAnnounce,
}: {
  root: string;
  onError: (msg: string | null) => void;
  /** The save landed: the shell re-reads status (a new name shows at once). */
  onSaved: () => void;
  /** Time for the words: the result line, or the rename notice. */
  onAnnounce: (renamed: boolean) => void;
}) {
  const { t } = useTranslation();
  const [ctx, setCtx] = useState<ProjectContext | null>(null);
  const [form, setForm] = useState<ContextForm>({ name: "", domain: "", description: "", goals: "", boundaries: "" });
  const { busy, run } = useGuardedMutation(onError);
  const later = useLater();
  const formRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  const nameErrId = useId();

  useEffect(() => {
    let stale = false;
    api
      .getContext()
      .then((c) => {
        if (stale) return;
        setCtx(c);
        setForm(formOf(c));
      })
      .catch((e) => {
        if (!stale) onError(errorMessage(e));
      });
    return () => {
      stale = true;
    };
    // Re-read on project switch; onError is a stable setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // C204: the moment the info arrives (null → read), the fields and the
  // module switches fade up from where the loading state left them.
  const arrived = useRef(false);
  useLayoutEffect(() => {
    if (ctx === null || arrived.current) return;
    arrived.current = true;
    const page = formRef.current?.closest(".view");
    if (motionOff() || page == null) return;
    const ctls = [
      ...page.querySelectorAll<HTMLElement>(".pcf-f > input, .pcf-f > textarea"),
      ...page.querySelectorAll<HTMLElement>("[data-mod]"),
    ];
    ctls.forEach((el, i) =>
      el.animate([{ opacity: 0.35 }, { opacity: 1 }], {
        duration: 460,
        delay: i * 55,
        easing: "ease-out",
        fill: "backwards",
      }),
    );
  }, [ctx]);

  const set = (field: keyof ContextForm) => (value: string) => setForm((f) => ({ ...f, [field]: value }));
  const edited = new Set<ContextField>(ctx === null ? [] : dirtyFields(form, ctx));
  const missing = ctx !== null && nameMissing(form);
  const ready = edited.size > 0 && !busy && !missing;

  function save() {
    return run(async () => {
      onError(null);
      if (ctx === null) return;
      const changed = dirtyFields(form, ctx);
      const wasRename = renames(form, ctx);
      const saved = await api.editContext({
        name: form.name,
        domain: form.domain,
        description: form.description,
        goals: splitLines(form.goals),
        boundaries: splitLines(form.boundaries),
      });
      setCtx(saved);
      setForm(formOf(saved));
      onSaved();
      savedLight(changed, () => onAnnounce(wasRename));
    });
  }

  /** C199, after the fields have been written. */
  function savedLight(changed: ContextField[], announce: () => void) {
    const fields = changed
      .map((k) => formRef.current?.querySelector<HTMLElement>(`[data-field="${k}"]`) ?? null)
      .filter((el): el is HTMLElement => el !== null);
    if (motionOff() || fields.length === 0) {
      announce();
      return;
    }
    const green = `rgb(${tokenRgb("--green")})`;
    fields.forEach((el, i) => {
      const timing = { delay: i * 140, easing: "ease-out", fill: "backwards" as const };
      el.animate(
        [
          { opacity: 1, transform: "none", backgroundColor: green },
          { opacity: 1, transform: "none", backgroundColor: green, offset: 0.55 },
          { opacity: 0, transform: "none", backgroundColor: green },
        ],
        { ...timing, duration: 1100, pseudoElement: "::before" },
      );
      el.animate(
        [
          { opacity: 0, transform: "translateY(0)" },
          { opacity: 1, offset: 0.18 },
          { opacity: 0, transform: `translateY(${Math.max(0, el.offsetHeight - 50)}px)` },
        ],
        { ...timing, duration: 760, pseudoElement: "::after" },
      );
    });
    const ledger = navItem("ledger");
    const from = centreOf(saveRef.current);
    if (ledger === null || from === null) {
      later(fields.length * 140 + 400, announce);
      return;
    }
    later(260 + fields.length * 140, () => {
      fx.beam(from, centreOf(ledger.querySelector(".nav-icon") ?? ledger), { dur: 620, bend: -0.18, width: 2.2 });
      later(580, () => {
        lightNav(ledger);
        announce();
      });
    });
  }

  /** A field's class and its spoken "edited" (the amber line has no words, 9(a)). */
  const fieldClass = (k: ContextField) => `field pcf-f${edited.has(k) ? " dirty" : ""}`;
  const editedMark = (k: ContextField) =>
    edited.has(k) ? <span className="sr-only">{t("settings.fieldEdited")}</span> : null;

  return (
    <section className="panel settings-sec">
      <div className="panel-head">
        <h2 className="panel-title">{t("settings.projectInfo")}</h2>
      </div>
      <p className="section-hint" style={{ marginBottom: "var(--s-3)" }}>
        {t("settings.projectInfoHint")}
      </p>
      <div className={`form pcf-form${ctx === null ? " is-loading" : ""}`} ref={formRef} aria-busy={ctx === null}>
        <label className={fieldClass("name")} data-field="name">
          <span>
            {t("wizard.name")}
            {editedMark("name")}
          </span>
          <input
            value={form.name}
            onChange={(e) => set("name")(e.target.value)}
            disabled={ctx === null}
            aria-invalid={missing}
            aria-describedby={missing ? nameErrId : undefined}
          />
          {/* Why Save went dark, in words (F11): the red frame alone is
              colour, and the button only goes dim. */}
          {missing && (
            <span className="field-err" id={nameErrId}>
              {t("settings.nameRequired")}
            </span>
          )}
        </label>
        <label className={fieldClass("domain")} data-field="domain">
          <span>
            {t("wizard.domain")} {t("common.optional")}
            {editedMark("domain")}
          </span>
          <input
            value={form.domain}
            onChange={(e) => set("domain")(e.target.value)}
            placeholder={t("wizard.domainPlaceholder")}
            list="project-domain-suggestions"
            disabled={ctx === null}
          />
          <datalist id="project-domain-suggestions">
            {DOMAIN_SUGGESTIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
        <label className={fieldClass("description")} data-field="description">
          <span>
            {t("wizard.description")} {t("common.optional")}
            {editedMark("description")}
          </span>
          <textarea
            value={form.description}
            onChange={(e) => set("description")(e.target.value)}
            placeholder={t("wizard.descriptionPlaceholder")}
            rows={2}
            disabled={ctx === null}
          />
        </label>
        <label className={fieldClass("goals")} data-field="goals">
          <span>
            {t("wizard.goals")} {t("common.optional")}
            {editedMark("goals")}
          </span>
          <textarea
            value={form.goals}
            onChange={(e) => set("goals")(e.target.value)}
            placeholder={t("wizard.goalsPlaceholder")}
            rows={3}
            disabled={ctx === null}
          />
        </label>
        <label className={fieldClass("boundaries")} data-field="boundaries">
          <span>
            {t("wizard.boundaries")} {t("common.optional")}
            {editedMark("boundaries")}
          </span>
          <textarea
            value={form.boundaries}
            onChange={(e) => set("boundaries")(e.target.value)}
            placeholder={t("wizard.boundariesPlaceholder")}
            rows={3}
            disabled={ctx === null}
          />
        </label>
        <div className="form-actions">
          {/* C198: charges once when there is something to save, then its
              light breathes until saved or put back. */}
          <button
            ref={saveRef}
            className={`btn btn-primary pcf-save${ready ? " pcf-save--ready" : ""}`}
            onClick={() => void save()}
            disabled={!ready}
          >
            <span className="pcf-ring" aria-hidden="true" />
            <span className="pcf-aura" aria-hidden="true" />
            {busy ? t("settings.projectInfoSaving") : t("settings.projectInfoSave")}
          </button>
        </div>
      </div>
    </section>
  );
}
