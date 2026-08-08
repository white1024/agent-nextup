import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import EmptyState from "../components/EmptyState";
import { IconTerminal } from "../components/icons";
import { workspaceName } from "../lib/format";
import type { TerminalSessionMeta, WorkspaceOverview } from "../types";
import TimeAgo from "../components/TimeAgo";
import PathLabel from "../components/PathLabel";

interface Props {
  /** App-owned session list (same source as the sidebar markers); `null`
   *  until the first read resolves. */
  sessions: TerminalSessionMeta[] | null;
  /** Registry catalog — resolves a session root to its project name. */
  overview: WorkspaceOverview[] | null;
  /** Open (or switch to) the workspace and land on its terminal view. */
  onOpen: (root: string) => void;
}

/** App-level agent overview (D50): every terminal session across every
 *  project, grouped by workspace. Read-only surface — launching and typing
 *  happen in the workspace terminal view this navigates to. */
export default function AgentSessions({ sessions, overview, onOpen }: Props) {
  const { t } = useTranslation();

  const groups = useMemo(() => {
    const byRoot = new Map<string, TerminalSessionMeta[]>();
    for (const s of sessions ?? []) {
      const list = byRoot.get(s.root);
      if (list) list.push(s);
      else byRoot.set(s.root, [s]);
    }
    return [...byRoot.entries()];
  }, [sessions]);

  const nameOf = (root: string) => workspaceName(overview, root);

  return (
    <div className="view">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("agentsView.heading")}</h1>
          <p className="view-sub">{t("agentsView.subtitle")}</p>
        </div>
      </header>

      {sessions === null ? null : groups.length === 0 ? (
        <EmptyState title={t("agentsView.empty")} hint={t("agentsView.emptyHint")} />
      ) : (
        groups.map(([root, list]) => (
          <section className="panel" key={root}>
            <div className="panel-head">
              <h2 className="panel-title">{nameOf(root)}</h2>
              <button className="btn btn-small" onClick={() => onOpen(root)}>
                <IconTerminal size={14} /> {t("agentsView.open")}
              </button>
            </div>
            <PathLabel className="ws-card-path" path={root} />
            <div className="key-list">
              {list.map((s) => (
                <div className="key-item" key={s.id}>
                  <div className="tpl-row-main">
                    <span className="tpl-row-name">
                      {s.title}
                      {/* Who this session reports as (D63). Without it two
                          cards in the same project read identically — same
                          CLI, same status, same "started last week" — and the
                          data was already on the wire (r2 3-2). Anonymous is
                          rendered rather than left blank: "no identity" is an
                          answer, and it is the one that cannot claim tasks. */}
                      <span
                        className={`chip term-tab-identity${s.identity === null ? " is-anon" : ""}`}
                        title={t("term.identityLabel")}
                      >
                        {s.identity ?? t("term.identityAnon")}
                      </span>
                      {s.status === "running" ? (
                        <span className="chip chip-term-running">
                          <span className="dot" aria-hidden="true" />
                          {t("agentsView.running")}
                        </span>
                      ) : s.status === "restored" ? (
                        <span className="chip template-badge">{t("term.restored")}</span>
                      ) : (
                        <span className="chip template-badge">
                          {s.exitCode !== null && s.exitCode !== 0
                            ? t("term.exitedWithCode", { n: s.exitCode })
                            : t("term.exited")}
                        </span>
                      )}
                    </span>
                    <span className="tpl-row-meta muted">
                      {t("agentsView.startedAt")} <TimeAgo at={s.startedAt} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
