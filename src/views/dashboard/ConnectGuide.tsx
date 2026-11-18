import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { motionOff } from "../../lib/fx";
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
 * First-run connect guide (product review §5-1, D63; spec 20 §10).
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
 *
 * Marks follow the design's one-meaning-per-colour rule (D153 R7): a blocked
 * step is the amber round ("waiting on you"); the terminal step has no mark at
 * all — violet means an agent *is* running, and this line is about starting one.
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
  const card = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);

  // The hub is a problem only when it is actually broken. Packaged builds ship
  // the binary beside the app, so "missing" is rare; "repair" is the real case
  // — a workspace cloned from another machine carries that machine's absolute
  // path in its (committed) .mcp.json, and opening it does not rewire.
  const hubBroken = mcp !== null && !mcp.healthy;
  const hubRepairable = hubBroken && mcp.resolvedPath !== null;
  const noGrants = enabled && total > 0 && granted === 0;
  const ready = !hubBroken && enabled && !noGrants;

  // "Fixed": the ready line rises in when it appears after the card was
  // already on screen (a repair that worked), never on the first paint.
  const readyRef = useRef<HTMLParagraphElement>(null);
  const wasReady = useRef(ready);
  useLayoutEffect(() => {
    if (ready && !wasReady.current && readyRef.current && !motionOff()) {
      readyRef.current.animate(
        [
          { opacity: 0, transform: "translateY(18px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 420, easing: "cubic-bezier(.16,1,.3,1)" },
      );
    }
    wasReady.current = ready;
  }, [ready]);

  function dismiss() {
    const el = card.current;
    if (el === null || motionOff()) {
      onDismiss();
      return;
    }
    setLeaving(true);
    const anim = el.animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(12px)" },
      ],
      { duration: 240, easing: "ease-in", fill: "forwards" },
    );
    void anim.finished.catch(() => undefined).then(onDismiss);
  }

  return (
    <div className="connect-guide" ref={card} aria-busy={leaving || undefined}>
      <div className="cg-head">
        <i className="cg-orb" aria-hidden="true" />
        <div className="cg-head-text">
          <span className="cg-title">{t("connect.heading")}</span>
          <p>{t("connect.subtitle")}</p>
        </div>
        <button type="button" className="btn btn-small btn-ghost" onClick={dismiss} disabled={leaving}>
          {t("connect.alreadyDone")}
        </button>
      </div>

      <ul className="cg-steps">
        {hubBroken && (
          <li className="cg-step cg-step--warn">
            <i className="mk-y" aria-hidden="true" />
            <span className="cg-step-text">
              {hubRepairable ? t("connect.hubRepair") : t("connect.hubMissing")}
            </span>
            {hubRepairable && (
              <button type="button" className="btn btn-small" disabled={repairing} onClick={onRepairMcp}>
                {repairing ? t("tools.mcpRepairing") : t("tools.mcpRepair")}
              </button>
            )}
          </li>
        )}

        {!enabled && (
          <li className="cg-step cg-step--warn">
            <i className="mk-y" aria-hidden="true" />
            <span className="cg-step-text">{t("connect.masterOff")}</span>
            <button type="button" className="btn btn-small" onClick={onGoToTools}>
              {t("connect.openCatalog")}
            </button>
          </li>
        )}

        {noGrants && (
          <li className="cg-step cg-step--warn">
            <i className="mk-y" aria-hidden="true" />
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

      {ready && (
        <p className="cg-ready num" ref={readyRef}>
          <i className="mk-e" aria-hidden="true" />
          {t("connect.readyHint", { n: granted, total })}
        </p>
      )}
    </div>
  );
}
