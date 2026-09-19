import { describe, expect, it } from "vitest";

import { clampZoom, ZOOM_DEFAULT, ZOOM_STEPS } from "./zoom";

// Only clampZoom is covered: everything else in zoom.ts either reaches
// localStorage or calls into Tauri, and vitest runs here with no DOM and no
// webview. The clamp is the part with a failure mode worth a guard.
describe("clampZoom", () => {
  it("snaps to an offered step", () => {
    expect(clampZoom(1.2)).toBe(1.25);
    expect(clampZoom(0.83)).toBe(0.8);
    expect(ZOOM_STEPS).toContain(clampZoom(1.07));
  });

  it("never returns a factor outside the offered set", () => {
    // The one that matters: a stored 4 would put every control off screen,
    // including the one that would put it back. Snapping on *read* is what
    // makes that unreachable rather than merely discouraged.
    for (const wild of [4, 0.1, -3, 100]) {
      expect(ZOOM_STEPS).toContain(clampZoom(wild));
    }
  });

  it("falls back to the default for anything that is not a number", () => {
    expect(clampZoom(NaN)).toBe(ZOOM_DEFAULT);
    expect(clampZoom(Infinity)).toBe(ZOOM_DEFAULT);
  });

  it("keeps 1 in the set, since that is what removing the preference means", () => {
    // setZoom() deletes the key at ZOOM_DEFAULT and getZoom() answers
    // ZOOM_DEFAULT for a missing key — if 1 ever left ZOOM_STEPS those two
    // would disagree with the buttons.
    expect(ZOOM_STEPS).toContain(ZOOM_DEFAULT);
  });
});
