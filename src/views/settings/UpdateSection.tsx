import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import { downloadPercent, releasePageUrl, RELEASES_URL } from "../../lib/update";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "portable" }
  | { kind: "available"; update: Update }
  | { kind: "confirm"; update: Update; terminals: number }
  | { kind: "downloading"; update: Update; done: number; total: number | null }
  // Downloaded, but the hub beside the app is still held open (Windows): the
  // install would fail halfway, so it waits for the user to free it.
  | { kind: "hubBusy"; update: Update }
  | { kind: "installing" }
  | { kind: "failed"; message: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * User-triggered in-app update (D144). Nothing here runs on its own: no
 * background check, no silent download — the user presses Check, sees the
 * version, and presses Install. Installing restarts the app (the installer has
 * to replace it) — the button says so. Running terminal sessions are the one
 * thing it ends for good, so those, and only those, get ConfirmDanger, the
 * same rule the close button follows.
 */
export default function UpdateSection({ currentVersion }: { currentVersion: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The Update is a handle to a resource held by the plugin; release it when
  // this page goes away without installing.
  const held = useRef<Update | null>(null);
  useEffect(
    () => () => {
      void held.current?.close().catch(() => {});
    },
    [],
  );

  async function runCheck() {
    setPhase({ kind: "checking" });
    try {
      const pre = await api.updatePreflight();
      if (pre.portable) {
        setPhase({ kind: "portable" });
        return;
      }
      const update = await check();
      held.current = update;
      setPhase(update ? { kind: "available", update } : { kind: "upToDate" });
    } catch (e) {
      setPhase({ kind: "failed", message: errorMessage(e) });
    }
  }

  async function askToInstall(update: Update) {
    try {
      const pre = await api.updatePreflight();
      // Same rule as quitting (App.tsx confirmQuit): only running sessions
      // earn the red dialog — the restart itself is announced on the button.
      if (pre.runningTerminals > 0) setPhase({ kind: "confirm", update, terminals: pre.runningTerminals });
      else await downloadThenInstall(update);
    } catch (e) {
      setPhase({ kind: "failed", message: errorMessage(e) });
    }
  }

  async function downloadThenInstall(update: Update) {
    let total: number | null = null;
    let done = 0;
    setPhase({ kind: "downloading", update, done, total });
    try {
      await update.download((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? null;
        if (ev.event === "Progress") done += ev.data.chunkLength;
        setPhase({ kind: "downloading", update, done, total });
      });
    } catch (e) {
      setPhase({ kind: "failed", message: errorMessage(e) });
      return;
    }
    await install(update);
  }

  async function install(update: Update) {
    try {
      // Same as quitting: persist the tabs for restore and end the children.
      await api.terminalShutdown();
      // An agent CLI those terminals ran can take a moment to let go of the
      // hub. Anything still holding it after that is outside this app.
      for (let i = 0; ; i++) {
        const pre = await api.updatePreflight();
        if (!pre.hubBusy) break;
        if (i === 4) {
          setPhase({ kind: "hubBusy", update });
          return;
        }
        await sleep(1000);
      }
      setPhase({ kind: "installing" });
      // Windows: the installer takes over and this process exits here.
      await update.install();
      held.current = null;
      // macOS / Linux: the files are replaced; start the new version.
      await api.updateRelaunch();
    } catch (e) {
      setPhase({ kind: "failed", message: errorMessage(e) });
    }
  }

  const open = (url: string) => void openUrl(url).catch(() => {});

  return (
    <>
      <div className="settings-row">
        <div className="sr-body">
          <div className="sr-desc">
            Agent NextUp · {t("common.version")} {currentVersion}
          </div>
          <div className="sr-desc muted">{t("update.hint")}</div>
        </div>
        <button
          className="btn"
          onClick={() => void runCheck()}
          disabled={["checking", "downloading", "installing", "confirm"].includes(phase.kind)}
        >
          {phase.kind === "checking" ? t("update.checking") : t("update.check")}
        </button>
      </div>

      {phase.kind === "upToDate" && <div className="alert alert-ok">{t("update.upToDate")}</div>}

      {phase.kind === "portable" && (
        <div className="alert alert-info update-box">
          <p>{t("update.portable")}</p>
          <div className="ub-actions">
            <button className="btn" onClick={() => open(RELEASES_URL)}>
              {t("update.openReleases")}
            </button>
          </div>
        </div>
      )}

      {(phase.kind === "available" || phase.kind === "confirm") && (
        <div className="alert alert-info update-box">
          <p>
            <strong>{t("update.available", { version: phase.update.version })}</strong>
            {phase.update.date && ` · ${t("update.publishedOn", { date: phase.update.date.slice(0, 10) })}`}
          </p>
          <div className="ub-actions">
            <button className="btn btn-primary" onClick={() => void askToInstall(phase.update)}>
              {t("update.install")}
            </button>
            <button className="btn" onClick={() => open(releasePageUrl(phase.update.version))}>
              {t("update.whatChanged")}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "downloading" && (
        <div className="alert alert-info">
          {(() => {
            const pct = downloadPercent(phase.done, phase.total);
            return pct === null ? t("update.downloadingNoSize") : t("update.downloading", { percent: pct });
          })()}
        </div>
      )}

      {phase.kind === "hubBusy" && (
        <div className="alert alert-error update-box">
          <p>{t("update.hubBusy")}</p>
          <div className="ub-actions">
            <button className="btn btn-primary" onClick={() => void install(phase.update)}>
              {t("update.retryInstall")}
            </button>
          </div>
        </div>
      )}

      {phase.kind === "installing" && <div className="alert alert-info">{t("update.installing")}</div>}

      {phase.kind === "failed" && (
        <div className="alert alert-error">{t("update.failed", { message: phase.message })}</div>
      )}

      {phase.kind === "confirm" && (
        <ConfirmDanger
          heading={t("update.confirmHeading", { version: phase.update.version })}
          body={
            <>
              <p>{t("update.confirmLost", { n: phase.terminals })}</p>
              <p>{t("update.confirmKept")}</p>
            </>
          }
          confirmLabel={t("update.confirmButton")}
          onConfirm={() => void downloadThenInstall(phase.update)}
          onCancel={() => setPhase({ kind: "available", update: phase.update })}
        />
      )}
    </>
  );
}
