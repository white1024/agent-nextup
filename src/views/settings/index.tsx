import { useState } from "react";
import { useTranslation } from "react-i18next";

import { setLanguage } from "../../i18n";
import { getThemeMode, setThemeMode, type ThemeMode } from "../../theme";
import { getZoom, setZoom, ZOOM_STEPS } from "../../zoom";
import {
  dismissedTeachingHints,
  restoreTeachingHints,
  setTeamSkin,
  setVerifyNudgeEnabled,
  teamSkin,
  verifyNudgeEnabled,
  type TeamSkin,
} from "../../lib/prefs";
import { centreOf, fx, motionOff } from "../../lib/fx";
import { scrambleTree } from "../../lib/scramble";
import AgentCatalogManager from "./AgentCatalogManager";
import UpdateSection from "./UpdateSection";
import { Check } from "../../components/controls";
import InfoTip from "../../components/InfoTip";
import Segmented from "../../components/Segmented";
import type { SystemStatus } from "../../types";

interface Props {
  status: SystemStatus;
  /**
   * Jump to the workspace-scoped settings page. Undefined when no workspace is
   * open — the cross-link then has nowhere to go and is not rendered (product review §5-10:
   * the split by scope is right, but it has to be guessable).
   */
  onGoToProjectSettings?: () => void;
}

/**
 * C191: a new theme arrives as a ring of light spreading from the option that
 * was picked, while the page cross-fades into it. The cross-fade is a View
 * Transition where the engine has one; without it, or under reduced motion,
 * the theme simply switches.
 */
function switchTheme(from: Element | null, apply: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (motionOff() || typeof doc.startViewTransition !== "function") {
    apply();
    return;
  }
  doc.startViewTransition(apply);
  window.setTimeout(() => fx.ring(centreOf(from), { dur: 900 }), 60);
}

/**
 * C192 (my-design review F7): another zoom step. Four corner marks — a
 * viewfinder — open outwards for larger or close in for smaller, while the
 * screen dims to 16% and comes back; the new size is applied at the darkest
 * moment, so the jump itself is never seen. Reduced motion: just the size.
 */
function zoomWithFrame(to: number, from: number, apply: () => void) {
  const shell = document.querySelector<HTMLElement>(".shell");
  if (motionOff() || to === from || shell === null) {
    apply();
    return;
  }
  const out = to > from ? -1 : 1;
  const vf = document.createElement("div");
  vf.className = "zoom-vf";
  vf.setAttribute("aria-hidden", "true");
  const corners: [string, number, number][] = [
    ["tl", 1, 1],
    ["tr", -1, 1],
    ["bl", 1, -1],
    ["br", -1, -1],
  ];
  for (const [c, sx, sy] of corners) {
    const i = document.createElement("i");
    i.dataset.c = c;
    vf.appendChild(i);
    const d = 36 * out;
    i.animate([{ transform: "none" }, { transform: `translate(${sx * d}px, ${sy * d}px)` }], {
      duration: 440,
      easing: "cubic-bezier(.3,.7,.2,1)",
      fill: "forwards",
    });
  }
  document.body.appendChild(vf);
  void vf
    .animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1060 })
    .finished.catch(() => undefined)
    .then(() => vf.remove());
  shell.animate([{ opacity: 1 }, { opacity: 0.16 }, { opacity: 1 }], { duration: 460, delay: 420, easing: "ease-in-out" });
  window.setTimeout(apply, 620);
}

/**
 * C193 (F7): another language. The words change, then the screen settles
 * into them region by region from the top (each region 520ms, starting
 * 0–480ms later the further down it is); the layout does not move. Reduced
 * motion: the words just change.
 */
function switchLanguage(lang: "zh-TW" | "en") {
  setLanguage(lang);
  requestAnimationFrame(() => scrambleTree(document.querySelector(".shell")));
}

/**
 * App-level settings (D55): language, theme, agent CLIs and about — all
 * machine-wide, so this page needs no open workspace. Project-scoped settings
 * (modules, backup, close) moved to ProjectSettings, reached from the workspace
 * nav so they no longer sit buried below the machine-wide ones.
 *
 * D153 lays it out in two columns (General | Agent CLI and About; one column
 * when the content area is narrow) and puts each row's teaching copy behind an
 * ⓘ. The rule-type warning about environment variables stays on screen
 * (invariant 17(c)).
 */
export default function Settings({ status, onGoToProjectSettings }: Props) {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
  const [zoom, setZoomState] = useState<number>(getZoom);
  const [skin, setSkin] = useState<TeamSkin>(teamSkin);
  const [nudge, setNudge] = useState(verifyNudgeEnabled);
  const [hintsOff, setHintsOff] = useState(dismissedTeachingHints);

  return (
    <div className="view view--wide">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("settings.heading")}</h1>
          <p className="view-sub">{t("settings.subtitle")}</p>
        </div>
      </header>

      {onGoToProjectSettings && (
        <p className="scope-hint">
          {t("settings.lookingForProject")}{" "}
          <button className="btn-link" onClick={onGoToProjectSettings}>
            {t("settings.projectHeading")}
          </button>
        </p>
      )}

      <div className="settings-cols">
        <div className="settings-col">
          <section className="panel settings-sec">
            <div className="panel-head">
              <h2 className="panel-title">{t("settings.general")}</h2>
            </div>
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">{t("settings.language")}</div>
              </div>
              <Segmented
                label={t("settings.language")}
                value={i18n.language === "en" ? "en" : "zh-TW"}
                options={[
                  { value: "zh-TW", label: "繁體中文" },
                  { value: "en", label: "English" },
                ]}
                onChange={(lang) => switchLanguage(lang)}
              />
            </div>
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">
                  {t("settings.theme")}
                  <InfoTip label={t("common.moreInfo")}>{t("settings.themeHint")}</InfoTip>
                </div>
              </div>
              <Segmented<ThemeMode>
                label={t("settings.theme")}
                value={theme}
                options={[
                  { value: "light", label: t("settings.themeLight") },
                  { value: "dark", label: t("settings.themeDark") },
                  { value: "system", label: t("settings.themeSystem") },
                ]}
                onChange={(mode) => {
                  const picked = document.activeElement;
                  setTheme(mode);
                  switchTheme(picked, () => setThemeMode(mode));
                }}
              />
            </div>
            {/* D157: how the teams pages are drawn. Both styles show the same
                teams and do the same things; each keeps its own node positions. */}
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">
                  {t("settings.teamSkin")}
                  <InfoTip label={t("common.moreInfo")}>{t("settings.teamSkinHint")}</InfoTip>
                </div>
              </div>
              <Segmented<TeamSkin>
                label={t("settings.teamSkin")}
                value={skin}
                options={[
                  { value: "star", label: t("settings.teamSkinStar") },
                  { value: "orbit", label: t("settings.teamSkinOrbit") },
                ]}
                onChange={(next) => {
                  setTeamSkin(next);
                  setSkin(next);
                }}
              />
            </div>
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">
                  {t("settings.zoom")}
                  <InfoTip label={t("common.moreInfo")}>{t("settings.zoomHint")}</InfoTip>
                </div>
              </div>
              <Segmented<number>
                label={t("settings.zoom")}
                className="seg--wrap"
                value={zoom}
                options={ZOOM_STEPS.map((step) => ({ value: step, label: `${Math.round(step * 100)}%` }))}
                onChange={(step) => {
                  setZoomState(step);
                  zoomWithFrame(step, zoom, () => setZoom(step));
                }}
              />
            </div>
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">
                  {t("settings.verifyNudge")}
                  <InfoTip label={t("common.moreInfo")}>{t("settings.verifyNudgeHint")}</InfoTip>
                </div>
              </div>
              <Check
                checked={nudge}
                onChange={(on) => {
                  setVerifyNudgeEnabled(on);
                  setNudge(on);
                }}
              >
                {t("settings.verifyNudgeOn")}
              </Check>
            </div>
            {/* The way back from every "put this away" (r2 2-3). Disabled rather
                than hidden when nothing has been dismissed: someone looking for
                where dismissed hints went needs to find the answer, not an empty
                space where it would have been. */}
            <div className="settings-row">
              <div className="sr-body">
                <div className="sr-title">
                  {t("settings.hints")}
                  <InfoTip label={t("common.moreInfo")}>{t("settings.hintsHint")}</InfoTip>
                </div>
              </div>
              <button
                className="btn"
                disabled={hintsOff === 0}
                onClick={() => {
                  restoreTeachingHints();
                  setHintsOff(0);
                }}
              >
                {hintsOff === 0 ? t("settings.hintsNone") : t("settings.hintsRestore", { n: hintsOff })}
              </button>
            </div>
          </section>
        </div>

        <div className="settings-col">
          <AgentCatalogManager />

          <section className="panel settings-sec">
            <div className="panel-head">
              <h2 className="panel-title">{t("settings.about")}</h2>
            </div>
            <UpdateSection currentVersion={status.appVersion} />
          </section>
        </div>
      </div>
    </div>
  );
}
