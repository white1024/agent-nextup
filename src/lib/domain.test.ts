import { describe, expect, it } from "vitest";

import { UNSET_DOMAIN, shownDomain } from "./domain";

describe("shownDomain", () => {
  it("shows a domain someone actually chose", () => {
    expect(shownDomain("coding")).toBe("coding");
    expect(shownDomain("  side project  ")).toBe("side project");
  });

  it("hides the unset value, whatever shape it arrives in", () => {
    // Three ways the same nothing reaches the UI: the word init writes, an
    // empty string, and a workspace record that predates the field.
    expect(shownDomain(UNSET_DOMAIN)).toBeNull();
    expect(shownDomain("   ")).toBeNull();
    expect(shownDomain(undefined)).toBeNull();
    expect(shownDomain(null)).toBeNull();
  });

  it("does not treat a domain that merely contains the unset word as unset", () => {
    // "general" is the fallback; "general research" is someone's answer.
    expect(shownDomain("general research")).toBe("general research");
  });
});
