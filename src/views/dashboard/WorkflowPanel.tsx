import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { api, errorKind, errorMessage } from "../../api";
import { useGuardedMutation } from "../../hooks";
import EmptyState from "../../components/EmptyState";
import Modal from "../../components/Modal";
import StagedCheck from "../../components/StagedCheck";
import { modeToSend } from "../../lib/workflowMode";
import Scramble from "../../components/Scramble";
import { centreOf, fx, motionOff, tokenRgb } from "../../lib/fx";
import { EASE_OUT } from "../../lib/listMotion";
import { IconArrowRight, IconWarn } from "../../components/icons";
import type { TemplateSummary, WorkflowStatus } from "../../types";
import { useGateLabel } from "../../hooks/gateLabel";
import { daysInPhase, READY_IDLE_DAYS } from "./phaseAge";

interface Props {
  refreshKey: number;
  onMutated: () => void;
  /**
   * Hand the evaluated status up so the action bar can render from it (D66).
   * Reporting rather than lifting state: `evaluate` reads the whole ledger and
   * scans every task file on each call, and it already runs here on every
   * watcher tick — a second caller would double that per tick. `null` covers
   * both "not read yet" and "no harness adopted"; neither is a state the bar
   * has anything to say about.
   */
  onStatus?: (status: WorkflowStatus | null) => void;
  /** The band's right-hand "next step" column (D153; ActionBar). */
  next?: ReactNode;
  /** The page's panels under the exit-gate card, left column. */
  left?: ReactNode;
  /** The page's panels in the right column. */
  right?: ReactNode;
}

/**
 * C252: one tile lights cyan for 560ms as the finishing light passes, from and
 * back to how it already looks (its fill, edge and a soft glow).
 */
function litTile(tile: HTMLElement, delay: number) {
  const g = tokenRgb("--green");
  const now = getComputedStyle(tile);
  const rest = { backgroundColor: now.backgroundColor, borderColor: now.borderColor, boxShadow: `0 0 0 0 rgba(${g},0)` };
  tile.animate(
    [
      rest,
      { backgroundColor: `rgba(${g},.16)`, borderColor: `rgba(${g},.7)`, boxShadow: `0 0 14px rgba(${g},.35)`, offset: 0.3 },
      rest,
    ],
    { duration: 560, delay, easing: "ease-out" },
  );
}

export default function WorkflowPanel({ refreshKey, onMutated, onStatus, next, left, right }: Props) {
  const { t } = useTranslation();
  const gateLabel = useGateLabel();
  const [status, setStatus] = useState<WorkflowStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [adoptId, setAdoptId] = useState("generic-v1");
  const [error, setError] = useState<string | null>(null);
  // The ref gate matters for the `advancePhase` caller specifically: a
  // same-tick double click used to advance two phases at once, which no gate
  // would have stopped because each call passed its own check.
  const { busy, run: runMutation } = useGuardedMutation(setError);
  const [showOverride, setShowOverride] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  // D171 ⑤: stepping back a phase asks once — it clears the phase's manual
  // confirmations and restarts its decision count, which an advance does not
  // give back.
  const [rollbackOpen, setRollbackOpen] = useState(false);
  // The legacy adopt panel's opt-in for phases (D171 ②, review E2).
  const [adoptStaged, setAdoptStaged] = useState(false);

  // Hero/diff animations: stagger gates in after a phase advance, glow a gate
  // that just flipped to passed. Driven by state diffs, not by render — the
  // watcher re-reads views wholesale and must not flash unchanged rows.
  const [staggered, setStaggered] = useState(false);
  const [justPassed, setJustPassed] = useState<Set<number>>(() => new Set());
  // C16: the tile that has just become current lights up.
  const [ignite, setIgnite] = useState(false);
  const bandRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const advRef = useRef<HTMLButtonElement>(null);
  const gatesRef = useRef<HTMLUListElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const forceRef = useRef<HTMLButtonElement>(null);
  /**
   * While a forced advance plays (C213) the watcher's re-reads are not shown:
   * the sequence ends by showing the engine's own answer, and a re-read
   * landing halfway would advance the band before the light gets there.
   */
  const holdUntil = useRef(0);
  /**
   * Where the cards under the band stood before a change that moves them
   * (C252 finishing, C253 adopting) — taken at the click, played once the
   * change has rendered.
   */
  const flipFrom = useRef<{ kind: "finish" | "adopt"; tops: Map<Element, number>; gatesH: number } | null>(null);
  // When the press's particles land on the next tile (C36); the new phase is
  // shown no earlier, so the light arrives where the change happens.
  const landAt = useRef(0);
  const prevRef = useRef<{
    tpl: string;
    phaseId: string;
    index: number;
    completed: boolean;
    passed: boolean[];
  } | null>(null);

  // Custom load (not useWorkspaceData): a missing harness is a distinct
  // "adopt a template" state, not an empty one, and it pulls the template
  // list as a follow-up read.
  const load = useCallback(async () => {
    try {
      const read = await api.workflowStatus();
      if (performance.now() < holdUntil.current) return;
      setStatus(read);
      setMissing(false);
      setError(null);
    } catch (e) {
      if (errorKind(e) === "not_found") {
        setMissing(true);
        setStatus(null);
        setError(null);
        try {
          setTemplates(await api.listTemplates());
        } catch {
          /* template list is only a convenience here */
        }
      } else {
        setError(errorMessage(e));
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  useEffect(() => {
    onStatus?.(status);
  }, [status, onStatus]);

  // When the tiles have run out of room the rail scrolls, and the tile that
  // matters is the current one: bring it into view on arrival and on every
  // advance. Only the rail moves — never the page.
  const curIndex = status?.currentIndex;
  useEffect(() => {
    const strip = railRef.current?.closest<HTMLElement>(".rail-scroll");
    const tile = railRef.current?.querySelector<HTMLElement>(".tile--cur");
    if (!strip || !tile || strip.scrollWidth <= strip.clientWidth) return;
    const s = strip.getBoundingClientRect();
    const r = tile.getBoundingClientRect();
    if (r.left < s.left) strip.scrollLeft += r.left - s.left - 12;
    else if (r.right > s.right) strip.scrollLeft += r.right - s.right + 12;
  }, [curIndex]);

  useEffect(() => {
    if (status === null) return;
    const phase = status.workflow.phases[status.currentIndex];
    const cur = {
      tpl: status.workflow.templateId,
      phaseId: phase?.id ?? "(completed)",
      index: status.currentIndex,
      completed: status.workflow.state.completed,
      passed: status.gates.map((g) => g.passed),
    };
    const prev = prevRef.current;
    prevRef.current = cur;
    if (prev === null || prev.tpl !== cur.tpl) return;

    if (cur.index > prev.index || (cur.completed && !prev.completed)) {
      setStaggered(true);
      setIgnite(true);
      if (cur.completed && !prev.completed) finishLight();
      else arrive();
      const id = window.setTimeout(
        () => {
          setStaggered(false);
          setIgnite(false);
        },
        cur.passed.length * 130 + 1300,
      );
      return () => window.clearTimeout(id);
    }

    if (prev.phaseId === cur.phaseId && prev.passed.length === cur.passed.length) {
      const newly = new Set<number>();
      cur.passed.forEach((p, i) => {
        if (p && !prev.passed[i]) newly.add(i);
      });
      if (newly.size > 0) {
        setJustPassed(newly);
        const marks = gatesRef.current?.querySelectorAll(".gate-item > span:first-child");
        const to = centreOf(advRef.current);
        newly.forEach((i) => fx.particles(centreOf(marks?.[i]), to, { n: 22 }));
        const id = window.setTimeout(() => setJustPassed(new Set()), 900);
        return () => window.clearTimeout(id);
      }
    }
  }, [status]);

  // C252 / C253, after the change has rendered: the cards under the band
  // slide from where they stood; finishing eases the gate card into its
  // "finished" state; adopting builds the band up piece by piece (F21, F22).
  useLayoutEffect(() => {
    const from = flipFrom.current;
    if (from === null || status === null || missing) return;
    flipFrom.current = null;
    if (motionOff()) return;
    for (const [el, top] of from.tops) {
      if (!el.isConnected) continue;
      const dy = top - el.getBoundingClientRect().top;
      if (Math.abs(dy) >= 1) {
        (el as HTMLElement).animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
          duration: from.kind === "adopt" ? 420 : 320,
          delay: from.kind === "adopt" ? 500 : 330,
          easing: EASE_OUT,
          fill: "backwards",
        });
      }
    }
    const gates = document.getElementById("wf-gates");
    if (from.kind === "finish") {
      const h = gates?.getBoundingClientRect().height ?? 0;
      if (gates !== null && from.gatesH > 0 && Math.abs(h - from.gatesH) >= 1) {
        gates.animate([{ height: `${from.gatesH}px` }, { height: `${h}px` }], {
          duration: 320,
          delay: 330,
          easing: EASE_OUT,
          fill: "backwards",
        });
      }
      const done = gates?.querySelector<HTMLElement>(".wf-done");
      done?.animate(
        [
          { opacity: 0, transform: "translateY(10px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 500, delay: 730, easing: EASE_OUT, fill: "backwards" },
      );
      done?.querySelector(".mk-e")?.animate([{ transform: "scale(2.4)" }, { transform: "none" }], {
        duration: 600,
        delay: 850,
        easing: "cubic-bezier(.3,1.45,.5,1)",
        fill: "backwards",
      });
      return;
    }
    // Adopting: the band builds up, the gate card rises, its gates drop in.
    const rise = (el: Element | null | undefined, delay: number, dist = 10, duration = 420) =>
      el?.animate(
        [
          { opacity: 0, transform: `translateY(${dist}px)` },
          { opacity: 1, transform: "none" },
        ],
        { duration, delay, easing: EASE_OUT, fill: "backwards" },
      );
    const band = bandRef.current;
    rise(band?.querySelector(".phase-k"), 580);
    band?.querySelectorAll(".tile").forEach((tile, i) => rise(tile, 540 + i * 80));
    const track = band?.querySelector<HTMLElement>(".rail-track > i");
    if (track) {
      track.animate([{ transform: "scaleX(0)" }, { transform: track.style.transform || "none" }], {
        duration: 760,
        delay: 660,
        easing: EASE_OUT,
        fill: "backwards",
      });
    }
    rise(band?.querySelector(".next"), 840);
    rise(gates, 620, 18, 440);
    setStaggered(true);
    const id = window.setTimeout(() => setStaggered(false), 600 + status.gates.length * 130 + 1300);
    return () => window.clearTimeout(id);
  }, [status, missing]);

  /** C16 / C17 / C36's curtain: the new current tile lights up with a ring of
   *  light, and a curtain of light sweeps down from the band over the page. */
  function arrive() {
    if (motionOff()) return;
    const tile = railRef.current?.querySelector(".tile--cur");
    const c = centreOf(tile);
    fx.ring(c, { dur: 1500 });
    fx.flash(c, { r: 260, dur: 700 });
    const band = bandRef.current?.getBoundingClientRect();
    const main = document.querySelector("main.content")?.getBoundingClientRect();
    if (band === undefined || main === undefined) return;
    const scan = document.createElement("div");
    scan.className = "adv-scan";
    scan.setAttribute("aria-hidden", "true");
    Object.assign(scan.style, { left: `${main.left}px`, width: `${main.width}px`, top: `${band.bottom - 150}px` });
    document.body.appendChild(scan);
    scan
      .animate(
        [
          { transform: "translateY(0)", opacity: 0 },
          { opacity: 1, offset: 0.1 },
          { opacity: 1, offset: 0.85 },
          { transform: `translateY(${Math.max(0, main.bottom - band.bottom)}px)`, opacity: 0 },
        ],
        { duration: 820, delay: 10, easing: "cubic-bezier(.5,0,.3,1)", fill: "both" },
      )
      .finished.then(
        () => scan.remove(),
        () => scan.remove(),
      );
  }

  /**
   * C252 (my-design review F21): the flow is finished. The last tile flashes
   * small and lights up; then a cyan light runs the band from the first tile
   * to the last and each tile lights in turn as it passes; the curtain still
   * sweeps the page.
   */
  function finishLight() {
    if (motionOff()) return;
    const tiles = [...(railRef.current?.querySelectorAll<HTMLElement>(".tile") ?? [])];
    const last = tiles[tiles.length - 1];
    fx.flash(centreOf(last), { r: 170, dur: 640, alpha: 0.55 });
    arrive();
    const first = tiles[0];
    if (first === undefined || last === undefined || tiles.length < 2) return;
    fx.beam(centreOf(first), centreOf(last), { width: 3.2, dur: 760, delay: 180, rgb: tokenRgb("--green") });
    const n = tiles.length - 1;
    tiles.forEach((tile, i) => litTile(tile, 180 + (684 * i) / n));
  }

  /** C14 / C212 / C213 helpers: whether a reason has been written. */
  const armed = overrideReason.trim() !== "";

  // C212: a reason written lights the button — seven thin red lights flow
  // from the reason into it; emptied, one light runs back and the glow goes.
  // On the change only (not on mount, not per keystroke).
  const wasArmed = useRef(armed);
  useEffect(() => {
    if (wasArmed.current === armed) return;
    wasArmed.current = armed;
    if (motionOff()) return;
    const box = reasonRef.current?.getBoundingClientRect();
    const btn = centreOf(forceRef.current);
    if (box === undefined || btn === null) return;
    const corner = { x: box.right - 10, y: box.bottom - 8 };
    const red = tokenRgb("--red");
    if (armed) {
      for (let i = 0; i < 7; i++) {
        fx.beam(corner, btn, {
          width: 1.3 * (0.7 + Math.random() * 0.6),
          bend: (Math.random() - 0.5) * 0.5,
          dur: 450 + Math.random() * 195,
          delay: Math.random() * 220,
          rgb: red,
        });
      }
    } else fx.beam(btn, corner, { width: 1.3, dur: 420, rgb: red });
  }, [armed]);

  /**
   * C213 (my-design review F20): forcing. The engine answers first (the
   * override is in the ledger before anything plays). Then the reason fades
   * and its box flattens into a red line and a point; a red light runs to
   * Recent activity, where the OVERRIDE entry slides in; the press's light
   * flies into the next tile; and the new phase lands when it arrives, as an
   * ordinary advance does (C36).
   */
  function force() {
    const reason = reasonRef.current;
    const btn = forceRef.current;
    return runMutation(async () => {
      setError(null);
      const next = await api.advancePhase(true, overrideReason);
      if (motionOff() || reason === null || btn === null || status === null) {
        setStatus(next);
        setShowOverride(false);
        setOverrideReason("");
        onMutated();
        return;
      }
      holdUntil.current = performance.now() + 2600;
      const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));
      const r = reason.getBoundingClientRect();
      const text = reason.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" });
      const line = document.createElement("div");
      line.className = "force-redline";
      line.setAttribute("aria-hidden", "true");
      Object.assign(line.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      document.body.appendChild(line);
      void line
        .animate(
          [
            { transform: "none", opacity: 0.9 },
            { transform: "scaleY(.04)", opacity: 1, offset: 0.55 },
            { transform: "scale(.02, .04)", opacity: 0 },
          ],
          { duration: 420, delay: 160, easing: "cubic-bezier(.5,0,.6,1)", fill: "both" },
        )
        .finished.catch(() => undefined)
        .then(() => line.remove());
      const recent = document.querySelector("[data-landing=\"recent\"]")?.getBoundingClientRect();
      if (recent !== undefined) {
        fx.beam(
          { x: r.left + r.width / 2, y: r.top + r.height / 2 },
          { x: recent.left + recent.width / 2, y: recent.top + 4 },
          { width: 2.4, dur: 520, delay: 520, rgb: tokenRgb("--red") },
        );
      }
      // The rest of the page re-reads now: the OVERRIDE entry arrives in
      // Recent activity as the light gets there (and slides in red).
      await wait(1000);
      onMutated();
      await wait(500);
      const tiles = railRef.current?.querySelectorAll(".tile");
      const into = tiles?.[status.workflow.state.completed ? 0 : Math.min(status.currentIndex + 1, tiles.length - 1)];
      fx.particles(centreOf(btn), centreOf(into), { n: 40, spread: 1.7, width: 1.7, segs: 6, dur: 760 });
      await wait(820);
      holdUntil.current = 0;
      text.cancel();
      if (status.currentIndex + 1 >= status.totalPhases) captureFlip("finish");
      setStatus(next);
      setShowOverride(false);
      setOverrideReason("");
    });
  }

  /** Where the cards stand now, for a change about to move them (C252, C253). */
  function captureFlip(kind: "finish" | "adopt") {
    if (motionOff()) return;
    const grid = document.querySelector("main.content .db-grid");
    const tops = new Map<Element, number>();
    for (const el of grid?.querySelectorAll(":scope > .db-col > *") ?? []) tops.set(el, el.getBoundingClientRect().top);
    const gatesH = document.getElementById("wf-gates")?.getBoundingClientRect().height ?? 0;
    flipFrom.current = { kind, tops, gatesH };
  }

  /** C36 (variant D): the button gathers and lets go, a burst of light flies into the
   *  next tile, and the new phase lands when the light does. The engine has
   *  answered by then (invariant 4) — only the showing waits. */
  function advance() {
    const btn = advRef.current;
    const tiles = railRef.current?.querySelectorAll(".tile");
    // Finishing has no next tile: the light goes into the last one (C252).
    const nextTile = status === null ? null : (tiles?.[status.currentIndex + 1] ?? tiles?.[status.currentIndex]);
    if (!motionOff() && btn !== null) {
      btn.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(.94)", offset: 0.25 },
          { transform: "scale(.88)", offset: 0.4 },
          { transform: "scale(1.05)", offset: 0.7 },
          { transform: "scale(1)" },
        ],
        { duration: 640, easing: "cubic-bezier(.2,1.25,.4,1)" },
      );
      fx.flash(centreOf(btn), { r: 160, dur: 500 });
      if (nextTile) {
        window.setTimeout(
          () => fx.particles(centreOf(btn), centreOf(nextTile), { n: 46, spread: 1.7, width: 1.7, segs: 6 }),
          60,
        );
      }
      landAt.current = performance.now() + 820;
    } else {
      landAt.current = 0;
    }
    return runMutation(async () => {
      setError(null);
      const next = await api.advancePhase(false);
      const wait = landAt.current - performance.now();
      if (wait > 0) await new Promise((r) => window.setTimeout(r, wait));
      if (next.workflow.state.completed && status?.workflow.state.completed === false) captureFlip("finish");
      setStatus(next);
      setShowOverride(false);
      setOverrideReason("");
      onMutated();
    });
  }

  function run(action: () => Promise<WorkflowStatus>) {
    return runMutation(async () => {
      setError(null);
      setStatus(await action());
      setShowOverride(false);
      setOverrideReason("");
      onMutated();
    });
  }

  // The two columns under the band (D153). The exit-gate card heads the left
  // column; everything else is the page's own.
  const grid = (gatesCard: ReactNode) => (
    <div className="db-grid">
      <div className="db-col">
        {gatesCard}
        {left}
      </div>
      <div className="db-col">{right}</div>
    </div>
  );

  if (missing) {
    return (
      <>
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("workflow.heading")}</h2>
          </div>
          {/* The affordance here is a picker plus a button, which `action` (one
              button) cannot model — so the copy goes through EmptyState and the
              controls stay below it. */}
          <EmptyState title={t("workflow.missing")} hint={t("workflow.missingHint")} />
          <div className="wf-actions">
            <select
              aria-label={t("workflow.templateLabel")}
              value={adoptId}
              onChange={(e) => setAdoptId(e.target.value)}
            >
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name} ({tpl.id})
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                captureFlip("adopt");
                const tpl = templates.find((x) => x.id === adoptId) ?? null;
                void run(() => api.adoptWorkflow(adoptId, modeToSend(adoptStaged, tpl)));
              }}
            >
              {t("workflow.adopt")}
            </button>
          </div>
          <StagedCheck
            staged={adoptStaged}
            onChange={setAdoptStaged}
            template={templates.find((x) => x.id === adoptId) ?? null}
          />
          {error && <div className="alert alert-error">{error}</div>}
        </section>
        {grid(null)}
      </>
    );
  }

  // Not read yet (invariant 10): the band and the gate card hold their place
  // with placeholder bars; "next step" waits for an answer before it says
  // anything.
  if (status === null) {
    return (
      <>
        <section className="panel phase-band phase-band--solo" aria-busy="true">
          <div className="ph-l">
            <div className="phase-k">{t("workflow.heading")}</div>
            <span className="skel-bar skel-bar--rail" />
            <span className="sr-only">{t("common.loading")}</span>
          </div>
        </section>
        {grid(
          <section className="panel" aria-busy="true">
            <div className="panel-head">
              <h2 className="panel-title">{t("workflow.gates")}</h2>
            </div>
            <span className="skel-bar" />
            <span className="skel-bar" />
            <span className="skel-bar skel-bar--short" />
          </section>,
        )}
      </>
    );
  }

  // Ongoing (D171): no phases, no gates, nothing to advance. The band names
  // the mode; the card under it is the instructions an agent works from.
  if (status.workflow.mode === "ongoing") {
    const lines = status.workflow.ongoingInstructions ?? [];
    return (
      <>
        <section className="panel phase-band phase-band--ongoing" ref={bandRef}>
          <div className="ph-l">
            <div className="phase-k">
              <Scramble durationMs={760} value={`${t("workflow.ongoing")} · ${status.workflow.templateName}`} />
              <span className="phase-desc">· {t("workflow.ongoingDesc")}</span>
            </div>
          </div>
          {next}
        </section>
        {grid(
          <section className="panel gates-card" id="wf-gates">
            <div className="panel-head">
              <h2 className="panel-title">
                {t("workflow.ongoingHeading")}
                <span className="sub">{t("workflow.ongoingSub")}</span>
              </h2>
            </div>
            {error && <div className="alert alert-error">{error}</div>}
            <p className="section-hint">{t("workflow.ongoingHint")}</p>
            {lines.length === 0 ? (
              <EmptyState title={t("workflow.ongoingEmpty")} />
            ) : (
              <div className="wf-desc">
                <ul className="instruction-list">
                  {lines.map((line, i) => (
                    <li key={i}>
                      <span className="idx">{i + 1}.</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>,
        )}
      </>
    );
  }

  const { workflow, currentIndex, totalPhases, gates, canAdvance } = status;
  const completed = workflow.state.completed;
  const phase = workflow.phases[currentIndex];
  const isFinal = currentIndex + 1 >= totalPhases;
  const failCount = gates.filter((g) => !g.passed).length;
  // The track fills to the middle of the current tile (to the end once the
  // flow is complete).
  const fill = completed ? 1 : (currentIndex + 0.5) / Math.max(1, workflow.phases.length);
  // How long this phase has been open (D169). An external workspace sat in its
  // first phase for 26 days with the gate passed and no surface said so; a day
  // count is shown once there is one, and turns amber when every gate passes
  // and a week has gone by — the doctor's `phase_ready_idle` threshold.
  const days = completed ? null : daysInPhase(workflow.state.history, workflow.state.currentPhase);
  const readyIdle = days !== null && canAdvance && days >= READY_IDLE_DAYS;

  const band = (
    <section className="panel phase-band" ref={bandRef}>
      <div className="ph-l">
        <div className="phase-k">
          <Scramble
            durationMs={760}
            value={`${
              completed
                ? t("workflow.completed")
                : t("workflow.phaseOf", { n: currentIndex + 1, total: totalPhases })
            } · ${workflow.templateName}`}
          />
          {!completed && phase && phase.description !== "" && (
            <span className="phase-desc">· {phase.description}</span>
          )}
          {days !== null && days >= 1 && (
            <span className={`phase-age${readyIdle ? " phase-age--idle" : ""}`}>
              · {readyIdle ? t("workflow.readyIdleDays", { n: days }) : t("workflow.inPhaseDays", { n: days })}
            </span>
          )}
        </div>
        <div className="rail-scroll">
          <div className="rail-in">
            <div className="rail" ref={railRef}>
              {workflow.phases.map((p, i) => {
                const done = completed || i < currentIndex;
                const current = !completed && i === currentIndex;
                return (
                  <span
                    key={p.id}
                    className={`tile${done ? " tile--done" : ""}${current ? " tile--cur" : ""}${
                      current && ignite ? " tile--ignite" : ""
                    }`}
                    title={p.title}
                    aria-current={current ? "step" : undefined}
                  >
                    <span className="tn" aria-hidden="true">
                      {done ? "✓" : i + 1}
                    </span>
                    {/* C18: the phase that has just become current settles into its name. */}
                    {current ? (
                      <Scramble className="tile-name" value={p.title} durationMs={760} replay={currentIndex} />
                    ) : (
                      <b className="tile-name">{p.title}</b>
                    )}
                    <span className="sr-only">
                      {done
                        ? t("workflow.stepDone")
                        : current
                          ? t("workflow.stepCurrent")
                          : t("workflow.stepFuture")}
                    </span>
                  </span>
                );
              })}
            </div>
            <div className="rail-track" aria-hidden="true">
              <i style={{ transform: `scaleX(${fill})` }} />
            </div>
          </div>
        </div>
      </div>
      {next}
    </section>
  );

  const gatesCard = (
    <section className="panel gates-card" id="wf-gates">
      <div className="panel-head">
        <h2 className="panel-title">
          {t("workflow.gates")}
          <span className="sub">{t("workflow.gatesSub")}</span>
        </h2>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {completed ? (
        <div className="wf-done">
          <span className="mk-e" aria-hidden="true" />
          <div>
            <strong>{t("workflow.completed")}</strong>
            <p>{t("workflow.completedHint")}</p>
            <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => setRollbackOpen(true)}>
              {t("workflow.rollback")}
            </button>
          </div>
        </div>
      ) : (
        phase && (
          <div className="wf-current">
            {gates.length === 0 ? (
              <EmptyState title={t("workflow.noGates")} />
            ) : (
              <ul className="gate-list" ref={gatesRef}>
                {gates.map((g, i) => {
                  // R7 (D153): passed = cyan square; not passed and it is the
                  // user's to do (a manual confirmation) = amber circle; not
                  // passed and the engine will see it on its own = hollow
                  // square. Not passing is not a consequence — no red.
                  const yours = !g.passed && g.gate.kind === "manual_confirm";
                  return (
                    <li
                      key={`${phase.id}-${i}`}
                      className={`gate-item ${g.passed ? "gate-item--pass" : yours ? "gate-item--you" : "gate-item--fail"} ${
                        staggered ? "gate-enter" : ""
                      } ${justPassed.has(i) ? "just-passed" : ""}`}
                      // C19: they drop in as the curtain passes the card.
                      style={staggered ? { animationDelay: `${280 + i * 130}ms` } : undefined}
                    >
                      <span
                        className={g.passed ? "mk-e" : yours ? "mk-y" : "mk-o"}
                        aria-hidden="true"
                      />
                      <span className="gate-body">
                        <span className="gate-name">{gateLabel(g.gate)}</span>
                        <span className="gate-obs">
                          {t("workflow.observed")}
                          <span className="mono">{g.observed}</span>
                        </span>
                      </span>
                      {yours && (
                        <button
                          className="btn btn-small"
                          disabled={busy}
                          onClick={() => {
                            const prompt = (g.gate as { prompt: string }).prompt;
                            void run(() => api.confirmGate(phase.id, prompt));
                          }}
                        >
                          {t("workflow.confirm")}
                        </button>
                      )}
                      {/* C14: a gate that passes settles into its new word
                          (F19); keyed per phase above, so an advance's new
                          gates arrive with their own words, not scrambling. */}
                      <Scramble
                        className="gate-word"
                        durationMs={420}
                        value={g.passed ? t("workflow.gatePass") : yours ? t("workflow.gateYours") : t("workflow.gateFail")}
                      />
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Plain, not primary: the page header keeps the one primary
                (r2 3-3; invariant 17(d)). */}
            <div className="wf-actions">
              {/* A plain button even when ready (invariant 17(d): the header
                  holds the page's primary, and "go advance" in the band is the
                  conditional second). Ready, it charges a ring and breathes a
                  soft light behind it instead (C15). */}
              <button
                ref={advRef}
                className={`btn adv-btn${canAdvance ? " adv-btn--ready" : ""}`}
                disabled={busy || !canAdvance}
                onClick={() => void advance()}
              >
                <i className="adv-aura" aria-hidden="true" />
                <i className="adv-ring" aria-hidden="true" />
                <IconArrowRight size={15} />
                {isFinal ? t("workflow.finish") : t("workflow.advance")}
              </button>
              {!canAdvance && (
                <span className="section-hint">{t("workflow.blockedHint", { n: failCount })}</span>
              )}
              {/* D171 ⑤: the undo for an advance pressed too early — a person's
                  call, with no hub tool behind it. */}
              {currentIndex > 0 && (
                <button className="btn btn-ghost btn-small" disabled={busy} onClick={() => setRollbackOpen(true)}>
                  {t("workflow.rollback")}
                </button>
              )}
            </div>

            {/* Force advance (invariant 7 ③'s compliant variant): a disclosure
                with a mandatory reason, red only on the button that commits. */}
            {!canAdvance && (
              <details
                className="force-box"
                open={showOverride}
                onToggle={(e) => setShowOverride((e.currentTarget as HTMLDetailsElement).open)}
              >
                <summary>{t("workflow.overrideToggle")}</summary>
                <p>{t("workflow.forceHint")}</p>
                <textarea
                  ref={reasonRef}
                  value={overrideReason}
                  rows={2}
                  aria-label={t("workflow.overrideReason")}
                  placeholder={t("workflow.overrideReason")}
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
                <div className="force-actions">
                  {/* C212: armed by a reason — a red glow behind it that
                      breathes until the reason is gone. */}
                  <button
                    ref={forceRef}
                    className={`btn btn-danger${armed ? " force-armed" : ""}`}
                    disabled={busy || !armed}
                    onClick={() => void force()}
                  >
                    <IconWarn size={14} />
                    {t("workflow.overrideButton")}
                  </button>
                </div>
              </details>
            )}

            {phase.aiInstructions.length > 0 && (
              <div className="wf-desc">
                <h4>{t("workflow.aiFor", { phase: phase.title })}</h4>
                <ul className="instruction-list">
                  {phase.aiInstructions.map((line, i) => (
                    <li key={i}>
                      <span className="idx">{i + 1}.</span>
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )
      )}
    </section>
  );

  // The phase a rollback lands in: the previous one, or — finished — the last.
  const backTo = completed ? workflow.phases[workflow.phases.length - 1] : workflow.phases[currentIndex - 1];

  return (
    <>
      {band}
      {grid(gatesCard)}
      {rollbackOpen && backTo && (
        <Modal narrow label={t("workflow.rollbackHeading")} onClose={() => setRollbackOpen(false)}>
          <div className="form">
            <h2 className="form-heading">{t("workflow.rollbackHeading")}</h2>
            <p>
              {completed
                ? t("workflow.rollbackReopenBody", { phase: backTo.title })
                : t("workflow.rollbackBody", { phase: backTo.title })}
            </p>
            <div className="form-actions">
              <button className="btn" onClick={() => setRollbackOpen(false)}>
                {t("common.cancel")}
              </button>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={() => {
                  setRollbackOpen(false);
                  void run(() => api.rollbackPhase());
                }}
              >
                {t("workflow.rollbackConfirm")}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
