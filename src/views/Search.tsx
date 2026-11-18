import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { api } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import EmptyState from "../components/EmptyState";
import ErrorBar from "../components/ErrorBar";
import FlashBar from "../components/FlashBar";
import { IconRefresh, IconSearch } from "../components/icons";
import { motionOff } from "../lib/fx";
import type { IndexInfo, IndexProgress, IndexSummary, SearchHit } from "../types";

/** C47: how long the finished bar flares before it goes and the summary drops in. */
const DONE_MS = 420;

/**
 * An FTS5 snippet split into plain text and matches. The engine marks each
 * match with « and » (`index/store.rs`); the markers become `<mark>` here and
 * never reach the screen. Text is only ever rendered as React text, so a
 * snippet cannot inject markup whatever the indexed file contains. An
 * unclosed « (a snippet cut mid-match) marks the rest.
 */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  let rest = snippet;
  while (rest !== "") {
    const open = rest.indexOf("«");
    if (open === -1) {
      out.push({ text: rest, hit: false });
      break;
    }
    if (open > 0) out.push({ text: rest.slice(0, open), hit: false });
    const close = rest.indexOf("»", open + 1);
    const end = close === -1 ? rest.length : close;
    const hit = rest.slice(open + 1, end);
    if (hit !== "") out.push({ text: hit, hit: true });
    rest = close === -1 ? "" : rest.slice(close + 1);
  }
  return out;
}

/** What a result list is, for "did the results actually change" (C48). */
const hitsSig = (hits: SearchHit[]) => hits.map((h) => `${h.path}:${h.startLine}-${h.endLine}`).join("\n");

interface Props {
  refreshKey: number;
}

export default function Search({ refreshKey }: Props) {
  const { t } = useTranslation();
  // The backend returns null when no index has been built yet — the same value
  // the hook holds before its first read. `loading` tells them apart: until it
  // answers the status line stays empty rather than claiming there is no
  // index (invariant 10).
  const {
    data: info,
    error,
    setError,
    reload: loadStatus,
    loading,
  } = useWorkspaceData<IndexInfo | null>(() => api.searchIndexStatus(), refreshKey);
  const { busy: building, run: runBuild } = useGuardedMutation(setError);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  /** C47: the bar's last moment, flaring at full width before it goes. */
  const [barDone, setBarDone] = useState(false);
  const [summary, setSummary] = useState<IndexSummary | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  /** Bumped only when a search brings back a different list — it remounts the
   *  list, which is what plays C48. The same results again play nothing. */
  const [hitsSeq, setHitsSeq] = useState(0);
  const lastSig = useRef<string | null>(null);
  const { busy: searching, run: runSearch } = useGuardedMutation(setError);

  useEffect(() => {
    const unlisten = listen<IndexProgress>("index://progress", (event) => {
      setProgress(event.payload);
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  async function build() {
    const result: { built: IndexSummary | null } = { built: null };
    await runBuild(async () => {
      setError(null);
      setSummary(null);
      setProgress(null);
      result.built = await api.buildSearchIndex();
      await loadStatus();
    });
    // Outside the guard, not in it: the hook owns the `finally`, and clearing
    // the `index://progress` bar has to happen on both paths regardless.
    if (result.built !== null && !motionOff()) {
      setBarDone(true);
      await new Promise((r) => window.setTimeout(r, DONE_MS));
      setBarDone(false);
    }
    setProgress(null);
    setSummary(result.built);
  }

  function run() {
    if (query.trim() === "") return;
    return runSearch(async () => {
      setError(null);
      const found = await api.searchIndex(query, 30);
      const sig = hitsSig(found);
      if (sig !== lastSig.current) {
        lastSig.current = sig;
        setHitsSeq((n) => n + 1);
      }
      setHits(found);
    });
  }

  const ratio = barDone
    ? 100
    : progress !== null && progress.total > 0
      ? Math.round((progress.indexed / progress.total) * 100)
      : 0;
  const showBar = (building && progress !== null) || barDone;

  return (
    <div className="view sx">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("search.heading")}</h1>
          <p className="view-sub">
            {loading
              ? " "
              : info === null
                ? t("search.noIndex")
                : t("search.status", { files: info.files, chunks: info.chunks, at: info.builtAt })}
          </p>
        </div>
        <div className="header-actions">
          {/* Held in place but unseen until the status is known: "Build" and
              "Rebuild" are both claims about an index nobody has read yet. */}
          <button
            className="btn"
            onClick={() => void build()}
            disabled={building || loading}
            style={loading ? { visibility: "hidden" } : undefined}
          >
            <IconRefresh size={14} />
            {building
              ? progress !== null
                ? t("search.buildingProgress", { done: progress.indexed, total: progress.total })
                : t("search.building")
              : info === null
                ? t("search.build")
                : t("search.rebuild")}
          </button>
        </div>
      </header>

      <ErrorBar error={error} />
      <FlashBar
        message={
          summary &&
          t("search.built", {
            files: summary.files,
            chunks: summary.chunks,
            todos: summary.todos,
            ms: summary.durationMs,
          })
        }
      />

      <section className="panel sx-sec">
        <div className="sx-bar">
          <label className="sx-q">
            <IconSearch size={15} />
            <input
              value={query}
              aria-label={t("search.placeholder")}
              placeholder={t("search.placeholder")}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
            />
          </label>
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={searching || query.trim() === ""}
          >
            <IconSearch size={14} />
            {searching ? t("search.searching") : t("search.go")}
          </button>
        </div>

        {/* C47: steps with the engine's progress (no transition on the width),
            a glow riding its leading edge; flares once when done. */}
        {showBar && (
          <div className={`sx-prog${barDone ? " done" : ""}`} aria-hidden="true">
            <i style={{ width: `${ratio}%` }} />
          </div>
        )}

        {hits !== null && hits.length === 0 && (
          <EmptyState title={t("search.noHits")} hint={t("search.noHitsHint")} />
        )}
        {hits !== null && hits.length > 0 && (
          <ul className="sx-hits" key={hitsSeq}>
            {hits.map((h, i) => (
              <li
                key={`${h.path}-${h.startLine}-${i}`}
                className="sx-hit"
                style={{ "--j": i } as CSSProperties}
              >
                <div className="sx-hh">
                  <span className="rh-file">{h.path}</span>
                  <span className="rh-line">
                    :{h.startLine}–{h.endLine}
                  </span>
                  {h.language && <span className="chip">{h.language}</span>}
                </div>
                <pre className="snippet">
                  {snippetParts(h.snippet).map((p, k) =>
                    p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>,
                  )}
                </pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
