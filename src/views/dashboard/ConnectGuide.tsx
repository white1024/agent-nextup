import { useTranslation } from "react-i18next";

import { IconWarn } from "../../components/icons";
import type { AgentMcpStatus } from "../../types";

interface Props {
  /** Hub binary / discovery probe, or null while it is still loading. */
  mcp: AgentMcpStatus | null;
  /** Exposed write tools currently granted, and how many there are. */
  granted: number;
  total: number;
  /** Master switch — off means no agent can call in whatever is granted. */
  enabled: boolean;
  /** Whether a terminal is running in this workspace right now. */
  terminalRunning: boolean;
  onGoToTools: () => void;
  onGoToTerminal: () => void;
  onRepairMcp: () => void;
  repairing: boolean;
  /** "It is already connected" — retires the card for this workspace. */
  onDismiss: () => void;
}

/**
 * First-run connect guide (product review §5-1, D63).
 *
 * Getting an agent onto a project spans three places — the hub binary, the
 * tool catalog, the terminal — and nothing used to say which of them was still
 * missing. This says it in one card on the dashboard, and disappears for good
 * the moment an agent actually calls the hub (`markConnected`), so it is a
 * first-day card rather than permanent furniture.
 *
 * It is deliberately *not* a wizard with three ticks. Two of the three steps
 * are now green before the user arrives: the hub ships with the app and the
 * day-one grant (D63) authorizes the everyday tools at init. A checklist whose
 * boxes are pre-ticked teaches nothing — so the steps that are fine stay quiet
 * and only what actually blocks the user gets a line and a button.
 */
export default function ConnectGuide({
  mcp,
  granted,
  total,
  enabled,
  terminalRunning,
  onGoToTools,
  onGoToTerminal,
  onRepairMcp,
  repairing,
  onDismiss,
}: Props) {
  const { t } = useTranslation();

  // The hub is a problem only when it is actually broken. Packaged builds ship
  // the binary beside the app, so "missing" is rare; "repair" is the real case
  // — a workspace cloned from another machine carries that machine's absolute
  // path in its (committed) .mcp.json, and opening it does not rewire.
  const hubBroken = mcp !== null && !mcp.healthy;
  const hubRepairable = hubBroken && mcp.resolvedPath !== null;
  const noGrants = enabled && total > 0 && granted === 0;

  return (
    <div className="connect-guide">
      <div className="cg-head">
        <span className="cg-title">{t("connect.heading")}</span>
        <div className="spacer" />
        <button type="button" className="btn btn-small btn-ghost" onClick={onDismiss}>
          {t("connect.alreadyDone")}
        </button>
      </div>
      <p className="section-hint">{t("connect.subtitle")}</p>

      <ul className="cg-steps">
        {hubBroken && (
          <li className="cg-step cg-step--warn">
            <IconWarn size={13} />
            <span className="cg-step-text">
              {hubRepairable ? t("connect.hubRepair") : t("connect.hubMissing")}
            </span>
            {hubRepairable && (
              <button
                type="button"
                className="btn btn-small"
                disabled={repairing}
                onClick={onRepairMcp}
              >
                {repairing ? t("tools.mcpRepairing") : t("tools.mcpRepair")}
              </button>
            )}
          </li>
        )}

        {!enabled && (
          <li className="cg-step cg-step--warn">
            <IconWarn size={13} />
            <span className="cg-step-text">{t("connect.masterOff")}</span>
            <button type="button" className="btn btn-small" onClick={onGoToTools}>
              {t("connect.openCatalog")}
            </button>
          </li>
        )}

        {noGrants && (
          <li className="cg-step cg-step--warn">
            <IconWarn size={13} />
            <span className="cg-step-text">{t("connect.noGrants")}</span>
            <button type="button" className="btn btn-small" onClick={onGoToTools}>
              {t("connect.openCatalog")}
            </button>
          </li>
        )}

        {/* The step that is genuinely left for almost everyone. */}
        <li className="cg-step">
          <span className="cg-step-text">
            {terminalRunning ? t("connect.terminalWaiting") : t("connect.launchTerminal")}
          </span>
          <button type="button" className="btn btn-small btn-primary" onClick={onGoToTerminal}>
            {terminalRunning ? t("connect.openTerminal") : t("connect.startTerminal")}
          </button>
        </li>
      </ul>

      {!hubBroken && enabled && !noGrants && (
        <p className="section-hint num">{t("connect.readyHint", { n: granted, total })}</p>
      )}
    </div>
  );
}
