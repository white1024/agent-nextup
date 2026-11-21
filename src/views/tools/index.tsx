import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { api } from "../../api";
import { useGuardedMutation, useWorkspaceData } from "../../hooks";
import { Check, Switch } from "../../components/controls";
import { IconCaretDown, IconWarn } from "../../components/icons";
import ConfirmDanger from "../../components/ConfirmDanger";
import ErrorBar from "../../components/ErrorBar";
import Scramble from "../../components/Scramble";
import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import { splitAroundCount } from "../../lib/format";
import { EASE_OUT, rowTops, slideRows } from "../../lib/listMotion";
import { takeMark } from "../../lib/transitions";
import type {
  AgentAccessView,
  AgentMcpStatus,
  AssetStatus,
  AssetsUpgradeOutcome,
  DoctorReport,
} from "../../types";
import HubOrb, { type McpState, type OrbHandle } from "./HubOrb";
import * as mo from "./motion";

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
  /** C238: arrived from the rename notice — bring the shipped assets into view. */
  focusAssets?: boolean;
  onAssetsFocused?: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** The scan stays up at least this long, so a fast check is still seen (C175). */
const MIN_SCAN_MS = 600;

type PillKind = "pass" | "info" | "warn" | "fail" | "plain";

/** A status as a mark and a word (9(a)), no frame of its own (spec 60):
 *  cyan square through, amber circle waiting on you, the warning glyph
 *  broken, a hollow square nothing to do. */
function Pill({ kind, children }: { kind: PillKind; children: ReactNode }) {
  return (
    <span className={`tls-pill is-${kind}`}>
      {kind === "pass" || kind === "info" ? (
        <i className="mk-e" aria-hidden="true" />
      ) : kind === "warn" ? (
        <i className="mk-y" aria-hidden="true" />
      ) : kind === "fail" ? (
        <IconWarn size={12} />
      ) : (
        <i className="mk-o" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

/** Only applies to stale assets (up_to_date is excluded), so four states
 *  here — split along "does this need your hand / is something broken" (D64). */
function assetKind(state: AssetStatus["state"]): PillKind {
  switch (state) {
    case "missing":
      return "fail";
    case "manual_review":
      return "warn";
    case "upgrade_safe":
      return "info";
    default:
      return "plain";
  }
}

const onScreen = (p: Point | null): p is Point =>
  p !== null && p.y > 0 && p.y < window.innerHeight && p.x > 0 && p.x < window.innerWidth;

/**
 * Hub tool catalog: what external agents (connected via the workspace's
 * .mcp.json → nextup-mcp) may do. The former MCP *client* server registry was
 * retired in D15 — agents bring their own MCP clients; the core module is
 * kept dormant as groundwork for a possible tool gateway.
 *
 * D153 (spec 60): the checks and the catalog on the left; on the right a card
 * for the hub itself — the orb, the master switch and nextup-mcp's state —
 * that stays in view while the catalog scrolls.
 */
export default function Tools({ refreshKey, focusTool, onFocusHandled, focusAssets, onAssetsFocused }: Props) {
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
  /** Bumped per finished check, so the report arrives anew each time (C175). */
  const [docRun, setDocRun] = useState(0);
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
  const [resultKey, setResultKey] = useState(0);
  // Which capability groups have their per-tool "advanced" list open (D39).
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** Tool the denial jump landed on: marked until the user acts on it (D63). */
  const [markedTool, setMarkedTool] = useState<string | null>(null);
  /** Set when the jump names a tool this workspace does not expose. */
  const [unexposedTool, setUnexposedTool] = useState<string | null>(null);

  // ── Motion state (each piece set by its own event, never by a read) ─────
  const [markIn, setMarkIn] = useState(false);
  const [markLeave, setMarkLeave] = useState<"hub" | "off" | null>(null);
  const [pinged, setPinged] = useState<string | null>(null);
  const [justOpened, setJustOpened] = useState<string | null>(null);
  const [sweeping, setSweeping] = useState<ReadonlySet<string>>(() => new Set());
  const [swapped, setSwapped] = useState<string | null>(null);
  const [offIn, setOffIn] = useState(false);
  const [offLeaving, setOffLeaving] = useState(false);
  const [mcpIn, setMcpIn] = useState(false);

  const orbRef = useRef<OrbHandle>(null);
  const mainColRef = useRef<HTMLDivElement>(null);
  const assetsRef = useRef<HTMLElement>(null);
  const assetListRef = useRef<HTMLDivElement>(null);
  const rgRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  const afterCommit = useRef<(() => void)[]>([]);
  useLayoutEffect(() => {
    const queue = afterCommit.current;
    if (queue.length === 0) return;
    afterCommit.current = [];
    for (const fn of queue) fn();
  });
  const timers = useRef<number[]>([]);
  const later = (ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  };
  useEffect(
    () => () => {
      for (const id of timers.current) window.clearTimeout(id);
    },
    [],
  );

  const q = (sel: string) => pageRef.current?.querySelector<HTMLElement>(sel) ?? null;
  const groupRow = (id: string) => q(`[data-group="${CSS.escape(id)}"] .tls-gr`);
  const toolRow = (tool: string) => q(`[data-tool="${CSS.escape(tool)}"]`);
  const assetRow = (path: string) => q(`[data-row="${CSS.escape(path)}"]`);

  function addSweep(path: string) {
    setSweeping((cur) => new Set(cur).add(path));
    later(700, () =>
      setSweeping((cur) => {
        const next = new Set(cur);
        next.delete(path);
        return next;
      }),
    );
  }

  function toggleGroup(id: string) {
    const opening = !expandedGroups.has(id);
    if (opening && !motionOff()) {
      setJustOpened(id);
      later(800, () => setJustOpened(null));
    }
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

  // ── C173: the denial jump lands ─────────────────────────────────────────
  //
  // App has already grown the page out of the toast (growTo) and parked the
  // toast's amber circle. Once the catalog is here and the veil has lifted,
  // the circle flies to the tool's group, the group opens, the tool scrolls
  // to the middle and gets its amber frame — and its segment on the orb
  // blinks amber. Waits for the catalog: this view mounts before its fetch
  // resolves, and acting on an empty catalog would drop the request silently.
  useEffect(() => {
    if (!focusTool || agentAccess === null) return;
    const tool = focusTool;
    onFocusHandled?.();
    const dot = takeMark();
    const group = agentAccess.writeToolGroups.find((g) => g.tools.includes(tool));
    if (group === undefined) {
      // Denied but absent from the catalog: the tool belongs to a module this
      // workspace has switched off, so no switch on this page would help. Say
      // that, rather than landing the jump on a page that never mentions it.
      setMarkedTool(null);
      setUnexposedTool(tool);
      mo.popDot(dot);
      return;
    }
    setUnexposedTool(null);
    if (motionOff()) {
      mo.popDot(dot);
      setExpandedGroups((prev) => new Set(prev).add(group.id));
      setMarkedTool(tool);
      afterCommit.current.push(() => toolRow(tool)?.scrollIntoView({ block: "center" }));
      return;
    }
    let tries = 0;
    const start = () => {
      // The page change's veil still up: the landing starts once it lifts.
      if (document.querySelector(".pt-veil") !== null && tries++ < 25) {
        later(80, start);
        return;
      }
      later(260, () => {
        const row = groupRow(group.id);
        const need = !mo.inView(row);
        if (need) mo.scrollTo(row, { ratio: 0.3 });
        const t1 = need ? 420 : 60;
        let t2 = t1;
        later(t1, () => {
          const box = groupRow(group.id)?.querySelector(".box") ?? null;
          mo.flyDot(dot, centreOf(box ?? groupRow(group.id)));
        });
        if (dot !== null) t2 += 560;
        later(t2, () => {
          setPinged(group.id);
          later(700, () => setPinged(null));
          setJustOpened(group.id);
          later(800, () => setJustOpened(null));
          setExpandedGroups((prev) => new Set(prev).add(group.id));
        });
        later(t2 + 260, () => toolRow(tool)?.scrollIntoView({ block: "center", behavior: "smooth" }));
        later(t2 + 680, () => {
          setMarkedTool(tool);
          setMarkIn(true);
          later(1200, () => setMarkIn(false));
          afterCommit.current.push(() => orbRef.current?.flashMark());
        });
      });
    };
    start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTool, agentAccess, onFocusHandled]);

  // ── C238: arrived from the rename notice ────────────────────────────────
  // The rename leaves the shipped guide and protocol saying the old name, so
  // the page brings the assets into view and sweeps the rows it can upgrade.
  useEffect(() => {
    if (!focusAssets || assets === null) return;
    onAssetsFocused?.();
    const panel = assetsRef.current;
    if (motionOff()) {
      if (!mo.inView(panel, 0, 0)) panel?.scrollIntoView({ block: "start" });
      return;
    }
    const paths = assets.filter((a) => a.state === "upgrade_safe" || a.state === "missing").map((a) => a.path);
    later(700, () => {
      if (!mo.inView(assetsRef.current, 16, 0)) mo.scrollTo(assetsRef.current, { offset: 16 });
      paths.forEach((path, k) => later(520 + k * 140, () => addSweep(path)));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusAssets, assets]);

  /** C172: the light leaves the control and the segments light in ring order. */
  function grant(change: () => Promise<AgentAccessView>, from: Element | null, o: { stagger?: number } = {}) {
    return runAccess(async () => {
      setError(null);
      const before = new Set(agentAccess?.access.allowedTools ?? []);
      const pt = centreOf(from);
      const next = await change();
      const after = new Set(next.access.allowedTools);
      const ring = next.writeToolGroups.flatMap((g) => g.tools);
      const lit = ring.filter((tool) => after.has(tool) && !before.has(tool));
      const out = ring.filter((tool) => before.has(tool) && !after.has(tool));
      afterCommit.current.push(() => {
        const orb = orbRef.current;
        if (orb === null) return;
        if (lit.length > 0) {
          const first = lit.map((tool) => orb.segPoint(tool)).find(onScreen) ?? null;
          const flying = pt !== null && first !== null;
          if (flying) fx.beam(pt, first, { dur: 520, bend: 0.2, width: 2.4 });
          orb.play(lit, true, { delay: flying ? 460 : 0, stagger: o.stagger });
        }
        if (out.length > 0) orb.play(out, false);
      });
      applyAgentAccess(next);
    });
  }

  /** Acting on the marked tool is what the jump was for: its amber frame turns
   *  violet and fades when it is switched on, or just fades when it is not. */
  function leaveMark(on: boolean) {
    if (markedTool === null) return;
    if (motionOff()) {
      setMarkedTool(null);
      return;
    }
    setMarkLeave(on ? "hub" : "off");
    later(900, () => {
      setMarkedTool(null);
      setMarkLeave(null);
    });
  }

  function repairMcp() {
    return runRepair(async () => {
      setError(null);
      const next = await api.agentMcpRepair();
      // C178: the broken edge closes and a light walks the cube once before
      // "ready" is drawn (the button keeps saying "repairing" until then).
      const orb = orbRef.current;
      if (next.healthy && mcpVariant === "repair" && orb !== null && !motionOff()) {
        await sleep(orb.mend());
        setMcpIn(true);
        later(700, () => setMcpIn(false));
      }
      setData((d) => (d === null ? d : { ...d, mcp: next }));
    });
  }

  // C174: the "master switch is off" line drops in when it goes off, and
  // lifts away when it comes back on.
  function setAgentEnabled(enabled: boolean) {
    return runAccess(async () => {
      setError(null);
      const next = await api.agentAccessSetEnabled(enabled);
      if (!motionOff()) {
        setOffIn(!enabled);
        if (enabled) {
          setOffLeaving(true);
          later(220, () => setOffLeaving(false));
        }
      }
      applyAgentAccess(next);
    });
  }

  // Grants a restored backup parked (D143): applying them is granting write
  // access on this machine, so it takes this click — never the restore itself.
  // C178: the block lifts away, what follows closes up, and accepted tools
  // fly into the ring one after another.
  function resolveRestored(accept: boolean, from: Element | null) {
    return runAccess(async () => {
      setError(null);
      const block = rgRef.current;
      const before = new Set(agentAccess?.access.allowedTools ?? []);
      const pt = centreOf(from);
      const fade = mo.liftAway(block);
      try {
        const [next] = await Promise.all([api.agentAccessResolveRestored(accept), sleep(fade === null ? 0 : 220)]);
        const tops = mo.followers(block, mainColRef.current);
        const ring = next.writeToolGroups.flatMap((g) => g.tools);
        const lit = ring.filter((tool) => next.access.allowedTools.includes(tool) && !before.has(tool));
        afterCommit.current.push(() => {
          mo.closeUp(tops);
          const orb = orbRef.current;
          if (orb === null || lit.length === 0) return;
          const first = lit.map((tool) => orb.segPoint(tool)).find(onScreen) ?? null;
          const flying = pt !== null && first !== null;
          if (flying) fx.beam(pt, first, { dur: 520, bend: 0.2, width: 2.4 });
          orb.play(lit, true, { delay: flying ? 460 : 0, stagger: 90 });
        });
        applyAgentAccess(next);
      } catch (e) {
        fade?.cancel();
        throw e;
      }
    });
  }

  // C175: a scan line runs over the check while it works; the result drops
  // in, sweeps cyan when all is well, and the findings rise one by one.
  function runDoctor() {
    return runDoctorScan(async () => {
      setError(null);
      const [report] = await Promise.all([api.runDoctor(), sleep(motionOff() ? 0 : MIN_SCAN_MS)]);
      setDoctor(report);
      setDocRun((n) => n + 1);
    });
  }

  /** Lands an upgrade's result: rows that stay slide up into place. A press
   *  that also granted new tools (D172) brings the switches along with it. */
  function settleAssets(outcome: AssetsUpgradeOutcome, fresh: AssetStatus[], access?: AgentAccessView) {
    const list = assetListRef.current;
    const before = rowTops(list);
    afterCommit.current.push(() => slideRows(assetListRef.current, before, { duration: 380, easing: EASE_OUT }));
    setSweeping(new Set());
    setAssetsOutcome(outcome);
    setResultKey((k) => k + 1);
    setData((d) => (d === null ? d : { ...d, assets: fresh, ...(access ? { agentAccess: access } : {}) }));
  }

  // One IPC for all three asset actions: the plain upgrade button sends no
  // decisions; per-item "keep"/"overwrite" send exactly one path.
  // C176: the rows it will take are swept by light one after another and lift
  // away; then the list is redrawn and the result line drops in.
  function upgradeAll() {
    const targets = (assets ?? [])
      .filter((a) => a.state === "upgrade_safe" || a.state === "missing")
      .map((a) => a.path);
    return runAssets(async () => {
      setError(null);
      const motion = !motionOff();
      const fades: Animation[] = [];
      if (motion) {
        targets.forEach((path, k) => {
          later(120 + k * 160, () => addSweep(path));
          later(120 + k * 160 + 420, () => {
            const a = mo.fadeRow(assetRow(path));
            if (a !== null) fades.push(a);
          });
        });
      }
      try {
        const [outcome] = await Promise.all([
          api.workspaceAssetsUpgrade([], []),
          sleep(motion ? 120 + targets.length * 160 + 520 : 0),
        ]);
        // Always re-read the access view: it also carries what is pending.
        const [fresh, access] = await Promise.all([api.workspaceAssetsStatus(), api.agentAccessStatus()]);
        settleAssets(outcome, fresh, access);
      } catch (e) {
        for (const a of fades) a.cancel();
        setSweeping(new Set());
        throw e;
      }
    });
  }

  function overwriteAsset(path: string) {
    return runAssets(async () => {
      setError(null);
      const motion = !motionOff();
      if (motion) addSweep(path);
      try {
        const [outcome] = await Promise.all([api.workspaceAssetsUpgrade([path], []), sleep(motion ? 460 : 0)]);
        settleAssets(outcome, await api.workspaceAssetsStatus());
      } catch (e) {
        setSweeping(new Set());
        throw e;
      }
    });
  }

  /** "Keep": the row turns into "customized" and its mark springs. */
  function keepAsset(path: string) {
    return runAssets(async () => {
      setError(null);
      const outcome = await api.workspaceAssetsUpgrade([], [path]);
      settleAssets(outcome, await api.workspaceAssetsStatus());
      if (!motionOff()) {
        setSwapped(path);
        later(700, () => setSwapped(null));
      }
    });
  }

  // "Select all" reflects the write tier: checked when every tool is allowed,
  // indeterminate when only some are, unchecked when none.
  const writeTools = agentAccess?.writeTools ?? [];
  const allowedSet = new Set(agentAccess?.access.allowedTools ?? []);
  const allowedCount = writeTools.filter((tool) => allowedSet.has(tool)).length;
  const allWriteAllowed = writeTools.length > 0 && allowedCount === writeTools.length;
  const restored = agentAccess?.restoredAccess ?? null;
  // What accepting would actually grant: the parked tools this workspace
  // exposes now. A tool whose module is off is skipped, as select-all skips it.
  const restorable = restored === null ? [] : restored.allowedTools.filter((tool) => writeTools.includes(tool));
  const enabled = agentAccess?.access.enabled ?? false;

  const mcpVariant: McpState | null =
    mcp === null ? null : mcp.healthy ? "ready" : mcp.resolvedPath ? "repair" : "missing";

  const assetCount = (state: AssetStatus["state"]) => (assets ?? []).filter((a) => a.state === state).length;
  const staleAssets = (assets ?? []).filter((a) => a.state !== "up_to_date");
  const upgradableCount = assetCount("upgrade_safe") + assetCount("missing");
  const pendingGrants = agentAccess?.pendingDefaultGrants ?? [];
  const grantedNow = assetsOutcome?.grantedTools ?? [];

  const [countBefore, countAfter] = splitAroundCount((x) =>
    t("tools.authorizedCount", { n: x, total: writeTools.length }),
  );
  const countLine = (big: boolean) => (
    <>
      {countBefore}
      {big ? (
        <b>
          <Scramble value={allowedCount} />
        </b>
      ) : (
        <Scramble value={allowedCount} />
      )}
      {countAfter}
    </>
  );
  const switchOf = (tool: string) => toolRow(tool)?.querySelector(".switch") ?? null;
  const orbMarked = markLeave === null ? markedTool : null;

  return (
    <div className="view tls" ref={pageRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("tools.heading")}</h1>
          <p className="view-sub">{t("tools.agentSubtitle")}</p>
        </div>
      </header>

      <ErrorBar error={error} />

      <div className="tls-body">
        <div className="tls-main" ref={mainColRef}>
          <section className="panel tls-sec tls-doc">
            <div className="tls-ph">
              <h2>{t("doctor.heading")}</h2>
              <button className="btn" disabled={doctorBusy} onClick={() => void runDoctor()}>
                {doctorBusy ? t("doctor.running") : t("doctor.run")}
              </button>
            </div>
            <p className="tls-hint">{t("doctor.subtitle")}</p>
            {doctor !== null && (
              <div className={`tls-rep${docRun > 0 ? " in" : ""}`} key={docRun}>
                <p
                  className={`tls-rep-h${doctor.errors === 0 && doctor.warnings === 0 ? " sweep" : ""}`}
                >
                  {doctor.errors === 0 && doctor.warnings === 0 ? (
                    <Pill kind="pass">{t("doctor.clean")}</Pill>
                  ) : (
                    t("doctor.summary", { e: doctor.errors, w: doctor.warnings })
                  )}
                  <span className="tls-muted"> · {doctor.checkedAt}</span>
                </p>
                {doctor.findings.length > 0 && (
                  <div className="tls-fs">
                    {doctor.findings.map((f, k) => {
                      const style: Record<string, number> = { "--k": Math.min(k, 12) };
                      return (
                        <div className="tls-f" key={k} style={style}>
                          <Pill kind={f.severity === "error" ? "fail" : "warn"}>{f.severity}</Pill>
                          <code>{f.target}</code>
                          <span className="tls-msg">{f.message}</span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            {doctorBusy && <i className="tls-scan" aria-hidden="true" />}
          </section>

          {agentAccess !== null && assets !== null && (
            <section className="panel tls-sec tls-as" ref={assetsRef}>
              <div className="tls-ph">
                <h2>{t("assets.heading")}</h2>
                <button
                  className="btn"
                  disabled={assetsBusy || (upgradableCount === 0 && pendingGrants.length === 0)}
                  onClick={() => void upgradeAll()}
                >
                  {assetsBusy ? t("assets.upgrading") : t("assets.upgrade")}
                </button>
              </div>
              <p className="tls-hint">{t("assets.subtitle")}</p>
              <p className="tls-sum">
                {staleAssets.length === 0 ? (
                  <Pill kind="pass">{t("assets.allFresh")}</Pill>
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
              {pendingGrants.length > 0 && (
                <p className="tls-hint" data-pending-grants>
                  {t("assets.pendingGrants", { n: pendingGrants.length, tools: pendingGrants.join(", ") })}
                </p>
              )}
              {staleAssets.length > 0 && (
                <div className="tls-fs" ref={assetListRef}>
                  {staleAssets.map((a) => (
                    <div
                      className={`tls-f tls-ar${sweeping.has(a.path) ? " sweep" : ""}${
                        swapped === a.path ? " swap" : ""
                      }`}
                      key={a.path}
                      data-row={a.path}
                    >
                      <Pill kind={assetKind(a.state)}>{t(`assets.state_${a.state}`)}</Pill>
                      <code>{a.path}</code>
                      {a.state === "manual_review" && (
                        <span className="tls-ar-acts">
                          <button
                            className="btn btn-small"
                            disabled={assetsBusy}
                            onClick={() => void keepAsset(a.path)}
                          >
                            {t("assets.keep")}
                          </button>
                          {/* Overwriting edited content is invariant 7's first
                              tier: the entry stays quiet (red on hover) and
                              only the dialog's own button is solid red. */}
                          <button
                            className="btn btn-small danger-trigger"
                            disabled={assetsBusy}
                            onClick={() => setConfirmOverwrite(a.path)}
                          >
                            {t("assets.overwrite")}
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                  {assetCount("manual_review") > 0 && <p className="tls-hint">{t("assets.reviewHint")}</p>}
                </div>
              )}
              {assetsOutcome !== null &&
                (assetsOutcome.upgraded.length > 0 || assetsOutcome.added.length > 0 || grantedNow.length > 0) && (
                  <p className={`tls-result${resultKey > 0 ? " in" : ""}`} key={resultKey}>
                    {(assetsOutcome.upgraded.length > 0 || assetsOutcome.added.length > 0) && (
                      <>
                        {t("assets.resultLine", {
                          up: assetsOutcome.upgraded.length,
                          added: assetsOutcome.added.length,
                        })}
                        {assetsOutcome.backupDir && <> {t("assets.resultBackup", { dir: assetsOutcome.backupDir })}</>}{" "}
                      </>
                    )}
                    {grantedNow.length > 0 &&
                      t("assets.resultGranted", { n: grantedNow.length, tools: grantedNow.join(", ") })}
                  </p>
                )}
            </section>
          )}

          {agentAccess !== null && (
            <>
              <section className={`panel tls-sec tls-wp${enabled ? "" : " is-inactive"}`}>
                <div className="tls-ph">
                  <h2>{t("tools.agentWriteTools")}</h2>
                </div>
                {/* The grant model used to be explained in the page subtitle,
                    which made it a 500-character wall every visit. It belongs
                    beside the control it describes (D89). */}
                <p className="tls-hint">{t("tools.writeToolsHint")}</p>
                {/* The catalog stays readable with the master switch off: a
                    denial jump often *is* the master switch, and hiding every
                    tool would land the user on a page with nothing on it. */}
                {(!enabled || offLeaving) && (
                  <div className={`tls-alert${offIn && !enabled ? " in" : ""}${offLeaving ? " out" : ""}`}>
                    {t("tools.agentDisabledStillListed")}
                  </div>
                )}
                {unexposedTool !== null && (
                  <div className="tls-alert">{t("tools.unexposedTool", { tool: unexposedTool })}</div>
                )}
                {restored !== null && (
                  <div className="tls-alert tls-rg" ref={rgRef}>
                    <p>
                      {t("tools.restoredGrants", {
                        date: restored.exportedAt.slice(0, 10),
                        n: restored.allowedTools.length,
                      })}
                      {restorable.length < restored.allowedTools.length &&
                        ` ${t("tools.restoredSomeHidden", { m: restored.allowedTools.length - restorable.length })}`}
                    </p>
                    {restorable.length > 0 && (
                      <div className="tls-rg-tools">
                        {restorable.map((tool) => (
                          <code key={tool}>{tool}</code>
                        ))}
                      </div>
                    )}
                    <div className="tls-rg-acts">
                      {restorable.length > 0 && (
                        <button
                          className="btn btn-small btn-primary"
                          onClick={(e) => void resolveRestored(true, e.currentTarget)}
                        >
                          {t("tools.restoredAccept", { n: restorable.length })}
                        </button>
                      )}
                      <button className="btn btn-small" onClick={(e) => void resolveRestored(false, e.currentTarget)}>
                        {t("tools.restoredDrop")}
                      </button>
                    </div>
                  </div>
                )}
                <div className="tls-sa">
                  <Check
                    checked={allWriteAllowed}
                    indeterminate={allowedCount > 0 && !allWriteAllowed}
                    onChange={(v) => {
                      if (markedTool !== null) leaveMark(v);
                      void grant(() => api.agentAccessSetAllTools(v), q(".tls-sa .box"));
                    }}
                  >
                    {t("tools.agentSelectAll")}
                  </Check>
                  <span className="tls-hint tls-sa-n">{countLine(false)}</span>
                </div>
                <ul className="tls-groups">
                  {agentAccess.writeToolGroups.map((g) => {
                    const grantedCount = g.tools.filter((tool) => allowedSet.has(tool)).length;
                    const expanded = expandedGroups.has(g.id);
                    return (
                      <li key={g.id} data-group={g.id}>
                        <div className={`tls-gr${pinged === g.id ? " ping" : ""}`}>
                          <Check
                            checked={grantedCount === g.tools.length}
                            indeterminate={grantedCount > 0 && grantedCount < g.tools.length}
                            onChange={(v) => {
                              if (markedTool !== null && g.tools.includes(markedTool)) leaveMark(v);
                              void grant(
                                () => api.agentAccessSetTools(g.tools, v),
                                groupRow(g.id)?.querySelector(".box") ?? null,
                              );
                            }}
                            ariaLabel={t(`tools.group_${g.id}`)}
                          >
                            <span className="tls-gt">
                              <b>{t(`tools.group_${g.id}`)}</b>
                              <small>{t(`tools.groupDesc_${g.id}`)}</small>
                            </span>
                          </Check>
                          <span className="tls-gn">
                            <Scramble value={grantedCount} />/{g.tools.length}
                          </span>
                          <button
                            type="button"
                            className="tls-gx"
                            aria-expanded={expanded}
                            onClick={() => toggleGroup(g.id)}
                          >
                            {t("tools.groupAdvanced")}
                            <IconCaretDown size={12} className="i" />
                          </button>
                        </div>
                        {expanded && (
                          <ul className="tls-tools">
                            {g.tools.map((tool, k) => {
                              const guard = agentAccess.guardedReasons[tool];
                              const marked = markedTool === tool;
                              const style: Record<string, number> = { "--k": k };
                              return (
                                <li key={tool} className={justOpened === g.id ? "in" : undefined} style={style}>
                                  <div
                                    className={`tls-tr${marked ? " is-mark" : ""}${marked && markIn ? " in" : ""}${
                                      marked && markLeave !== null ? ` to-${markLeave}` : ""
                                    }`}
                                    data-tool={tool}
                                  >
                                    <Switch
                                      checked={allowedSet.has(tool)}
                                      onChange={(v) => {
                                        // Acting on the tool is what the jump
                                        // was for — drop the marker rather
                                        // than leaving it lit afterwards.
                                        if (marked) leaveMark(v);
                                        void grant(() => api.agentAccessSetTool(tool, v), switchOf(tool));
                                      }}
                                      ariaLabel={tool}
                                    />
                                    <span className="tls-tn mono">{tool}</span>
                                    {guard !== undefined && (
                                      <span className="tls-guard">{t(`tools.guard_${guard}`)}</span>
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

              <section className={`panel tls-sec tls-rp${enabled ? "" : " is-inactive"}`}>
                <div className="tls-ph">
                  <h2>{t("tools.agentReadTools")}</h2>
                </div>
                <p className="tls-hint">{t("tools.readToolsHint")}</p>
                <ul className="tls-reads">
                  {agentAccess.readTools.map((tool) => (
                    <li key={tool}>
                      <span className="tls-tn mono">{tool}</span>
                      <Pill kind="pass">{t("tools.allowed")}</Pill>
                    </li>
                  ))}
                </ul>
              </section>
              <p className="tls-foot">{t("tools.agentPathHint")}</p>
            </>
          )}
        </div>

        {agentAccess !== null && mcp !== null && mcpVariant !== null && (
          <aside className="panel tls-hub" aria-label="nextup-mcp">
            <HubOrb
              ref={orbRef}
              groups={agentAccess.writeToolGroups}
              allowed={allowedSet}
              reads={agentAccess.readTools}
              enabled={enabled}
              mcp={mcpVariant}
              marked={orbMarked}
              label={t("tools.authorizedCount", { n: allowedCount, total: writeTools.length })}
            />
            <p className="tls-count">{countLine(true)}</p>
            <div className="tls-master">
              <Switch
                checked={enabled}
                onChange={(v) => void setAgentEnabled(v)}
                ariaLabel={t("tools.agentEnabled")}
              />
              <div className="tls-master-b">
                <b>{t("tools.agentEnabled")}</b>
                <span>{enabled ? t("tools.agentMasterOn") : t("tools.agentDisabledHint")}</span>
              </div>
            </div>
            <div className={`tls-mcp is-${mcpVariant}${mcpIn ? " in" : ""}`}>
              <div className="tls-mcp-h">
                <Pill kind={mcpVariant === "ready" ? "pass" : mcpVariant === "repair" ? "warn" : "fail"}>
                  {t(`tools.mcpState_${mcpVariant}`)}
                </Pill>
                <b className="mono">nextup-mcp</b>
              </div>
              {mcpVariant === "ready" && (
                <>
                  <p className="tls-hint">{t("tools.mcpReady")}</p>
                  {mcp.discoveryCommand && <div className="tls-path">{mcp.discoveryCommand}</div>}
                </>
              )}
              {mcpVariant === "repair" && (
                <>
                  <p className="tls-hint">{t("tools.mcpNeedsRepair")}</p>
                  <div className="tls-path">{mcp.resolvedPath}</div>
                  <button className="btn btn-small" disabled={mcpBusy} onClick={() => void repairMcp()}>
                    {mcpBusy ? t("tools.mcpRepairing") : t("tools.mcpRepair")}
                  </button>
                </>
              )}
              {mcpVariant === "missing" && (
                <p className="tls-hint tls-miss">
                  <IconWarn size={13} className="i" />
                  <span>{t("tools.mcpMissing")}</span>
                </p>
              )}
            </div>
          </aside>
        )}
      </div>

      {confirmOverwrite !== null && (
        <ConfirmDanger
          heading={t("assets.overwriteHeading")}
          body={t("assets.overwriteBody", { path: confirmOverwrite })}
          confirmLabel={t("assets.overwrite")}
          busy={assetsBusy}
          onConfirm={() => {
            void overwriteAsset(confirmOverwrite);
            setConfirmOverwrite(null);
          }}
          onCancel={() => setConfirmOverwrite(null)}
        />
      )}
    </div>
  );
}
