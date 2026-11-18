import { useTranslation } from "react-i18next";

import { useFreshKeys } from "../../hooks/anim";
import { clockSeconds } from "../../lib/time";
import { motionOff } from "../../lib/fx";
import type { FeedRow } from "./overviewModel";

/** One row, already resolved to words by the page. */
export interface FeedItem extends FeedRow {
  who: string;
  project: string;
}

/**
 * C12, the live stream (spec 20 §1, §2): the newest agent hub calls across
 * every project. Nine rows and no scroll — it is a pulse, not a log; the
 * ledger page is where history is read.
 *
 * `rows === null` is "not read yet" and draws the frame with nothing in it
 * rather than an empty-state sentence (invariant 10).
 */
export default function LiveFeed({ rows }: { rows: FeedItem[] | null }) {
  const { t, i18n } = useTranslation();
  const fresh = useFreshKeys((rows ?? []).map((r) => r.key), 1000);
  const amb = motionOff() ? "" : " amb";

  return (
    <aside className="feed" aria-label={t("welcome.feedTitle")}>
      <div className="feed-h">
        <i className={`dot-run${amb}`} aria-hidden="true" />
        {t("welcome.feedTitle")}
        <small>{t("welcome.feedSub")}</small>
      </div>
      {rows !== null && rows.length === 0 && <p className="feed-empty">{t("welcome.feedEmpty")}</p>}
      <ol>
        {(rows ?? []).map((r) => {
          const denied = r.outcome === "denied";
          const failed = r.outcome === "failed";
          const what = denied
            ? t("welcome.feedNotAuthorized")
            : (r.detail ?? (failed ? t("welcome.feedFailed") : (r.taskId ?? "")));
          return (
            <li
              key={r.key}
              className={`fi${denied ? " deny" : ""}${fresh.has(r.key) ? " in" : ""}`}
            >
              <time dateTime={r.at}>{clockSeconds(r.at, i18n.language)}</time>
              <span className="who">
                {denied ? (
                  <i className="mk-y" aria-hidden="true" />
                ) : (
                  <i className="dot-run" aria-hidden="true" />
                )}
                <span>{r.who}</span>
              </span>
              <span className="fi-tool">
                <code>{r.tool ?? "?"}</code>
                {denied && <b className="deny-tag">{t("welcome.feedDenied")}</b>}
              </span>
              <span className="msg">
                {what === "" ? r.project : `${r.project} · ${what}`}
              </span>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
