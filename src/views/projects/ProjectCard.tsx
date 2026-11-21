import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Scramble from "../../components/Scramble";
import TimeAgo from "../../components/TimeAgo";
import PathLabel from "../../components/PathLabel";
import { IconWarn, IconX } from "../../components/icons";
import { lightTheme, motionOff, tokenRgb } from "../../lib/fx";
import { shownDomain } from "../../lib/domain";
import type { TaskCounts } from "../../types";
import { CELLS_MAX, cellsOf, changedCells, progressOf, type CellKind } from "./overviewModel";

/** What a card draws — a registry row, or the wizard's "this is what it will be". */
export interface CardData {
  root: string;
  name: string;
  domain: string;
  templateName?: string | null;
  exists: boolean;
  taskCounts?: TaskCounts | null;
  phaseIndex?: number | null;
  phaseCount?: number | null;
  phaseTitle?: string | null;
  workflowCompleted: boolean;
  /** Runs ongoing (D171): no position to show, just the mode. */
  ongoing?: boolean;
  /** Last opened, or the last agent call when that is newer. */
  at?: string;
}

const GAUGE_C = 2 * Math.PI * 24;

interface Props {
  data: CardData;
  /** Live on the overview; a still picture inside a wizard (no tilt, no clicks). */
  preview?: boolean;
  /** Entry stagger. */
  index?: number;
  running?: boolean;
  /** "Claude Code · design awaiting your authorization", one per waiting session. */
  waiting?: string[];
  /** Agent calls to spike the waveform with (ms since epoch). */
  waveEvents?: number[];
  /** Bumped when a call lands on this card (C8); `landedYou` makes it amber (C30). */
  landed?: number;
  landedYou?: boolean;
  /** The remove confirmation is open for this card: keep its × visible. */
  confirming?: boolean;
  onOpen?: (card: HTMLElement | null) => void;
  onRemove?: () => void;
  /** Shown in place of an empty name (the wizard before you type one). */
  namePlaceholder?: string;
  /** Laid over the card (the import wizard's seal). */
  overlay?: ReactNode;
  className?: string;
}

/**
 * One project on the overview (spec 20 §1). The same card is the wizards'
 * preview (§6–§8) and the source of the page transition into the dashboard
 * (C13), so its parts stay identifiable to `growTo` by class.
 */
export default function ProjectCard({
  data,
  preview = false,
  index = 0,
  running = false,
  waiting = [],
  waveEvents,
  landed = 0,
  landedYou = false,
  confirming = false,
  onOpen,
  onRemove,
  namePlaceholder,
  overlay,
  className,
}: Props) {
  const { t } = useTranslation();
  const ref = useRef<HTMLLIElement>(null);
  const counts = data.taskCounts ?? null;
  const progress = counts ? progressOf(counts) : null;
  const pct = progress?.pct ?? 0;
  const cells = counts ? cellsOf(counts) : [];
  const shownCells = cells.slice(0, CELLS_MAX);
  const flips = useCellFlips(cells);
  const domain = shownDomain(data.domain);

  // C8 / C30: a landed call sweeps the edge once and glows under the card.
  useEffect(() => {
    if (landed === 0 || motionOff()) return;
    const el = ref.current;
    if (el === null) return;
    for (const part of el.querySelectorAll<HTMLElement>(".card-sweep, .card-glow")) {
      part.classList.remove("go");
      part.classList.toggle("you", landedYou);
      void part.offsetWidth;
      part.classList.add("go");
    }
  }, [landed, landedYou]);

  const live = !preview;
  const phaseLine =
    data.ongoing || data.workflowCompleted || data.phaseIndex == null || data.phaseCount == null
      ? " "
      : t("welcome.phaseOf", { i: data.phaseIndex + 1, n: data.phaseCount });
  const phaseName = data.ongoing
    ? t("workflow.ongoing")
    : data.workflowCompleted
      ? t("welcome.recentDone")
      : (data.phaseTitle ?? "");

  // The button is named by the project alone and *described* by its state
  // (my-design review F12). A button's content is presentational to assistive
  // tech, so with `aria-label` set nothing inside it — the sr-only counts, the
  // foot's "blocked 1 · done, unverified 2", "terminal running", "missing" —
  // was ever read. Dropping the label instead would make the name the whole
  // card in DOM order (template chip and "3 min ago" first, the name later).
  const sid = useId();
  const describedBy = [`${sid}-phase`, counts ? `${sid}-cells` : "", `${sid}-foot`].filter(Boolean).join(" ");

  return (
    <li
      ref={ref}
      className={[
        "ws-card pcard",
        data.exists ? "" : "ws-card--missing",
        waiting.length > 0 ? "is-wait" : "",
        confirming ? "ws-card--confirming" : "",
        preview ? "ws-card--preview" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-row={data.root}
      style={{ ["--j" as string]: index }}
      onPointerMove={live ? tilt : undefined}
      onPointerLeave={live ? untilt : undefined}
    >
      <i className="card-glow" aria-hidden="true" />
      <i className="card-sheen" aria-hidden="true" />
      <i className="card-spot" aria-hidden="true" />
      <i className="card-sweep" aria-hidden="true" />
      <button
        className="ws-card-open"
        disabled={!data.exists || preview}
        tabIndex={preview ? -1 : undefined}
        title={data.root}
        aria-label={data.name}
        aria-describedby={describedBy}
        data-root={data.root}
        onClick={() => onOpen?.(ref.current)}
      >
        <span className="card-top">
          {data.templateName && <span className="chip">{data.templateName}</span>}
          {/* Why the unset domain is not rendered: lib/domain.ts (D137). */}
          {domain !== null && <span className="chip card-dom">{domain}</span>}
          {data.at && <TimeAgo className="card-ago" at={data.at} />}
        </span>
        <span className={`card-name${data.name === "" ? " card-name--ghost" : ""}`}>
          {data.name === "" ? namePlaceholder : data.name}
        </span>
        <PathLabel className="ws-card-path" path={data.root} actions={false} />
        <span className="card-mid">
          <span className="gauge" aria-hidden="true">
            <svg width="58" height="58" viewBox="0 0 58 58">
              <circle className="g-bg" cx="29" cy="29" r="24" />
              <circle
                className="g-fg"
                cx="29"
                cy="29"
                r="24"
                strokeDasharray={GAUGE_C.toFixed(1)}
                strokeDashoffset={(GAUGE_C * (1 - pct)).toFixed(1)}
              />
            </svg>
            <Scramble className="g-num" value={`${Math.round(pct * 100)}%`} />
          </span>
          <span className="card-phase" id={`${sid}-phase`}>
            <small>{phaseLine}</small>
            <b>{phaseName}</b>
            <span className="card-tasks">
              {counts && (
                <Scramble
                  value={t("welcome.recentTasks", { done: counts.done, total: progress?.live ?? counts.total })}
                />
              )}
            </span>
          </span>
        </span>
        <span className="cells" aria-hidden="true">
          {shownCells.map((k, i) => (
            <i key={i} className={`c-${k}${flips.has(i) ? " flip" : ""}`} />
          ))}
          {cells.length > CELLS_MAX && (
            <span className="cells-more">+{cells.length - CELLS_MAX}</span>
          )}
        </span>
        {counts && (
          <span className="sr-only" id={`${sid}-cells`}>
            {t("welcome.cellsSr", {
              ver: counts.done - counts.doneUnverified,
              unv: counts.doneUnverified,
              ip: counts.inProgress,
              todo: counts.todo,
              blk: counts.blocked,
            })}
          </span>
        )}
        <span className="card-foot" id={`${sid}-foot`}>
          {!data.exists && (
            <span className="card-miss">
              <IconWarn size={14} />
              {t("welcome.recentMissing")}
            </span>
          )}
          <YouLine counts={counts} waiting={waiting} />
          {running && (
            <span className="card-run">
              <i className="dot-run amb" aria-hidden="true" />
              {t("term.runningMark")}
            </span>
          )}
        </span>
        {running && live && waveEvents !== undefined && <Wave events={waveEvents} seed={data.root.length} />}
      </button>
      {live && onRemove && (
        <button
          className="btn btn-ghost btn-icon ws-card-remove danger-trigger"
          title={t("welcome.removeRecent")}
          aria-label={t("welcome.removeRecent")}
          onClick={onRemove}
        >
          <IconX size={14} />
        </button>
      )}
      {overlay}
    </li>
  );

  /** C4 + C5: the edge light follows the pointer and the card leans toward it. */
  function tilt(e: React.PointerEvent<HTMLLIElement>) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    el.style.setProperty("--mx", `${x}px`);
    el.style.setProperty("--my", `${y}px`);
    if (motionOff() || e.pointerType === "touch") return;
    el.style.transition = "transform 140ms ease-out, border-color .3s";
    el.style.transform = `perspective(900px) rotateX(${((0.5 - y / r.height) * 9).toFixed(2)}deg) rotateY(${((x / r.width - 0.5) * 11).toFixed(2)}deg) translateZ(8px)`;
  }

  function untilt(e: React.PointerEvent<HTMLLIElement>) {
    const el = e.currentTarget;
    el.style.transition = "transform 500ms var(--ease-out), border-color .3s";
    el.style.transform = "";
  }
}

/** The amber line at the foot: who is waiting for authorization, then the counts. */
function YouLine({ counts, waiting }: { counts: TaskCounts | null; waiting: string[] }) {
  const { t } = useTranslation();
  const parts = [
    ...waiting,
    counts && counts.blocked > 0 ? t("welcome.footBlocked", { n: counts.blocked }) : "",
    counts && counts.doneUnverified > 0 ? t("welcome.footUnverified", { n: counts.doneUnverified }) : "",
  ].filter(Boolean);
  const text = parts.join(" · ");
  const prev = useRef(text);
  const ref = useRef<HTMLSpanElement>(null);
  // C30: the line pops in when it changes, not on every re-read.
  useLayoutEffect(() => {
    if (prev.current === text) return;
    prev.current = text;
    const el = ref.current;
    if (el === null || text === "" || motionOff()) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 450, easing: "cubic-bezier(.16,1,.3,1)" },
    );
  }, [text]);
  if (text === "") return null;
  return (
    <span className="card-you" ref={ref}>
      <i className="mk-y" aria-hidden="true" />
      <span>{text}</span>
    </span>
  );
}

/** C9: which cells changed kind since the last counts — those flip in place. */
function useCellFlips(cells: CellKind[]): Set<number> {
  const prev = useRef<CellKind[] | null>(null);
  const flips = useRef<Set<number>>(new Set());
  const key = cells.join("");
  const last = useRef(key);
  if (last.current !== key) {
    flips.current = prev.current === null || motionOff() ? new Set() : changedCells(prev.current, cells);
    last.current = key;
  }
  useEffect(() => {
    prev.current = cells;
    if (flips.current.size === 0) return;
    const id = window.setTimeout(() => {
      flips.current = new Set();
    }, 720);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (prev.current === null) prev.current = cells;
  return flips.current;
}

const WAVE_SPAN_MS = 12000;

/**
 * C11: a twelve-second activity trace for a project with a session running.
 * A low idle swell, and a spike for every agent call. Colours come from
 * `--agent` and are re-read when the theme flips.
 */
function Wave({ events, seed }: { events: number[]; seed: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const evRef = useRef(events);
  evRef.current = events;

  useEffect(() => {
    const cv = ref.current;
    if (cv === null || motionOff()) return;
    let raf = 0;
    let last = 0;
    let colourKey = "";
    let colour = { line: "", top: "", bottom: "" };
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 15) return;
      last = now;
      const W = cv.clientWidth;
      const H = cv.clientHeight;
      if (W === 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      if (cv.width !== Math.round(W * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      const light = lightTheme();
      const key = light ? "l" : "d";
      if (key !== colourKey) {
        colourKey = key;
        const rgb = tokenRgb("--agent");
        colour = {
          line: `rgba(${rgb},.9)`,
          top: `rgba(${rgb},${light ? 0.18 : 0.28})`,
          bottom: `rgba(${rgb},0)`,
        };
      }
      const g = cv.getContext("2d");
      if (g === null) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const t = Date.now();
      const evs = evRef.current;
      g.beginPath();
      for (let x = 0; x <= W; x += 2) {
        const at = t - WAVE_SPAN_MS * (1 - x / W);
        let v = 0.07 * (Math.sin(at / 210 + seed) * Math.sin(at / 1300 + seed * 2) + 1);
        for (const e of evs) {
          const d = (at - e) / 200;
          if (d > -4 && d < 4) v += Math.exp(-d * d) * 0.85;
        }
        const y = H - 3 - Math.min(1, Math.max(0, v)) * (H - 6);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = colour.line;
      g.lineWidth = 1.4;
      g.stroke();
      g.lineTo(W, H);
      g.lineTo(0, H);
      g.closePath();
      const gr = g.createLinearGradient(0, 0, 0, H);
      gr.addColorStop(0, colour.top);
      gr.addColorStop(1, colour.bottom);
      g.fillStyle = gr;
      g.fill();
      // The left quarter fades out, so the trace reads as arriving from the past.
      const fade = g.createLinearGradient(0, 0, W * 0.25, 0);
      fade.addColorStop(0, "rgba(0,0,0,1)");
      fade.addColorStop(1, "rgba(0,0,0,0)");
      g.globalCompositeOperation = "destination-out";
      g.fillStyle = fade;
      g.fillRect(0, 0, W * 0.25, H);
      g.globalCompositeOperation = "source-over";
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [seed]);

  if (motionOff()) return null;
  return <canvas ref={ref} className="wave" aria-hidden="true" />;
}
