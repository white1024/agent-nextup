/**
 * One place for every timestamp the app renders (D61 / product review §5-5).
 *
 * Before this module every view built its own `Intl.DateTimeFormat` — eleven
 * constructions across seven files, with different options — so the same
 * instant read differently depending on which page you were looking at. The rule now:
 *
 * - **Relative** ("3 minutes ago", "yesterday") is what a person actually wants to know —
 *   how stale is this? — so it is the default rendering.
 * - **Absolute** stays one hover away, never lost: `<TimeAgo>` puts it in the
 *   `title`, and surfaces that group by day (the ledger) still use it directly.
 *
 * Formatters are cached per language: constructing `Intl.*` is not free and
 * these run once per row in lists that can hold hundreds of events.
 */

const cache = new Map<string, Intl.DateTimeFormat | Intl.RelativeTimeFormat>();

function cached<T extends Intl.DateTimeFormat | Intl.RelativeTimeFormat>(
  key: string,
  make: () => T,
): T {
  const hit = cache.get(key);
  if (hit) return hit as T;
  const made = make();
  cache.set(key, made);
  return made;
}

/** Clock time only ("21:04") — for rows already grouped under a day heading. */
export function clockTime(at: string, lang: string): string {
  return cached(`clock:${lang}`, () =>
    new Intl.DateTimeFormat(lang, { hour: "2-digit", minute: "2-digit", hour12: false }),
  ).format(new Date(at));
}

/** Full date + time — the tooltip behind every relative label. */
export function absoluteTime(at: string, lang: string): string {
  return cached(`full:${lang}`, () =>
    new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }),
  ).format(new Date(at));
}

/** Day heading ("19 July 2026") — the ledger's per-day group titles. */
export function dayHeading(at: string, lang: string): string {
  return cached(`day:${lang}`, () => new Intl.DateTimeFormat(lang, { dateStyle: "long" })).format(
    new Date(at),
  );
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * "now" / "5 minutes ago" / "yesterday" / "3 weeks ago". Anything past a
 * month falls back to the absolute date: "13 months ago" is worse than the
 * date it stands for.
 *
 * Day-level units are computed from **calendar days**, not elapsed milliseconds,
 * so 23:50 yesterday reads "yesterday" rather than "10 hours ago".
 */
export function relativeTime(at: string, lang: string, now: Date = new Date()): string {
  const then = new Date(at);
  const rtf = cached(`rel:${lang}`, () => new Intl.RelativeTimeFormat(lang, { numeric: "auto" }));
  const diff = now.getTime() - then.getTime();

  if (!Number.isFinite(diff)) return at;
  // Also catches negative diffs: a file stamped by a machine whose clock runs
  // ahead should read "now", never "in 3 hours".
  if (diff < MINUTE) return rtf.format(0, "second");
  if (diff < HOUR) return rtf.format(-Math.floor(diff / MINUTE), "minute");

  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(now) - midnight(then)) / DAY);
  if (days === 0) return rtf.format(-Math.floor(diff / HOUR), "hour");
  if (days < 7) return rtf.format(-days, "day");
  if (days < 30) return rtf.format(-Math.floor(days / 7), "week");
  return absoluteTime(at, lang);
}
