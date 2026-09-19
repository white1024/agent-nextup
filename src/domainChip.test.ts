import { describe, expect, it } from "vitest";

// `?raw` for the reason navigation.test.ts uses it: what is held here is not
// behaviour a function exposes but *where a rule is allowed to live*. It sits
// at the root rather than next to lib/domain.ts because lib/ may not import a
// view — the layering guard (D111) caught this test doing exactly that.
import dashboard from "./views/dashboard/index.tsx?raw";
import projects from "./views/projects/index.tsx?raw";

describe("the unset-domain rule has one home", () => {
  // How this was found: the project grid hid "general" with an inline literal
  // and the dashboard, which never got the same line, went on showing a chip
  // that said the same word on every workspace. Two copies of a rule is how
  // one of them stays wrong for seven weeks; a literal here means a third.
  it.each([
    ["dashboard", dashboard],
    ["projects", projects],
  ])("has %s ask shownDomain instead of comparing the word itself", (_name, src) => {
    expect(src).toContain("shownDomain(");
    expect(src, "the unset domain is compared inline again").not.toMatch(
      /[=!]==\s*["']general["']/,
    );
  });
});
