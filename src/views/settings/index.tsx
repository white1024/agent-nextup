import { useState } from "react";
import { useTranslation } from "react-i18next";

import { setLanguage } from "../../i18n";
import { getThemeMode, setThemeMode, type ThemeMode } from "../../theme";
import {
  dismissedTeachingHints,
  restoreTeachingHints,
  setVerifyNudgeEnabled,
  verifyNudgeEnabled,
} from "../../lib/prefs";
import AgentCatalogManager from "./AgentCatalogManager";
import { Check } from "../../components/controls";
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
 * App-level settings (D55): language, theme, agent CLIs and about — all
 * machine-wide, so this page needs no open workspace. Project-scoped settings
 * (modules, backup, close) moved to ProjectSettings, reached from the workspace
 * nav so they no longer sit buried below the machine-wide ones.
 */
export default function Settings({ status, onGoToProjectSettings }: Props) {
  const { t, i18n } = useTranslation();
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
  const [nudge, setNudge] = useState(verifyNudgeEnabled);
  const [hintsOff, setHintsOff] = useState(dismissedTeachingHints);

  return (
    <div className="view">
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

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("settings.general")}</h2>
        </div>
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-title">{t("settings.language")}</div>
          </div>
          <div className="seg">
            <button
              className={i18n.language === "zh-TW" ? "active" : ""}
              onClick={() => setLanguage("zh-TW")}
            >
              繁體中文
            </button>
            <button
              className={i18n.language === "en" ? "active" : ""}
              onClick={() => setLanguage("en")}
            >
              English
            </button>
          </div>
        </div>
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-title">{t("settings.theme")}</div>
            <div className="sr-desc">{t("settings.themeHint")}</div>
          </div>
          <div className="seg">
            {(["light", "dark", "system"] as const).map((mode) => (
              <button
                key={mode}
                className={theme === mode ? "active" : ""}
                onClick={() => {
                  setThemeMode(mode);
                  setTheme(mode);
                }}
              >
                {t(
                  mode === "light"
                    ? "settings.themeLight"
                    : mode === "dark"
                      ? "settings.themeDark"
                      : "settings.themeSystem",
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-title">{t("settings.verifyNudge")}</div>
            <div className="sr-desc">{t("settings.verifyNudgeHint")}</div>
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
            <div className="sr-title">{t("settings.hints")}</div>
            <div className="sr-desc">{t("settings.hintsHint")}</div>
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

      <AgentCatalogManager />

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("settings.about")}</h2>
        </div>
        <div className="settings-row">
          <div className="sr-body">
            <div className="sr-desc">
              Agent NextUp · {t("common.version")} {status.appVersion}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
