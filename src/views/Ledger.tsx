import { useEffect, useRef, useState, type CSSProperties } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../api";
import { useFlash } from "../hooks";
import { useFreshKeys } from "../hooks/anim";
import { eventCat, eventKey } from "../lib/ledger";
import EmptyState from "../components/EmptyState";
import ErrorBar from "../components/ErrorBar";
import EventMessage from "../components/EventMessage";
import FlashBar from "../components/FlashBar";
import QuickNote from "../components/QuickNote";
import type { LedgerEvent, LedgerKind, LedgerPage } from "../types";
import { absoluteTime, clockTime, dayHeading } from "../lib/time";
import Segmented from "../components/Segmented";
import { motionOff } from "../lib/fx";
import { viewSwap } from "../lib/listMotion";

interface Props {
  /** Bumped by App whenever the backend reports a workspace change. */
  refreshKey: number;
  onMutated: () => void;
}

/** Rows fetched per "load more" click (and the initial ask). */
const PAGE = 50;

type Filter = "knowledge" | "decision" | "progress" | "note" | "agent" | "all";
const FILTERS: { id: Filter; kinds: LedgerKind[] | null }[] = [
  { id: "knowledge", kinds: ["decision", "progress", "note"] },
  { id: "decision", kinds: ["decision"] },
  { id: "progress", kinds: ["progress"] },
  { id: "note", kinds: ["note"] },
  // Agent traffic is an audit lens, not project history — its own chip keeps
  // it reachable without making "All events" a debug dump (product review §5-11).
  { id: "agent", kinds: ["agent_tool_called", "mcp_tool_called"] },
  { id: "all", kinds: null },
];

const kindsOf = (f: Filter) => FILTERS.find((x) => x.id === f)?.kinds ?? null;

/**
 * The Ledger browser (D47): the readable face of the append-only ledger.
 * Decisions and notes are the default lens; the other chips widen to the
 * full display-worthy history (noise policy lives in core).
 *
 * D153 (spec 40): history on the left, the write panel on the right and
 * sticky (above the history when the main area is narrow). Switching lens is
 * one View Transition that waits for the new page (C44); a fresh entry slides
 * in (C45); "load more" rises row by row (C46).
 */
export default function Ledger({ refreshKey, onMutated }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("knowledge");
  const [count, setCount] = useState(PAGE);
  // The page is stored with the ask it answered so the list below can swap
  // key and data atomically — see the D27 note on HistoryList. `count` is the
  // ask's own size: while "load more" is out, the state's count is already
  // the next one, and comparing the old page against it read as the cap.
  const [loaded, setLoaded] = useState<{ token: string; count: number; page: LedgerPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ledger appends never emit watcher events (invariant: own derived writes
  // are filtered), so local writes re-read explicitly via this nonce.
  const [reloadNonce, setReloadNonce] = useState(0);
  const { flash, showFlash } = useFlash(2500);
  const pageRef = useRef<HTMLDivElement>(null);
  /** A page `pickFilter` already read for the transition; the effect skips it once. */
  const prefetched = useRef<string | null>(null);

  const token = `${filter}:${count}`;

  useEffect(() => {
    if (prefetched.current === token) {
      prefetched.current = null;
      return;
    }
    let cancelled = false;
    const asked = count;
    api
      .ledgerHistory(kindsOf(filter), 0, count)
      .then((page) => {
        if (cancelled) return;
        setLoaded({ token, count: asked, page });
        setError(null);
      })
      .catch((e) => {
        // Keep the last good page on transient failures; just surface the error.
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // filter and count are what token is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshKey, reloadNonce]);

  // Entering from the sidebar: the rows rise one after another (mount only).
  const [entering, setEntering] = useState(false);
  useEffect(() => {
    if (motionOff() || document.querySelector(".pt-veil") !== null) return;
    setEntering(true);
    const timer = window.setTimeout(() => setEntering(false), 1400);
    return () => window.clearTimeout(timer);
  }, []);

  // C46: where the batch "load more" revealed starts.
  const [moreFrom, setMoreFrom] = useState<number | null>(null);
  useEffect(() => {
    if (moreFrom === null) return;
    const timer = window.setTimeout(() => setMoreFrom(null), 1400);
    return () => window.clearTimeout(timer);
  }, [moreFrom]);

  /**
   * C44: read the new lens first, then swap inside one View Transition — rows
   * that stay slide to their new place, the selected cell slides across. A
   * transition started before the read would show a blank list mid-way.
   */
  async function pickFilter(next: Filter) {
    if (next === filter) return;
    let page: LedgerPage;
    try {
      page = await api.ledgerHistory(kindsOf(next), 0, PAGE);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }
    const nextToken = `${next}:${PAGE}`;
    viewSwap("lens", pageRef.current, () =>
      flushSync(() => {
        prefetched.current = nextToken;
        setFilter(next);
        setCount(PAGE);
        setLoaded({ token: nextToken, count: PAGE, page });
        setError(null);
      }),
    );
  }

  function loadMore() {
    if (page !== null && !motionOff()) setMoreFrom(page.events.length);
    setCount((c) => c + PAGE);
  }

  const page = loaded?.page ?? null;
  const shownAll = page !== null && page.events.length >= page.total;
  const capped = page !== null && !shownAll && page.events.length < (loaded?.count ?? count);

  return (
    <div className={`view lg${entering ? " lg-enter" : ""}`} ref={pageRef}>
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("ledgerView.heading")}</h1>
          <p className="view-sub">{t("ledgerView.subtitle")}</p>
        </div>
        <Segmented
          label={t("nav.ledger")}
          className="seg--wrap lg-seg"
          markName="segi"
          value={filter}
          options={FILTERS.map(({ id }) => ({ value: id, label: t(`ledgerView.filter_${id}`) }))}
          onChange={(id) => void pickFilter(id)}
        />
      </header>

      {/* Explains the lens switcher in the header above it, not the page. */}
      <p className="lg-hint">{t("ledgerView.lensHint")}</p>

      <ErrorBar error={error} />
      <FlashBar message={flash} />

      <div className="lg-body">
        <section className="panel lg-hist">
          <div className="panel-head">
            <h2 className="panel-title">
              {t("ledgerView.listTitle")}
              {page !== null && (
                <span className="sub">
                  {t("ledgerView.showing", { shown: page.events.length, total: page.total })}
                </span>
              )}
            </h2>
          </div>
          {/* Nothing until the first read answers (invariant 10(c)). */}
          {page !== null &&
            (page.events.length === 0 ? (
              // The default lens is Decisions + notes, not All — so a brand-new project
              // lands here reading "nothing under this filter" and cannot tell
              // that from an empty ledger. Offer the wider lens rather than
              // guessing which one it is (D65).
              filter === "all" ? (
                <EmptyState title={t("ledgerView.emptyAll")} hint={t("ledgerView.emptyAllHint")} />
              ) : (
                <EmptyState
                  title={t("ledgerView.empty")}
                  hint={t("ledgerView.emptyHint")}
                  action={{
                    label: t("ledgerView.filter_all"),
                    onClick: () => void pickFilter("all"),
                  }}
                />
              )
            ) : (
              /* Keyed by the ask: a filter/paging switch remounts the list so
                 newly revealed rows are absorbed as baseline; only same-ask
                 refreshes (watcher deltas, this page's own writes) slide true
                 arrivals in (D27, C45). */
              <HistoryList
                key={loaded!.token}
                events={page.events}
                superseded={page.superseded}
                moreFrom={moreFrom}
              />
            ))}
          {page !== null && !shownAll && !capped && (
            <div className="lg-foot">
              <button className="btn btn-small" onClick={loadMore}>
                {t("ledgerView.loadMore")}
              </button>
            </div>
          )}
          {capped && <p className="lg-cap">{t("ledgerView.capNote", { n: page.events.length })}</p>}
        </section>

        <QuickNote
          className="lg-qn"
          onError={setError}
          onSaved={() => {
            showFlash(t("note.saved"));
            setReloadNonce((n) => n + 1);
            onMutated();
          }}
        />
      </div>
    </div>
  );
}

/** A View Transition name for a row: an ident, unique within one render. */
function vtName(key: string, used: Map<string, number>): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (Math.imul(h, 31) + key.charCodeAt(i)) | 0;
  const base = `l-${(h >>> 0).toString(36)}`;
  const n = used.get(base) ?? 0;
  used.set(base, n + 1);
  return n === 0 ? base : `${base}-${n}`;
}

function HistoryList({
  events,
  superseded,
  moreFrom,
}: {
  events: LedgerEvent[];
  /** Engine-computed, whole-ledger — never re-derive it from `events` (see types.ts). */
  superseded: Record<string, string[]>;
  /** Index of the first row "load more" revealed, while its batch rises (C46). */
  moreFrom: number | null;
}) {
  const { t, i18n } = useTranslation();
  const fresh = useFreshKeys(events.map(eventKey));

  // Newest-first rows, grouped under a header per calendar day. A day can
  // come round twice — the ledger is in write order, and an imported backup
  // or a clock change puts an older stamp after a newer one — so a group's
  // key counts which run of that day it is.
  const groups: { key: string; day: string; rows: { event: LedgerEvent; index: number }[] }[] = [];
  const runs = new Map<string, number>();
  events.forEach((event, index) => {
    const day = dayHeading(event.at, i18n.language);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) {
      last.rows.push({ event, index });
    } else {
      const n = (runs.get(day) ?? 0) + 1;
      runs.set(day, n);
      groups.push({ key: n === 1 ? day : `${day}#${n}`, day, rows: [{ event, index }] });
    }
  });
  const names = new Map<string, number>();

  return (
    <div className="lg-groups">
      {groups.map((group) => (
        <div className="lg-g" key={group.key}>
          <div className="lg-day">{group.day}</div>
          <ul className="lg-list">
            {group.rows.map(({ event, index }, i) => {
              const key = eventKey(event);
              const by = event.id ? superseded[event.id] : undefined;
              const cat = eventCat(event) || "other";
              const more = moreFrom !== null && index >= moreFrom;
              const style = { "--j": index, "--m": more ? Math.min(index - (moreFrom ?? 0), 12) : 0 } as CSSProperties;
              return (
                <li
                  key={`${key}-${i}`}
                  data-vt-name={vtName(key, names)}
                  data-cat={cat}
                  style={style}
                  className={`lg-ev${by ? " is-sup" : ""}${fresh.has(key) ? " fresh" : ""}${more ? " more-in" : ""}`}
                >
                  <time dateTime={event.at} title={absoluteTime(event.at, i18n.language)}>
                    {clockTime(event.at, i18n.language)}
                  </time>
                  {/* The kind as a word with a mark (R7): violet dot for an agent's
                      call, the amber circle for a call that was stopped and waits
                      on you. Not red — nothing was harmed. */}
                  <span className="lg-k" data-c={cat}>
                    {cat === "tool" && <span className="dot-run" aria-hidden="true" />}
                    {cat === "deny" && <span className="mk-y" aria-hidden="true" />}
                    <span className="lg-k-t">{t(`ledger.${event.kind}`)}</span>
                  </span>
                  <EventMessage
                    actor={event.actor ?? undefined}
                    taskId={event.taskId}
                    message={event.message}
                  />
                  {/* The decision is kept and struck through, never hidden: it was
                      really made, and the record of a reversal is worth more than a
                      tidy list. */}
                  {by && <span className="lg-sup">{t("ledgerView.supersededBy", { ids: by.join(", ") })}</span>}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
