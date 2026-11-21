import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";

import { api, errorMessage } from "../../api";
import EmptyState from "../../components/EmptyState";
import type { LedgerEvent, Question } from "../../types";

interface Props {
  refreshKey: number;
  onMutated: () => void;
}

/** How many answered questions the page keeps in view, newest first. */
const ANSWERED_SHOWN = 10;

/**
 * To decide (D170): the questions agents asked instead of stopping the chat,
 * and the decisions they took on a default and left for review. Everything
 * here is the person's to settle, at their own pace — an answer is ledgered as
 * a decision, and a review supersedes the provisional one.
 */
export default function Decide({ refreshKey, onMutated }: Props) {
  const { t } = useTranslation();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [pending, setPending] = useState<LedgerEvent[]>([]);
  // Typed answers and revisions, keyed by question or decision id.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revising, setRevising] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [qs, ds] = await Promise.all([api.listQuestions(), api.listProvisionalDecisions()]);
      setQuestions(qs);
      setPending(ds);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // A provisional decision is a ledger line and nothing else, so the watcher's
  // state signal never fires for it; the ledger's own signal does.
  useEffect(() => {
    const unlisten = listen("ledger://appended", () => {
      void load();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [load]);

  async function act(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await run();
      setDrafts((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
      setRevising(null);
      await load();
      onMutated();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const draft = (id: string, fallback: string) => drafts[id] ?? fallback;
  const setDraft = (id: string, text: string) => setDrafts((d) => ({ ...d, [id]: text }));

  const open = (questions ?? []).filter((q) => q.status === "open");
  const answered = (questions ?? [])
    .filter((q) => q.status === "answered")
    .slice(-ANSWERED_SHOWN)
    .reverse();
  const loaded = questions !== null;

  return (
    <div className="view view--decide">
      <header className="view-header">
        <div className="vh-main">
          <h1>{t("decide.heading")}</h1>
          <p className="view-sub">{t("decide.subtitle")}</p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}

      {loaded && open.length === 0 && pending.length === 0 && (
        <section className="panel">
          <EmptyState title={t("decide.emptyTitle")} hint={t("decide.emptyHint")} />
        </section>
      )}

      {open.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("decide.questions", { n: open.length })}</h2>
          </div>
          <ol className="dq-list">
            {open.map((q) => {
              const text = draft(q.id, q.recommendation ?? "");
              return (
                <li key={q.id} className="dq">
                  <div className="dq-meta">
                    <span className="dq-id">{q.id}</span>
                    {q.ask && <span className="dq-chip dq-chip--fwd">{t("decide.forward", { who: q.ask })}</span>}
                    {q.blocks && q.blocks.length > 0 && (
                      <span className="dq-chip">{t("decide.holds", { ids: q.blocks.join(", ") })}</span>
                    )}
                    {q.askedBy && <span className="dq-by">{t("decide.askedBy", { who: q.askedBy })}</span>}
                  </div>
                  <p className="dq-q">{q.question}</p>
                  {q.recommendation && (
                    <p className="dq-rec">
                      <b>{t("decide.recommendation")}</b> {q.recommendation}
                    </p>
                  )}
                  {q.defaultAnswer && <p className="dq-def">{t("decide.defaultAnswer", { a: q.defaultAnswer })}</p>}
                  {q.options && q.options.length > 0 && (
                    <div className="dq-opts">
                      {q.options.map((o) => (
                        <button
                          key={o}
                          className={`btn btn-small${text === o ? " is-on" : ""}`}
                          aria-pressed={text === o}
                          onClick={() => setDraft(q.id, o)}
                        >
                          {o}
                        </button>
                      ))}
                    </div>
                  )}
                  <textarea
                    className="dq-answer"
                    rows={2}
                    value={text}
                    aria-label={`${q.id} ${t("decide.answerPlaceholder")}`}
                    placeholder={t("decide.answerPlaceholder")}
                    onChange={(e) => setDraft(q.id, e.target.value)}
                  />
                  <div className="form-actions">
                    <button
                      className="btn btn-ghost btn-small"
                      disabled={busy !== null}
                      onClick={() => void act(q.id, () => api.withdrawQuestion(q.id))}
                    >
                      {t("decide.withdraw")}
                    </button>
                    <button
                      className="btn btn-primary btn-small"
                      disabled={busy !== null || text.trim() === ""}
                      onClick={() => void act(q.id, () => api.answerQuestion(q.id, text))}
                    >
                      {q.recommendation && text === q.recommendation ? t("decide.useRecommendation") : t("decide.submit")}
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {pending.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("decide.toReview", { n: pending.length })}</h2>
          </div>
          <p className="view-sub dq-lead">{t("decide.toReviewHint")}</p>
          <ol className="dq-list">
            {pending.map((d) => {
              const id = d.id ?? d.at;
              const editing = revising === id;
              const text = draft(id, d.message);
              return (
                <li key={id} className="dq">
                  <div className="dq-meta">
                    <span className="dq-id">{d.id}</span>
                    {d.actor && <span className="dq-by">{t("decide.takenBy", { who: d.actor })}</span>}
                  </div>
                  <p className="dq-q">{d.message}</p>
                  {editing && (
                    <textarea
                      className="dq-answer"
                      rows={3}
                      value={text}
                      aria-label={`${id} ${t("decide.revise")}`}
                      onChange={(e) => setDraft(id, e.target.value)}
                    />
                  )}
                  <div className="form-actions">
                    {editing ? (
                      <>
                        <button className="btn btn-ghost btn-small" onClick={() => setRevising(null)}>
                          {t("common.cancel")}
                        </button>
                        <button
                          className="btn btn-primary btn-small"
                          disabled={busy !== null || text.trim() === ""}
                          onClick={() => void act(id, () => api.reviewDecision(id, text))}
                        >
                          {t("decide.submitRevision")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-ghost btn-small"
                          disabled={busy !== null}
                          onClick={() => setRevising(id)}
                        >
                          {t("decide.revise")}
                        </button>
                        <button
                          className="btn btn-primary btn-small"
                          disabled={busy !== null}
                          onClick={() => void act(id, () => api.reviewDecision(id))}
                        >
                          {t("decide.confirm")}
                        </button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {answered.length > 0 && (
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">{t("decide.answered")}</h2>
          </div>
          <ul className="dq-done">
            {answered.map((q) => (
              <li key={q.id}>
                <span className="dq-id">{q.id}</span>
                <span className="dq-done-q">{q.question}</span>
                <span className="dq-done-a">→ {q.answer}</span>
                <span className={`dq-seen${q.seenAt ? "" : " is-unread"}`}>
                  {q.seenAt ? t("decide.agentRead") : t("decide.agentUnread")}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
