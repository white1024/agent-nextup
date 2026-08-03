import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import { Check, Switch } from "../components/controls";
import { IconCaretDown, IconWarn } from "../components/icons";
import ConfirmDanger from "../components/ConfirmDanger";
import type {
  AgentAccessView,
  AgentMcpStatus,
  AssetStatus,
  AssetsUpgradeOutcome,
  DoctorReport,
} from "../types";

interface Props {
  refreshKey: number;
  /**
   * A write tool the user was sent here to authorize (D63) — set when a
   * denial toast's "go authorize" is clicked. The catalog expands its group,
   * scrolls it into view and marks it, so the jump lands on the switch rather
   * than at the top of a long page.
   */
  focusTool?: string | null;
  /** Called once the focus request has been consumed, so it fires once. */
  onFocusHandled?: () => void;
}

/**
 * Hub tool catalog: what external agents (connected via the workspace's
 * .mcp.json → nextup-mcp) may do. The former MCP *client* server registry was
 * retired in D15 — agents bring their own MCP clients; the core module is
 * kept dormant as groundwork for a possible tool gateway.
 */
export default function Tools({ refreshKey, focusTool, onFocusHandled }: Props) {
  const { t } = useTranslation();
  // Hub sources share one load path so a refresh is all-or-nothing.
  const { data, setData, error, setError } = useWorkspaceData<{
    agentAccess: AgentAccessView;
    mcp: AgentMcpStatus;
    assets: AssetStatus[];
  }>(
    async () => ({
      agentAccess: await api.agentAccessStatus(),
      mcp: await api.agentMcpStatus(),
      assets: await api.workspaceAssetsStatus(),
    }),
    refreshKey,
  );
  const agentAccess = data?.agentAccess ?? null;
  const mcp = data?.mcp ?? null;
  const assets = data?.assets ?? null;
  const { busy: mcpBusy, run: runRepair } = useGuardedMutation(setError);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);
  const { busy: doctorBusy, run: runDoctorScan } = useGuardedMutation(setError);
  const { busy: assetsBusy, run: runAssets } = useGuardedMutation(setError);
  // The agent-access toggles take the gate but not the busy flag: they had no
  // busy state at all, and wiring one now would newly grey out a dozen
  // checkboxes. The gate alone is the part worth having — a second click
  // during the write is dropped instead of racing the first.
  const { run: runAccess } = useGuardedMutation(setError);
  /** Asset path awaiting overwrite confirmation — replaces edited content. */
  const [confirmOverwrite, setConfirmOverwrite] = useState<string | null>(null);
  const [assetsOutcome, setAssetsOutcome] = useState<AssetsUpgradeOutcome | null>(null);
  // Which capability groups have their per-tool "advanced" list open (D39).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** Tool the denial jump landed on: marked until the user acts on it (D63). */
  const [markedTool, setMarkedTool] = useState<string | null>(null);
  /** Set when the jump names a tool this workspace does not expose. */
  const [unexposedTool, setUnexposedTool] = useState<string | null>(null);
  const markedRowRef = useRef<HTMLDivElement | null>(null);

  function toggleGroup(id: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function applyAgentAccess(next: AgentAccessView) {
    setData((d) => (d === null ? d : { ...d, agentAccess: next }));
  }

  // Denial jump (D63): open the group holding the tool and mark it. Waits for
  // the catalog — this view mounts before its fetch resolves, and acting on an
  // empty catalog would drop the request silently.
  useEffect(() => {
    if (!focusTool || agentAccess === null) return;
    const group = agentAccess.writeToolGroups.find((g) => g.tools.includes(focusTool));
    if (group) {
      setExpandedGroups((prev) => new Set(prev).add(group.id));
      setMarkedTool(focusTool);
      setUnexposedTool(null);
    } else {
      // Denied but absent from the catalog: the tool belongs to a module this
      // workspace has switched off, so no switch on this page would help. Say
      // that, rather than landing the jump on a page that never mentions it.
      setMarkedTool(null);
      setUnexposedTool(focusTool);
    }
    onFocusHandled?.();
  }, [focusTool, agentAccess, onFocusHandled]);

  // Scroll once the expansion above has rendered — the row only exists after
  // its group is open, so this cannot run in the same pass.
  useEffect(() => {
    if (markedTool === null) return;
    markedRowRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [markedTool]);

  function repairMcp() {
    return runRepair(async () => {
      setError(null);
      const next = await api.agentMcpRepair();
      setData((d) => (d === null ? d : { ...d, mcp: next }));
    });
  }

  function setAgentEnabled(enabled: boolean) {
    return runAccess(async () => {
      setError(null);
      applyAgentAccess(await api.agentAccessSetEnabled(enabled));
    });
  }

  function setAgentTool(tool: string, allowed: boolean) {
    return runAccess(async () => {
      setError(null);
      applyAgentAccess(await api.agentAccessSetTool(tool, allowed));
    });
  }

  // Group switch (D39): one batch IPC so the allowlist mutates in a single
  // file write; core re-validates every name.
  function setAgentToolGroup(tools: string[], allowed: boolean) {
    return runAccess(async () => {
      setError(null);
      applyAgentAccess(await api.agentAccessSetTools(tools, allowed));
    });
  }

  function setAllAgentTools(allowed: boolean) {
    return runAccess(async () => {
      setError(null);
      applyAgentAccess(await api.agentAccessSetAllTools(allowed));
    });
  }

  function runDoctor() {
    return runDoctorScan(async () => {
      setError(null);
      setDoctor(await api.runDoctor());
    });
  }

  // One IPC for all three asset actions: the plain upgrade button sends no
  // decisions; per-item "keep"/"overwrite" send exactly one path.
  function upgradeAssets(overwrite: string[], keepAsUser: string[]) {
    return runAssets(async () => {
      setError(null);
      setAssetsOutcome(await api.workspaceAssetsUpgrade(overwrite, keepAsUser));
      const fresh = await api.workspaceAssetsStatus();
      setData((d) => (d === null ? d : { ...d, assets: fresh }));
    });
  }

  // "Select all" reflects the write tier: checked when every tool is allowed,
  // indeterminate when only some are, unchecked when none.
  const writeTools = agentAccess?.writeTools ?? [];
  const allowedCount = writeTools.filter((tool) =>
    agentAccess?.access.allowedTools.includes(tool),
  ).length;
  const allWriteAllowed = writeTools.length > 0 && allowedCount === writeTools.length;

  const mcpVariant = mcp === null ? null : mcp.healthy ? "ready" : mcp.resolvedPath ? "repair" : "missing";

  const assetCount = (state: AssetStatus["state"]) =>
    (assets ?? []).filter((a) => a.state === state).length;
  const staleAssets = (assets ?? []).filter((a) => a.state !== "up_to_date");
  const upgradableCount = assetCount("upgrade_safe") + assetCount("missing");
  // Only applies to staleAssets (up_to_date is already excluded), so there
  // are four states here. They used to be squeezed into two classes, which
  // made "missing" and "safe to upgrade" look identical — the colours now
  // split along "does this need your hand / is something broken" (D64).
  const assetPill = (state: AssetStatus["state"]) => {
    switch (state) {
      case "missing":
        return "pill pill-fail";
      case "manual_review":
        return "pill pill-warn";
      case "upgrade_safe":
        return "pill pill-info";
      default:
        return "pill";
    }
  };

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tools.heading")}</h1>
          <p className="view-sub">{t("tools.agentSubtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title">{t("doctor.heading")}</h2>
          <div className="spacer" />
          <button className="btn" disabled={doctorBusy} onClick={() => void runDoctor()}>
            {doctorBusy ? t("doctor.running") : t("doctor.run")}
          </button>
        </div>
        <p className="section-hint">{t("doctor.subtitle")}</p>
        {doctor !== null && (
          <div className="doctor-report">
            <p>
              {doctor.errors === 0 && doctor.warnings === 0 ? (
                <span className="pill pill-pass">
                  <span className="dot" aria-hidden="true" />
                  {t("doctor.clean")}
                </span>
              ) : (
                t("doctor.summary", { e: doctor.errors, w: doctor.warnings })
              )}
              <span className="muted"> · {doctor.checkedAt}</span>
            </p>
            {doctor.findings.length > 0 && (
              <div>
                {doctor.findings.map((f, i) => (
                  <div className="finding" key={i}>
                    <span
                      className={`pill ${f.severity === "error" ? "pill-fail" : "pill-warn"}`}
                    >
                      <span className="dot" aria-hidden="true" />
                      {f.severity}
                    </span>
                    <code>{f.target}</code>
                    <span>{f.message}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {agentAccess !== null && (
        <>
          <div className="agent-master">
            <Switch
              checked={agentAccess.access.enabled}
              onChange={(v) => void setAgentEnabled(v)}
              ariaLabel={t("tools.agentEnabled")}
            />
            <div className="am-body">
              <div className="am-title">{t("tools.agentEnabled")}</div>
              <div className="am-desc">
                {agentAccess.access.enabled
                  ? t("tools.agentMasterOn")
                  : t("tools.agentDisabledHint")}
              </div>
            </div>
          </div>

          {mcp !== null && mcpVariant !== null && (
            <div className={`mcp-card mcp-card--${mcpVariant}`}>
              <div className="mc-top">
                <span
                  className={`pill ${
                    mcpVariant === "ready"
                      ? "pill-pass"
                      : mcpVariant === "repair"
                        ? "pill-warn"
                        : "pill-fail"
                  }`}
                >
                  <span className="dot" aria-hidden="true" />
                  {t(`tools.mcpState_${mcpVariant}`)}
                </span>
                <span className="panel-title">nextup-mcp</span>
              </div>
              {mcpVariant === "ready" && (
                <>
                  <p className="section-hint">{t("tools.mcpReady")}</p>
                  {mcp.discoveryCommand && <div className="mc-path">{mcp.discoveryCommand}</div>}
                </>
              )}
              {mcpVariant === "repair" && (
                <>
                  <p className="section-hint">{t("tools.mcpNeedsRepair")}</p>
                  <div className="mc-path">{mcp.resolvedPath}</div>
                  <button className="btn btn-small" disabled={mcpBusy} onClick={() => void repairMcp()}>
                    {mcpBusy ? t("tools.mcpRepairing") : t("tools.mcpRepair")}
                  </button>
                </>
              )}
              {mcpVariant === "missing" && (
                <p className="section-hint">
                  <IconWarn size={13} /> {t("tools.mcpMissing")}
                </p>
              )}
            </div>
          )}

          {assets !== null && (
            <section className="panel">
              <div className="panel-head">
                <h2 className="panel-title">{t("assets.heading")}</h2>
                <div className="spacer" />
                <button
                  className="btn"
                  disabled={assetsBusy || upgradableCount === 0}
                  onClick={() => void upgradeAssets([], [])}
                >
                  {assetsBusy ? t("assets.upgrading") : t("assets.upgrade")}
                </button>
              </div>
              <p className="section-hint">{t("assets.subtitle")}</p>
              <p className="num">
                {staleAssets.length === 0 ? (
                  <span className="pill pill-pass">
                    <span className="dot" aria-hidden="true" />
                    {t("assets.allFresh")}
                  </span>
                ) : (
                  t("assets.summary", {
                    fresh: assetCount("up_to_date"),
                    safe: assetCount("upgrade_safe"),
                    miss: assetCount("missing"),
                    custom: assetCount("customized"),
                    review: assetCount("manual_review"),
                  })
                )}
              </p>
              {staleAssets.length > 0 && (
                <div className="doctor-report">
                  {staleAssets.map((a) => (
                    <div className="finding" key={a.path}>
                      <span className={assetPill(a.state)}>
                        <span className="dot" aria-hidden="true" />
                        {t(`assets.state_${a.state}`)}
                      </span>
                      <code>{a.path}</code>
                      {a.state === "manual_review" && (
                        <>
                          <button
                            className="btn btn-small"
                            disabled={assetsBusy}
                            onClick={() => void upgradeAssets([], [a.path])}
                          >
                            {t("assets.keep")}
                          </button>
                          <button
                            className="btn btn-small danger-trigger"
                            disabled={assetsBusy}
                            onClick={() => setConfirmOverwrite(a.path)}
                          >
                            {t("assets.overwrite")}
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                  {assetCount("manual_review") > 0 && (
                    <p className="section-hint">{t("assets.reviewHint")}</p>
                  )}
                </div>
              )}
              {assetsOutcome !== null &&
                (assetsOutcome.upgraded.length > 0 || assetsOutcome.added.length > 0) && (
                  <p className="section-hint num">
                    {t("assets.resultLine", {
                      up: assetsOutcome.upgraded.length,
                      added: assetsOutcome.added.length,
                    })}
                    {assetsOutcome.backupDir && (
                      <> {t("assets.resultBackup", { dir: assetsOutcome.backupDir })}</>
                    )}
                  </p>
                )}
            </section>
          )}

          <>
              <section
                className={`panel${agentAccess.access.enabled ? "" : " panel-inactive"}`}
              >
                <div className="panel-head">
                  <h2 className="panel-title">{t("tools.agentWriteTools")}</h2>
                </div>
                {/* The grant model used to be explained in the page subtitle,
                    which made it a 500-character wall every visit. It belongs
                    beside the control it describes (D89). */}
                <p className="section-hint">{t("tools.writeToolsHint")}</p>
                {/* The catalog stays readable with the master switch off: a
                    denial jump often *is* the master switch, and hiding every
                    tool would land the user on a page with nothing on it. */}
                {!agentAccess.access.enabled && (
                  <div className="alert alert-info">{t("tools.agentDisabledStillListed")}</div>
                )}
                {unexposedTool !== null && (
                  <div className="alert alert-info">
                    {t("tools.unexposedTool", { tool: unexposedTool })}
                  </div>
                )}
                <div className="selectall-row">
                  <Check
                    checked={allWriteAllowed}
                    indeterminate={allowedCount > 0 && !allWriteAllowed}
                    onChange={(v) => void setAllAgentTools(v)}
                  >
                    {t("tools.agentSelectAll")}
                  </Check>
                  <span className="section-hint sa-hint num">
                    {t("tools.authorizedCount", { n: allowedCount, total: writeTools.length })}
                  </span>
                </div>
                <ul className="tool-list">
                  {agentAccess.writeToolGroups.map((g) => {
                    const grantedCount = g.tools.filter((tool) =>
                      agentAccess.access.allowedTools.includes(tool),
                    ).length;
                    const expanded = expandedGroups.has(g.id);
                    return (
                      <li key={g.id}>
                        <div className="tool-row">
                          <Check
                            checked={grantedCount === g.tools.length}
                            indeterminate={grantedCount > 0 && grantedCount < g.tools.length}
                            onChange={(v) => void setAgentToolGroup(g.tools, v)}
                            ariaLabel={t(`tools.group_${g.id}`)}
                          >
                            <span className="tg-text">
                              <span className="tg-name">{t(`tools.group_${g.id}`)}</span>
                              <span className="tg-desc">{t(`tools.groupDesc_${g.id}`)}</span>
                            </span>
                          </Check>
                          <span className="section-hint num tg-count">
                            {grantedCount}/{g.tools.length}
                          </span>
                          <button
                            type="button"
                            className="tg-expand"
                            aria-expanded={expanded}
                            onClick={() => toggleGroup(g.id)}
                          >
                            {t("tools.groupAdvanced")}
                            <IconCaretDown size={12} className={expanded ? "caret open" : "caret"} />
                          </button>
                        </div>
                        {expanded && (
                          <ul className="tool-sublist">
                            {g.tools.map((tool) => {
                              const guard = agentAccess.guardedReasons[tool];
                              const marked = markedTool === tool;
                              return (
                                <li key={tool}>
                                  <div
                                    className={`tool-row${marked ? " tool-row--marked" : ""}`}
                                    ref={marked ? markedRowRef : undefined}
                                  >
                                    <Switch
                                      checked={agentAccess.access.allowedTools.includes(tool)}
                                      onChange={(v) => {
                                        // Acting on the tool is what the jump
                                        // was for — drop the marker rather
                                        // than leaving it lit afterwards.
                                        setMarkedTool(null);
                                        void setAgentTool(tool, v);
                                      }}
                                      ariaLabel={tool}
                                    />
                                    <span className="tr-name">{tool}</span>
                                    {guard !== undefined && (
                                      <span className="tr-guard">{t(`tools.guard_${guard}`)}</span>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section
                className={`panel${agentAccess.access.enabled ? "" : " panel-inactive"}`}
              >
                <div className="panel-head">
                  <h2 className="panel-title">{t("tools.agentReadTools")}</h2>
                </div>
                <p className="section-hint">{t("tools.readToolsHint")}</p>
                <ul className="tool-list">
                  {agentAccess.readTools.map((tool) => (
                    <li key={tool}>
                      <div className="tool-row">
                        <span className="tr-name">{tool}</span>
                        <span className="pill pill-pass">
                          <span className="dot" aria-hidden="true" />
                          {t("tools.allowed")}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
          </>
          <p className="path">{t("tools.agentPathHint")}</p>
        </>
      )}
      {confirmOverwrite !== null && (
        <ConfirmDanger
          heading={t("assets.overwriteHeading")}
          body={t("assets.overwriteBody", { path: confirmOverwrite })}
          confirmLabel={t("assets.overwrite")}
          busy={assetsBusy}
          onConfirm={() => {
            void upgradeAssets([confirmOverwrite], []);
            setConfirmOverwrite(null);
          }}
          onCancel={() => setConfirmOverwrite(null)}
        />
      )}

    </div>
  );
}
