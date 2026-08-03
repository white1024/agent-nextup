import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { api } from "../api";
import { useGuardedMutation, useWorkspaceData } from "../hooks";
import EmptyState from "../components/EmptyState";
import { IconRefresh, IconSearch } from "../components/icons";
import type { IndexInfo, IndexProgress, IndexSummary, SearchHit } from "../types";

interface Props {
  refreshKey: number;
}

export default function Search({ refreshKey }: Props) {
  const { t } = useTranslation();
  // The backend returns null when no index has been built yet; the hook's
  // null-data state and that "no index" state render the same header line.
  const {
    data: info,
    error,
    setError,
    reload: loadStatus,
  } = useWorkspaceData<IndexInfo | null>(() => api.searchIndexStatus(), refreshKey);
  const { busy: building, run: runBuild } = useGuardedMutation(setError);
  const [progress, setProgress] = useState<IndexProgress | null>(null);
  const [summary, setSummary] = useState<IndexSummary | null>(null);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
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
    await runBuild(async () => {
      setError(null);
      setSummary(null);
      setProgress(null);
      setSummary(await api.buildSearchIndex());
      await loadStatus();
    });
    // Outside the guard, not in it: the hook owns the `finally`, and clearing
    // the `index://progress` bar has to happen on both paths regardless.
    setProgress(null);
  }

  function run() {
    if (query.trim() === "") return;
    return runSearch(async () => {
      setError(null);
      setHits(await api.searchIndex(query, 30));
    });
  }

  const ratio =
    progress !== null && progress.total > 0
      ? Math.round((progress.indexed / progress.total) * 100)
      : 0;

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("search.heading")}</h1>
          <p className="view-sub">
            {info === null
              ? t("search.noIndex")
              : t("search.status", { files: info.files, chunks: info.chunks, at: info.builtAt })}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn" onClick={() => void build()} disabled={building}>
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

      {error && <div className="alert alert-error">{error}</div>}
      {summary && (
        <div className="alert alert-ok">
          {t("search.built", {
            files: summary.files,
            chunks: summary.chunks,
            todos: summary.todos,
            ms: summary.durationMs,
          })}
        </div>
      )}

      <section className="panel">
        <div className="search-bar">
          <input
            value={query}
            aria-label={t("search.placeholder")}
            placeholder={t("search.placeholder")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void run();
            }}
          />
          <button
            className="btn btn-primary"
            onClick={() => void run()}
            disabled={searching || query.trim() === ""}
          >
            <IconSearch size={14} />
            {searching ? t("search.searching") : t("search.go")}
          </button>
        </div>

        {building && progress !== null && (
          <div className="index-progress" aria-hidden="true">
            <div className="bar" style={{ width: `${ratio}%` }} />
          </div>
        )}

        {hits !== null && hits.length === 0 && (
          <EmptyState title={t("search.noHits")} hint={t("search.noHitsHint")} />
        )}
        {hits !== null && hits.length > 0 && (
          <ul className="result-list">
            {hits.map((h, i) => (
              <li key={`${h.path}-${h.startLine}-${i}`} className="result-item">
                <div className="result-head">
                  <span className="rh-file">{h.path}</span>
                  <span className="rh-line">
                    :{h.startLine}–{h.endLine}
                  </span>
                  {h.language && <span className="chip">{h.language}</span>}
                </div>
                <pre className="snippet">{h.snippet}</pre>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
