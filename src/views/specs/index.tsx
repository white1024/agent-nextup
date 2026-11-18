import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../../api";
import { useWorkspaceData } from "../../hooks";
import EmptyState from "../../components/EmptyState";
import ErrorBar from "../../components/ErrorBar";
import { IconWarn } from "../../components/icons";
import Markdown, { type MarkdownOverrides } from "../../components/Markdown";
import Scramble from "../../components/Scramble";
import TeachingHint from "../../components/TeachingHint";
import { motionOff } from "../../lib/fx";
import { splitAroundCount } from "../../lib/format";
import type { SpecOverview, TaskSpecsReport } from "../../types";
import SpecSpectrum from "./SpecSpectrum";
import * as mo from "./motion";

interface Props {
  /** Bumped by App whenever the backend reports a workspace change. */
  refreshKey: number;
}

/** The open capability's text: loading while both halves are null. */
interface Doc {
  cap: string;
  md: string | null;
  error: string | null;
}

/**
 * The engine writes "### Requirement: …" and "#### Scenario: …"; the label is
 * set small and quiet, the name at full size (spec 60).
 */
function labelled(children: ReactNode): ReactNode {
  const parts = Children.toArray(children);
  const first = parts[0];
  if (typeof first !== "string") return children;
  const m = /^(Requirement|Scenario):\s*/.exec(first);
  if (m === null) return children;
  return [
    <span key="label" className="spc-lbl">{`${m[1]}:`}</span>,
    " ",
    first.slice(m[0].length),
    ...parts.slice(1),
  ];
}

const MD: MarkdownOverrides = {
  h3: ({ children }) => <h3>{labelled(children)}</h3>,
  h4: ({ children }) => <h4>{labelled(children)}</h4>,
};

/**
 * The Specs view (D79 batch ④): the read face of the spec layer. A rail of
 * capabilities, the selected capability's markdown, and the pending-folds
 * panel (unarchived tasks whose delta bundles wait for their archive).
 * Read-only on purpose — the truth is files; editing happens in the editor
 * or through the agent, and folding happens on archive.
 *
 * D153 (spec 60): three columns — the rail and the pending panel stay in view
 * while the text scrolls with the page, which is what lets the old 70vh split
 * go (it existed so the pending panel did not sink under a long spec).
 */
export default function Specs({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  // List-level vs content-level failures stay separate on purpose: one broken
  // capability (or one failed refresh) must never blank the rail and the
  // pending panel (batch 4 review W3). The content is read on its own; it
  // keeps the old text through a refresh and only shows "loading" when the
  // capability changes.
  const [doc, setDoc] = useState<Doc | null>(null);
  const docRef = useRef<Doc | null>(null);
  docRef.current = doc;

  const pendRef = useRef<HTMLUListElement>(null);
  const pendPanelRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLElement>(null);
  const guideRef = useRef<HTMLElement>(null);
  // Pictures of the pending rows taken just before a read lands (C169).
  const shots = useRef<Map<string, mo.RowShot>>(new Map());
  const listHeight = useRef(0);

  // Two sources, one three-state (null = not answered yet, [] = answered and
  // empty — invariant 10): the rail and the pending panel are read together.
  const { data, error } = useWorkspaceData(async () => {
    const [rows, reports] = await Promise.all([api.specsOverview(), api.pendingSpecFolds()]);
    shots.current = mo.shootRows(pendRef.current);
    listHeight.current = pendRef.current?.getBoundingClientRect().height ?? 0;
    return { rows, reports };
  }, refreshKey);
  const overview = data?.rows ?? null;
  const pending: TaskSpecsReport[] = data?.reports ?? [];
  const conflicts = pending.filter((r) => !r.ok).length;

  // ── Motion plumbing ─────────────────────────────────────────────────────
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
      mo.settle();
    },
    [],
  );

  // Entering from the sidebar: the capabilities rise one after another. Not
  // when a page frame is the arrival, and only on the mount.
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (motionOff() || document.querySelector(".pt-veil") !== null) return;
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  // ── C169: a delta folds in ──────────────────────────────────────────────
  //
  // The rail trails the data by the fold's beat: the folded row shrinks to a
  // point, the light flies into the capability, and only then does its
  // spectrum grow and its count change. A re-read that folded nothing swaps
  // at once — and so does everything under reduced motion.
  const [rail, setRail] = useState<SpecOverview[] | null>(null);
  const [grown, setGrown] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [fading, setFading] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [got, setGot] = useState<ReadonlySet<string>>(() => new Set());
  const prevData = useRef<typeof data>(null);
  const folding = useRef(false);
  const latestRows = useRef<SpecOverview[] | null>(null);
  // The open capability gets the curtain once its new text is in (C169).
  const curtainFor = useRef<{ cap: string; at: number } | null>(null);

  const specEl = (cap: string): Element | null => {
    const el = railRef.current?.querySelector(`[data-spc-cap="${CSS.escape(cap)}"]`) ?? null;
    return el?.querySelector("[data-spc-spec]") ?? el;
  };

  useLayoutEffect(() => {
    if (data === null) return;
    const prev = prevData.current;
    prevData.current = data;
    latestRows.current = data.rows;
    const shot = shots.current;
    shots.current = new Map();
    if (prev === null || motionOff()) {
      setRail(data.rows);
      return;
    }
    const still = new Set(data.reports.map((r) => r.taskId));
    const gone = prev.reports.filter((r) => !still.has(r.taskId));
    const was = new Map(prev.rows.map((r) => [r.capability, r.requirements]));
    const changed = new Set(
      data.rows.filter((r) => was.get(r.capability) !== r.requirements).map((r) => r.capability),
    );
    const folds = gone.filter((r) => r.capabilities.some((c) => changed.has(c)));
    if (folds.length === 0) {
      // Nothing folded in: the rows that stayed slide up, the rail swaps —
      // unless a fold is still on its way, which will land the newest rows.
      if (!folding.current) setRail(data.rows);
      mo.closeGap(pendRef.current, shot, 0, listHeight.current);
      return;
    }

    folding.current = true;
    mo.closeGap(pendRef.current, shot, 460, listHeight.current);
    for (const r of folds) {
      const s = shot.get(r.taskId);
      if (s === undefined) continue;
      const from = mo.foldRow(s);
      const into = r.capabilities.filter((c) => changed.has(c));
      later(460, () => mo.beamInto(from, into.map(specEl)));
    }
    if (selected !== null && changed.has(selected)) {
      curtainFor.current = { cap: selected, at: performance.now() + 1080 };
    }
    const now = new Map(data.rows.map((r) => [r.capability, r.requirements]));
    const grew = new Map<string, number>();
    const shrank = new Map<string, number>();
    for (const cap of changed) {
      const a = was.get(cap) ?? 0;
      const b = now.get(cap) ?? 0;
      if (b > a) grew.set(cap, a);
      if (b < a) shrank.set(cap, b);
    }
    const swap = () => {
      folding.current = false;
      setRail(latestRows.current ?? data.rows);
      setFading(new Map());
      setGrown(grew);
      setGot(new Set(changed));
      later(900, () => setGot(new Set()));
      later(1500, () => setGrown(new Map()));
    };
    later(1080, () => {
      // Lines that go fade out before the spectrum is redrawn.
      if (shrank.size === 0) swap();
      else {
        setFading(shrank);
        later(240, swap);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEffect(() => {
    if (overview === null) return;
    // Keep the selection when it survives the refresh; otherwise fall back to
    // the first capability so the pane is never pointlessly blank while specs
    // exist. Keyed on the fetched array, so this runs once per successful read.
    setSelected((cur) =>
      cur !== null && overview.some((r) => r.capability === cur)
        ? cur
        : (overview[0]?.capability ?? null),
    );
  }, [overview]);

  // ── The open capability's text (C167 on a change, C169's curtain) ───────
  const revealing = useRef(false);
  const revealAt = useRef(0);
  useEffect(() => {
    if (selected === null) {
      setDoc(null);
      return;
    }
    let live = true;
    let wait = 0;
    const cur = docRef.current;
    const switching = cur?.cap !== selected || (cur.md === null && cur.error === null);
    if (switching) setDoc({ cap: selected, md: null, error: null });
    void api
      .specContent(selected)
      .then(
        (md) => ({ md, error: null }),
        (e: unknown) => ({ md: null, error: errorMessage(e) }),
      )
      .then((res) => {
        if (!live) return;
        const next: Doc = { cap: selected, ...res };
        if (switching) {
          // A click shows its scan line for a moment even when the read is
          // instant — otherwise the sweep has nothing to sweep from.
          const go = () => {
            if (!live) return;
            if (revealing.current) {
              afterCommit.current.push(() => {
                revealing.current = false;
                mo.reveal(contentRef.current);
              });
            }
            setDoc(next);
          };
          const ms = revealing.current ? revealAt.current + 300 - performance.now() : 0;
          if (ms > 0) wait = window.setTimeout(go, ms);
          else go();
          return;
        }
        const now = docRef.current;
        if (now !== null && now.md === next.md && now.error === next.error) return;
        const c = curtainFor.current;
        if (c !== null && c.cap === selected && !motionOff()) {
          const go = () => {
            if (!live) return;
            curtainFor.current = null;
            const old = contentRef.current?.querySelector(":scope > .md-body");
            const picture = old instanceof HTMLElement ? (old.cloneNode(true) as HTMLElement) : null;
            afterCommit.current.push(() => mo.curtain(contentRef.current, picture));
            setDoc(next);
          };
          const ms = c.at - performance.now();
          if (ms > 0) wait = window.setTimeout(go, ms);
          else go();
          return;
        }
        setDoc(next);
      });
    return () => {
      live = false;
      window.clearTimeout(wait);
    };
  }, [selected, data]);

  function choose(cap: string) {
    if (cap === selected) return;
    if (motionOff() || selected === null) {
      setSelected(cap);
      return;
    }
    const capEl = (c: string) =>
      railRef.current?.querySelector<HTMLElement>(`[data-spc-cap="${CSS.escape(c)}"]`) ?? null;
    mo.slideBar(capEl(selected)?.getBoundingClientRect() ?? null, capEl(cap));
    const ms = mo.fadeContent(contentRef.current);
    revealing.current = true;
    revealAt.current = performance.now() + ms;
    later(ms, () => {
      afterCommit.current.push(() => mo.parkLine(contentRef.current));
      setSelected(cap);
    });
  }

  // C168: hovering a pending row frames the capabilities it changes.
  const [hl, setHl] = useState<ReadonlySet<string>>(() => new Set());

  // ── C170: the empty page's path, walked once ────────────────────────────
  const [steps, setSteps] = useState(0);
  const [guideLit, setGuideLit] = useState(false);
  const isEmpty = overview !== null && overview.length === 0;
  useEffect(() => {
    if (!isEmpty) return;
    let live = true;
    let stop: () => void = () => undefined;
    let done = false;
    const go = () => {
      if (!live) return;
      stop = mo.walkPath(
        guideRef.current,
        (k) => setSteps((s) => Math.max(s, k)),
        () => {
          done = true;
          setGuideLit(true);
        },
      );
    };
    // Measured after the fonts are in: at narrow widths the step text wraps,
    // and a fallback face wraps it differently.
    if (document.fonts.status === "loaded") go();
    else void document.fonts.ready.then(go);
    return () => {
      live = false;
      stop();
      if (!done) {
        setSteps(3);
        setGuideLit(true);
      }
    };
  }, [isEmpty]);

  if (overview === null) {
    // Nothing loaded yet: a first-read failure is the only case where the
    // error may take the whole panel — there is no stale data to keep showing.
    return error !== null ? (
      <div className="view spc">
        <div className="panel">
          <p className="spc-muted">{error}</p>
        </div>
      </div>
    ) : null;
  }

  const rows = rail ?? overview;
  const [countBefore, countAfter] = splitAroundCount((x) => t("specs.reqCount", { n: x }));

  return (
    // `view` is not decoration: it carries the page padding (and, on the
    // pages that keep it, the reading measure). This view once shipped
    // without it (D79 batch ④) and lost both.
    <div className={`view spc${entering ? " spc-enter" : ""}`}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("specs.heading")}</h1>
          <p className="view-sub">{t("specs.subtitle")}</p>
        </div>
        {/* The pending panel is the only thing on this page that asks for an
            action. It stays in view beside the text at full width, but drops
            under it on a narrow window, so "is anything waiting?" is answered
            up here too (r2 2-5). */}
        {pending.length > 0 && (
          <div className="header-actions">
            <button
              type="button"
              className={`btn btn-small spc-badge${conflicts > 0 ? " warn" : ""}`}
              onClick={() =>
                pendPanelRef.current?.scrollIntoView({
                  block: "start",
                  behavior: motionOff() ? "auto" : "smooth",
                })
              }
            >
              {conflicts > 0
                ? t("specs.pendingBadgeConflict", { n: pending.length, c: conflicts })
                : t("specs.pendingBadge", { n: pending.length })}
            </button>
          </div>
        )}
      </header>

      <ErrorBar error={error === null ? null : `${t("app.refreshFailed")} ${error}`} />

      <div className={`spc-body${isEmpty ? " is-empty" : ""}`}>
        {isEmpty ? (
          <section className={`panel spc-guide${guideLit ? " lit" : ""}`} ref={guideRef}>
            <h2>{t("specs.emptyTitle")}</h2>
            <p>{t("specs.emptyHint")}</p>
            <div className="spc-path-box">
              <span className="spc-path-line" aria-hidden="true">
                <span className="spc-path-run" />
              </span>
              <ol className="spc-path">
                {[1, 2, 3].map((k) => (
                  <li key={k} className={steps >= k ? "lit" : undefined}>
                    <i className="spc-node">{k}</i>
                    <span>{t(`specs.emptyStep${k}`)}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        ) : (
          <>
            <nav className="spc-rail" aria-label={t("specs.railLabel")} ref={railRef}>
              {rows.map((row, k) => {
                const cap = row.capability;
                const on = cap === selected;
                const broken = row.problem !== undefined;
                const style: Record<string, number> = { "--k": k };
                return (
                  <button
                    key={cap}
                    type="button"
                    className={`spc-cap${on ? " on" : ""}${hl.has(cap) ? " hl" : ""}${got.has(cap) ? " got" : ""}`}
                    aria-current={on ? "true" : undefined}
                    data-spc-cap={cap}
                    style={style}
                    onClick={() => choose(cap)}
                  >
                    <span className="spc-cap-n">
                      {cap}
                      {row.problem !== undefined && (
                        // A status marker, so it comes from `icons.tsx` rather
                        // than being a ⚠ character — invariant 9(f). The glyph
                        // keeps its own accessible name; `IconWarn` is
                        // `aria-hidden`, so the name lives on the wrapper.
                        <span className="spc-cap-p" title={row.problem} role="img" aria-label={row.problem}>
                          <IconWarn size={13} />
                        </span>
                      )}
                    </span>
                    <span className="spc-cap-c">
                      {countBefore}
                      <Scramble value={row.requirements} />
                      {countAfter}
                    </span>
                    <SpecSpectrum
                      n={row.requirements}
                      on={on}
                      broken={broken}
                      grownFrom={grown.get(cap)}
                      fadeFrom={fading.get(cap)}
                    />
                  </button>
                );
              })}
            </nav>
            <section className="panel spc-content" aria-live="polite" ref={contentRef}>
              {doc === null || (doc.md === null && doc.error === null) ? (
                <p className="spc-muted">{t("common.loading")}</p>
              ) : doc.error !== null ? (
                <p className="spc-muted">{doc.error}</p>
              ) : (
                <Markdown text={doc.md ?? ""} overrides={MD} className="spc-md" />
              )}
            </section>
          </>
        )}

        <section className="panel spc-pend" ref={pendPanelRef} aria-label={t("specs.pendingTitle")}>
          <div className="panel-head">
            <h2 className="panel-title">{t("specs.pendingTitle")}</h2>
          </div>
          <TeachingHint id="specs-pending" className="spc-hint">
            {t("specs.pendingHint")}
          </TeachingHint>
          {pending.length === 0 ? (
            <EmptyState title={t("specs.pendingEmpty")} hint={t("specs.pendingEmptyHint")} />
          ) : (
            <ul className="spc-rows" ref={pendRef}>
              {pending.map((r) => (
                <li
                  key={r.taskId}
                  className="spc-row"
                  data-spc-row={r.taskId}
                  onPointerEnter={() => setHl(new Set(r.capabilities))}
                  onPointerLeave={() => setHl(new Set())}
                >
                  <span className="spc-row-t mono">{r.taskId}</span>
                  <span className="spc-row-c">{r.capabilities.join(", ")}</span>
                  {r.ok ? (
                    // Lint warnings never block, so they ride the hover title
                    // instead of claiming their own line.
                    <span className="spc-pill is-ok" title={r.warnings.join("\n") || undefined}>
                      <i className="mk-e" aria-hidden="true" />
                      {t("specs.pendingOk", {
                        counts: `+${r.added} ~${r.modified} -${r.removed} →${r.renamed}`,
                      })}
                    </span>
                  ) : (
                    // Waiting on you: amber, pulsing slowly (C168).
                    <span className="spc-pill is-bad" title={r.problems.join("\n")}>
                      <i className="mk-y spc-pulse" aria-hidden="true" />
                      {t("specs.pendingConflict", { n: r.problems.length })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
