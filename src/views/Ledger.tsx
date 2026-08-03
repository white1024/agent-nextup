import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { api, errorMessage } from "../api";
import { useFlash } from "../hooks";
import { useFreshKeys } from "../hooks/anim";
import { eventCat, eventKey } from "../lib/ledger";
import EmptyState from "../components/EmptyState";
import EventMessage from "../components/EventMessage";
import QuickNote from "../components/QuickNote";
import type { LedgerEvent, LedgerKind, LedgerPage } from "../types";
import { absoluteTime, clockTime, dayHeading } from "../lib/time";

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

/**
 * The Ledger browser (D47): the readable face of the append-only ledger.
 * Decisions and notes are the default lens; the other chips widen to the
 * full display-worthy history (noise policy lives in core).
 */
export default function Ledger({ refreshKey, onMutated }: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<Filter>("knowledge");
  const [count, setCount] = useState(PAGE);
  // The page is stored with the ask it answered so the list below can swap
  // key and data atomically — see the D27 note on HistoryList.
  const [loaded, setLoaded] = useState<{ token: string; page: LedgerPage } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Ledger appends never emit watcher events (invariant: own derived writes
  // are filtered), so local writes re-read explicitly via this nonce.
  const [reloadNonce, setReloadNonce] = useState(0);
  const { flash, showFlash } = useFlash(2500);

  const kinds = FILTERS.find((f) => f.id === filter)?.kinds ?? null;
  const token = `${filter}:${count}`;

  useEffect(() => {
    let cancelled = false;
    api
      .ledgerHistory(kinds, 0, count)
      .then((page) => {
        if (cancelled) return;
        setLoaded({ token, page });
        setError(null);
      })
      .catch((e) => {
        // Keep the last good page on transient failures; just surface the error.
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
    // kinds is derived from filter, which token already covers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, refreshKey, reloadNonce]);

  function pickFilter(next: Filter) {
    setFilter(next);
    setCount(PAGE);
  }

  const page = loaded?.page ?? null;
  const shownAll = page !== null && page.events.length >= page.total;
  const capped = page !== null && !shownAll && page.events.length < count;

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("ledgerView.heading")}</h1>
          <p className="view-sub">{t("ledgerView.subtitle")}</p>
        </div>
        <div className="seg">
          {FILTERS.map(({ id }) => (
            <button
              key={id}
              className={filter === id ? "active" : ""}
              onClick={() => pickFilter(id)}
            >
              {t(`ledgerView.filter_${id}`)}
            </button>
          ))}
        </div>
      </header>

      {/* Explains the lens switcher in the header above it, not the page. */}
      <p className="section-hint">{t("ledgerView.lensHint")}</p>

      {error && <div className="alert alert-error">{error}</div>}
      {flash && <div className="alert alert-ok">{flash}</div>}

      <QuickNote
        onError={setError}
        onSaved={() => {
          showFlash(t("note.saved"));
          setReloadNonce((n) => n + 1);
          onMutated();
        }}
      />

      {page !== null && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">
              {t("ledgerView.listTitle")}
              <span className="sub">
                {t("ledgerView.showing", { shown: page.events.length, total: page.total })}
              </span>
            </h2>
          </div>
          {page.events.length === 0 ? (
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
                  onClick: () => pickFilter("all"),
                }}
              />
            )
          ) : (
            /* Keyed by the ask: a filter/paging switch remounts the list so
               newly revealed rows are absorbed as baseline; only same-ask
               refreshes (watcher deltas) diff-flash true arrivals (D27). */
            <HistoryList key={loaded!.token} events={page.events} />
          )}
          {!shownAll && !capped && (
            <div className="ledger-foot">
              <button className="btn" onClick={() => setCount((c) => c + PAGE)}>
                {t("ledgerView.loadMore")}
              </button>
            </div>
          )}
          {capped && <p className="muted">{t("ledgerView.capNote", { n: page.events.length })}</p>}
        </section>
      )}
    </div>
  );
}

function HistoryList({ events }: { events: LedgerEvent[] }) {
  const { t, i18n } = useTranslation();
  const fresh = useFreshKeys(events.map(eventKey));


  // Newest-first rows, grouped under a header per calendar day.
  const groups: { day: string; rows: LedgerEvent[] }[] = [];
  for (const event of events) {
    const day = dayHeading(event.at, i18n.language);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.day === day) {
      last.rows.push(event);
    } else {
      groups.push({ day, rows: [event] });
    }
  }

  return (
    <div className="ledger-history">
      {groups.map((group) => (
        <div key={group.day}>
          <div className="event-group">{group.day}</div>
          <ul className="event-list event-list--page">
            {group.rows.map((event, i) => {
              const key = eventKey(event);
              return (
                <li
                  key={`${key}-${i}`}
                  className={`event-item ${fresh.has(key) ? "entering agent-flash" : ""}`}
                >
                  <span className="event-time" title={absoluteTime(event.at, i18n.language)}>
                    {clockTime(event.at, i18n.language)}
                  </span>
                  <span className={`event-cat ${eventCat(event)}`}>
                    {t(`ledger.${event.kind}`)}
                  </span>
                  <EventMessage
                    actor={event.actor ?? undefined}
                    taskId={event.taskId}
                    message={event.message}
                  />
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
