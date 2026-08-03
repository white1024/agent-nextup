import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../api";
import { useWorkspaceData } from "../hooks";
import EmptyState from "../components/EmptyState";
import { IconWarn } from "../components/icons";
import Markdown from "../components/Markdown";
import TeachingHint from "../components/TeachingHint";

interface Props {
  /** Bumped by App whenever the backend reports a workspace change. */
  refreshKey: number;
}

/**
 * The Specs view (D79 batch ④): the read face of the spec layer. A rail of
 * capabilities, the selected capability's markdown, and the pending-folds
 * panel (unarchived tasks whose delta bundles wait for their archive).
 * Read-only on purpose — the truth is files; editing happens in the editor
 * or through the agent, and folding happens on archive.
 */
export default function Specs({ refreshKey }: Props) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  // List-level vs content-level failures stay separate on purpose: one broken
  // capability (or one failed refresh) must never blank the rail and the
  // pending panel (batch 4 review W3). Only the content half is hand-rolled:
  // it must *clear* on every selection change, which is the one thing
  // `useWorkspaceData` deliberately does not do (D65).
  const [contentError, setContentError] = useState<string | null>(null);

  // Two sources, one three-state (null = not answered yet, [] = answered and
  // empty — invariant 10): the rail and the pending panel are read together.
  const { data, error } = useWorkspaceData(async () => {
    const [rows, reports] = await Promise.all([api.specsOverview(), api.pendingSpecFolds()]);
    return { rows, reports };
  }, refreshKey);
  const overview = data?.rows ?? null;
  const pending = data?.reports ?? null;
  const conflicts = (pending ?? []).filter((r) => !r.ok).length;
  const pendingRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (selected === null) {
      setContent(null);
      setContentError(null);
      return;
    }
    let live = true;
    setContent(null);
    setContentError(null);
    api
      .specContent(selected)
      .then((md) => {
        if (live) setContent(md);
      })
      .catch((e) => {
        if (live) setContentError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [selected, refreshKey]);

  if (overview === null) {
    // Nothing loaded yet: a first-read failure is the only case where the
    // error may take the whole panel — there is no stale data to keep showing.
    return error !== null ? (
      <div className="view">
        <div className="panel">
          <p className="muted">{error}</p>
        </div>
      </div>
    ) : null;
  }

  return (
    // `view` is not decoration: it carries the app-wide measure (--content-max),
    // the centring and the page padding. This view shipped without it (D79
    // batch ④) and was the only one in src/views that did — the result was a
    // full-bleed page with ~1500px line lengths and the rail flush against the
    // window edge, which is what the walkthrough caught.
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("specs.heading")}</h1>
          <p className="view-sub">{t("specs.subtitle")}</p>
        </div>
        {/* The pending panel is the only thing on this page that asks for an
            action, and it sits below a 70vh reading split — at the default
            window size opening the page shows its title and nothing else, so
            "is anything waiting?" could not be answered without scrolling
            (r2 2-5). The count comes up here; the panel stays where it is. */}
        {pending !== null && pending.length > 0 && (
          <div className="header-actions">
            <button
              className={`btn btn-small${conflicts > 0 ? " specs-pending-warn" : ""}`}
              onClick={() => pendingRef.current?.scrollIntoView({ block: "start" })}
            >
              {conflicts > 0
                ? t("specs.pendingBadgeConflict", { n: pending.length, c: conflicts })
                : t("specs.pendingBadge", { n: pending.length })}
            </button>
          </div>
        )}
      </header>

      <div className="specs-view">
        {error !== null && (
          <p className="muted">
            {t("app.refreshFailed")} {error}
          </p>
        )}
        {overview.length === 0 ? (
          <EmptyState
            variant="guide"
            title={t("specs.emptyTitle")}
            hint={t("specs.emptyHint")}
            steps={[t("specs.emptyStep1"), t("specs.emptyStep2"), t("specs.emptyStep3")]}
          />
        ) : (
          <div className="specs-split">
            <aside className="specs-rail" aria-label={t("specs.railLabel")}>
              {overview.map((row) => (
                <button
                  key={row.capability}
                  className={`specs-cap${row.capability === selected ? " is-active" : ""}`}
                  onClick={() => setSelected(row.capability)}
                >
                  <span className="specs-cap-name">
                    {row.capability}
                    {row.problem !== undefined && (
                      // A status marker, so it comes from `icons.tsx` rather
                      // than being a ⚠ character — invariant 9(f). The glyph
                      // keeps its own accessible name; `IconWarn` is
                      // `aria-hidden`, so the name lives on the wrapper.
                      <span
                        className="specs-cap-problem"
                        title={row.problem}
                        role="img"
                        aria-label={row.problem}
                      >
                        <IconWarn size={13} />
                      </span>
                    )}
                  </span>
                  <span className="specs-cap-count">
                    {t("specs.reqCount", { n: row.requirements })}
                  </span>
                </button>
              ))}
            </aside>
            <section className="specs-content md-scroll">
              {contentError !== null ? (
                <p className="muted">{contentError}</p>
              ) : content !== null ? (
                <Markdown text={content} />
              ) : (
                <p className="muted">{t("common.loading")}</p>
              )}
            </section>
          </div>
        )}

        <section className="panel specs-pending" ref={pendingRef}>
          <h2 className="panel-title">{t("specs.pendingTitle")}</h2>
          <TeachingHint id="specs-pending">{t("specs.pendingHint")}</TeachingHint>
          {pending === null ? null : pending.length === 0 ? (
            <EmptyState title={t("specs.pendingEmpty")} hint={t("specs.pendingEmptyHint")} />
          ) : (
            <ul className="specs-pending-list">
              {pending.map((r) => (
                <li key={r.taskId} className="specs-pending-row">
                  <span className="mono">{r.taskId}</span>
                  <span className="specs-pending-caps">{r.capabilities.join(", ")}</span>
                  {r.ok ? (
                    // Lint warnings never block, so they ride the hover title
                    // instead of claiming their own pill.
                    <span className="pill pill-info" title={r.warnings.join("\n") || undefined}>
                      <span className="dot" aria-hidden="true" />
                      {t("specs.pendingOk", {
                        counts: `+${r.added} ~${r.modified} -${r.removed} →${r.renamed}`,
                      })}
                    </span>
                  ) : (
                    <span className="pill pill-blocked" title={r.problems.join("\n")}>
                      <span className="dot" aria-hidden="true" />
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
