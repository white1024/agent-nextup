import { describe, expect, it } from "vitest";

import {
  TERMINAL_FONT_DEFAULT,
  TERMINAL_FONT_MAX,
  TERMINAL_FONT_MIN,
  clampTerminalFontSize,
} from "./prefs";

// Only the pure half of prefs.ts is covered here. Everything else in that module
// reaches localStorage, and vitest runs in the node environment with no DOM —
// testing those would mean adopting jsdom, which this repo has deliberately not
// done (see CONTRIBUTING).
describe("clampTerminalFontSize", () => {
  it("keeps sizes inside the range", () => {
    expect(clampTerminalFontSize(TERMINAL_FONT_MIN - 5)).toBe(TERMINAL_FONT_MIN);
    expect(clampTerminalFontSize(TERMINAL_FONT_MAX + 5)).toBe(TERMINAL_FONT_MAX);
    expect(clampTerminalFontSize(14)).toBe(14);
  });

  it("falls back to the default for anything that is not a number", () => {
    // The stored value is one hand-edit away from this, and a NaN font size
    // makes FitAddon compute zero rows — a terminal that opens blank reads as
    // broken rather than misconfigured.
    expect(clampTerminalFontSize(NaN)).toBe(TERMINAL_FONT_DEFAULT);
    expect(clampTerminalFontSize(Infinity)).toBe(TERMINAL_FONT_DEFAULT);
  });

  it("rounds, so a fractional size can never reach xterm", () => {
    expect(clampTerminalFontSize(13.6)).toBe(14);
  });

  it("has a default inside its own range", () => {
    // Guards the constants against each other: a default outside the clamp
    // would make Ctrl+0 land somewhere other than where it says it does.
    expect(clampTerminalFontSize(TERMINAL_FONT_DEFAULT)).toBe(TERMINAL_FONT_DEFAULT);
  });
});
