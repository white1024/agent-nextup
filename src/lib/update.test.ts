import { describe, expect, it } from "vitest";

import { downloadPercent, releasePageUrl } from "./update";

describe("releasePageUrl", () => {
  it("points at the tag the release workflow creates", () => {
    expect(releasePageUrl("0.2.0")).toBe("https://github.com/white1024/agent-nextup/releases/tag/v0.2.0");
    // The updater reports bare versions, but a v-prefixed one must not double up.
    expect(releasePageUrl("v0.2.0")).toBe("https://github.com/white1024/agent-nextup/releases/tag/v0.2.0");
  });
});

describe("downloadPercent", () => {
  it("has no number when the size is unknown", () => {
    expect(downloadPercent(1000, null)).toBeNull();
    expect(downloadPercent(1000, 0)).toBeNull();
  });

  it("only says 100 once the last byte is in", () => {
    expect(downloadPercent(0, 200)).toBe(0);
    expect(downloadPercent(199, 200)).toBe(99);
    expect(downloadPercent(200, 200)).toBe(100);
  });
});
