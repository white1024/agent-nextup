import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";

import { api, errorMessage } from "../../api";
import ConfirmDanger from "../../components/ConfirmDanger";
import FlashBar from "../../components/FlashBar";
import Scramble from "../../components/Scramble";
import { centreOf, motionOff, type Point } from "../../lib/fx";
import { splitAroundCount } from "../../lib/format";
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

/** When the result of a check shows at the earliest (C196). */
const RESULT_AT_MS = 820;

/** C196: a ring of light spreads from the Check button. */
function ping(at: Point | null) {
  if (at === null || motionOff()) return;
  const ring = document.createElement("div");
  ring.className = "upd-ping";
  ring.setAttribute("aria-hidden", "true");
  Object.assign(ring.style, { left: `${at.x - 48}px`, top: `${at.y - 48}px` });
  document.body.appendChild(ring);
  void ring
    .animate(
      [
        { transform: "scale(.35)", opacity: 0.9 },
        { transform: "scale(1.5)", opacity: 0 },
      ],
      { duration: 760, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" },
    )
    .finished.catch(() => undefined)
    .then(() => ring.remove());
}

/**
 * C197 (my-design review F10), just before the installer takes over: the
 * screen fades to the boot ground leaving only the sidebar's mark, the mark
 * flies back to the middle, and turns away — the boot sequence (C1) run
 * backwards; the new version's boot then plays it forwards. Reduced motion: a
 * plain fade to the boot ground. Returns how to undo it, for an install that
 * fails after all.
 */
async function foldAway(): Promise<() => void> {
  const curtain = document.createElement("div");
  curtain.className = "upd-curtain";
  curtain.setAttribute("aria-hidden", "true");
  document.body.appendChild(curtain);
  const undo: (() => void)[] = [() => curtain.remove()];
  const restore = () => undo.forEach((f) => f());
  if (motionOff()) {
    await curtain.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, fill: "forwards" }).finished.catch(() => undefined);
    return restore;
  }
  await sleep(1000);
  const mark = document.querySelector<HTMLElement>(".sidebar .brand-mark");
  const r = mark?.getBoundingClientRect();
  let clone: HTMLElement | null = null;
  if (mark && r) {
    clone = mark.cloneNode(true) as HTMLElement;
    clone.classList.add("upd-mark");
    Object.assign(clone.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.body.appendChild(clone);
    const c = clone;
    undo.push(() => c.remove());
  }
  curtain.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 620, fill: "forwards" });
  await sleep(560);
  if (clone && r) {
    const dx = window.innerWidth / 2 - (r.left + r.width / 2);
    const dy = window.innerHeight / 2 - (r.top + r.height / 2);
    const there = `translate(${dx}px, ${dy}px) scale(2.4)`;
    await clone
      .animate([{ transform: "none" }, { transform: there }], { duration: 820, easing: "cubic-bezier(.65,0,.15,1)", fill: "forwards" })
      .finished.catch(() => undefined);
    await clone
      .animate(
        [
          { transform: `${there} rotateY(0deg)`, opacity: 1 },
          { transform: `${there} rotateY(540deg) scale(.15)`, opacity: 0 },
        ],
        { duration: 1300, easing: "cubic-bezier(.75,0,.85,.3)", fill: "forwards" },
      )
      .finished.catch(() => undefined);
  }
  return restore;
}

/**
 * The download's percent, counted up rather than jumping with each chunk
 * (C197: eased toward the latest figure). Reduced motion: the figure itself.
 */
function CountUp({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (motionOff()) {
      shown.current = value;
      el.textContent = String(value);
      return;
    }
    const from = shown.current;
    const t0 = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 1500);
      const e = 1 - (1 - k) * (1 - k);
      shown.current = Math.round(from + (value - from) * e);
      el.textContent = String(shown.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span ref={ref}>{shown.current}</span>;
}

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

  const resultRef = useRef<HTMLDivElement>(null);

  /**
   * C196 (my-design review F7): a ring spreads from the button, the last
   * result lifts away, and the new one shows no sooner than 820ms in — "up to
   * date" as a result line, a new version as a block that drops in with its
   * version number settling.
   */
  async function runCheck(from: Element | null) {
    ping(centreOf(from));
    const old = resultRef.current?.firstElementChild;
    if (old instanceof HTMLElement && !motionOff()) {
      await old
        .animate(
          [
            { opacity: 1, transform: "none" },
            { opacity: 0, transform: "translateY(-8px)" },
          ],
          { duration: 200, easing: "ease-in", fill: "forwards" },
        )
        .finished.catch(() => undefined);
    }
    const t0 = performance.now();
    const settle = async (next: Phase) => {
      if (!motionOff()) await sleep(Math.max(0, RESULT_AT_MS - (performance.now() - t0)));
      setPhase(next);
    };
    setPhase({ kind: "checking" });
    try {
      const pre = await api.updatePreflight();
      if (pre.portable) {
        await settle({ kind: "portable" });
        return;
      }
      const update = await check();
      held.current = update;
      await settle(update ? { kind: "available", update } : { kind: "upToDate" });
    } catch (e) {
      await settle({ kind: "failed", message: errorMessage(e) });
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
    // C197: the count reaches 100 and stays a beat before the next block.
    setPhase({ kind: "downloading", update, done: total ?? done, total: total ?? done });
    if (!motionOff()) await sleep(1040);
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
      const restore = await foldAway();
      try {
        // Windows: the installer takes over and this process exits here.
        await update.install();
        held.current = null;
        // macOS / Linux: the files are replaced; start the new version.
        await api.updateRelaunch();
      } catch (e) {
        restore();
        throw e;
      }
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
          onClick={(e) => void runCheck(e.currentTarget)}
          disabled={["checking", "downloading", "installing", "confirm"].includes(phase.kind)}
        >
          {phase.kind === "checking" ? t("update.checking") : t("update.check")}
        </button>
      </div>

      <div className="ub-result" ref={resultRef}>
      {phase.kind === "upToDate" && <FlashBar message={t("update.upToDate")} />}

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
        <div className="alert alert-info update-box ub-drop">
          <p>
            <strong>
              <AvailableLine version={phase.update.version} />
            </strong>
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

      {phase.kind === "downloading" && <Downloading done={phase.done} total={phase.total} />}

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
        <div className="alert alert-error ub-drop">{t("update.failed", { message: phase.message })}</div>
      )}
      </div>

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

/** "Version X is available", the X settling into place as the block drops in (C196). */
function AvailableLine({ version }: { version: string }) {
  const { t } = useTranslation();
  const [a, b] = splitAroundCount((v) => t("update.available", { version: v }));
  return (
    <>
      {a}
      <Scramble value={version} initial="" durationMs={760} />
      {b}
    </>
  );
}

/**
 * C197 while downloading: the percent counts up, and a bar fills with a light
 * riding its leading edge. Without a size there is no percent and no bar.
 */
function Downloading({ done, total }: { done: number; total: number | null }) {
  const { t } = useTranslation();
  const pct = downloadPercent(done, total);
  if (pct === null) return <div className="alert alert-info">{t("update.downloadingNoSize")}</div>;
  const [a, b] = splitAroundCount((n) => t("update.downloading", { percent: n }));
  return (
    <div className="alert alert-info upd-dl">
      <span>
        {a}
        <CountUp value={pct} />
        {b}
      </span>
      <span className="upd-prog" aria-hidden="true">
        <i style={{ transform: `scaleX(${pct / 100})` }} />
        <b style={{ left: `${pct}%` }} />
      </span>
    </div>
  );
}
