import { describe, expect, it } from "vitest";

// D171: an ongoing project has no gates, and an empty gate list must not read
// as "every gate passed — go advance" (it did, for one build, before this
// guard). `?raw` because what is held is where a rule lives.
import actionBarSource from "./ActionBar.tsx?raw";

describe("the action bar on an ongoing project", () => {
  it("handles ongoing before it reads an empty gate list as ready", () => {
    const ongoing = actionBarSource.indexOf('status.workflow.mode === "ongoing"');
    const ready = actionBarSource.indexOf("failing.length === 0");
    expect(ongoing).toBeGreaterThan(-1);
    expect(ready).toBeGreaterThan(ongoing);
  });
});
