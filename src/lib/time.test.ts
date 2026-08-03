import { describe, expect, it } from "vitest";
import { absoluteTime, clockTime, dayHeading, relativeTime } from "./time";

/**
 * Timestamps are built from local-time components and read back the same way,
 * so every assertion below holds in any timezone: `relativeTime` compares two
 * instants and derives calendar days locally, and both sides move together.
 */
function localIso(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

const NOW = new Date(2026, 6, 31, 9, 0); // 2026-07-31 09:00 local

describe("relativeTime", () => {
  it("reads anything under a minute as now", () => {
    expect(relativeTime(new Date(NOW.getTime() - 30_000).toISOString(), "en", NOW)).toBe("now");
  });

  // A file stamped by a machine whose clock runs ahead must not read "in 3
  // hours" — the timestamp is not a promise about the future.
  it("reads a future timestamp as now rather than counting forward", () => {
    const ahead = new Date(NOW.getTime() + 3 * 60 * 60_000).toISOString();
    expect(relativeTime(ahead, "en", NOW)).toBe("now");
  });

  it("counts minutes, then hours, inside the same calendar day", () => {
    expect(relativeTime(new Date(NOW.getTime() - 5 * 60_000).toISOString(), "en", NOW)).toBe(
      "5 minutes ago",
    );
    expect(relativeTime(localIso(2026, 7, 31, 6, 0), "en", NOW)).toBe("3 hours ago");
  });

  // The reason day units are computed from calendar days and not from elapsed
  // milliseconds: 23:50 last night is nine hours back, but "yesterday" is what
  // a person means by it.
  it("calls last night yesterday, not nine hours ago", () => {
    expect(relativeTime(localIso(2026, 7, 30, 23, 50), "en", NOW)).toBe("yesterday");
  });

  it("counts days, then weeks", () => {
    expect(relativeTime(localIso(2026, 7, 28, 9, 0), "en", NOW)).toBe("3 days ago");
    // Ten days is one whole week plus change; Intl's `numeric: "auto"` renders
    // a single week back as "last week" rather than "1 week ago".
    expect(relativeTime(localIso(2026, 7, 21, 9, 0), "en", NOW)).toBe("last week");
    expect(relativeTime(localIso(2026, 7, 11, 9, 0), "en", NOW)).toBe("2 weeks ago");
  });

  // Past a month the relative form stops being informative ("13 months ago" is
  // worse than the date it stands for), so it hands over to the absolute one.
  it("falls back to the absolute date past a month", () => {
    const old = localIso(2026, 6, 1, 9, 0);
    expect(relativeTime(old, "en", NOW)).toBe(absoluteTime(old, "en"));
  });

  it("returns an unparseable timestamp untouched instead of rendering NaN", () => {
    expect(relativeTime("not a timestamp", "en", NOW)).toBe("not a timestamp");
  });
});

describe("absolute formats", () => {
  it("renders clock time in 24h form", () => {
    expect(clockTime(localIso(2026, 7, 30, 21, 4), "en")).toBe("21:04");
  });

  it("renders a day heading with the full month and year", () => {
    const heading = dayHeading(localIso(2026, 7, 30, 21, 4), "en");
    expect(heading).toMatch(/July/);
    expect(heading).toMatch(/2026/);
  });

  // The formatter cache is keyed per language. Were the key ever collapsed to a
  // single entry, whichever language rendered first would win for all of them —
  // silently, since both outputs are well-formed dates.
  it("keeps one formatter per language rather than one overall", () => {
    const at = localIso(2026, 7, 30, 21, 4);
    expect(absoluteTime(at, "en")).not.toBe(absoluteTime(at, "zh-TW"));
  });
});
