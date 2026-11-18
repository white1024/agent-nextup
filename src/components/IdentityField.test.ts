import { describe, expect, it } from "vitest";

import { identityMatches } from "./IdentityField";

describe("identityMatches (spec 40, C292)", () => {
  const used = ["design", "fe", "qa"];

  it("lists every name while the field is empty", () => {
    expect(identityMatches(used, "")).toEqual(used);
    expect(identityMatches(used, "   ")).toEqual(used);
  });

  // The field opens holding the last name used. Narrowing to that one name
  // would hide the others exactly when someone opens the list to switch.
  it("lists every name while the field holds one of them exactly", () => {
    expect(identityMatches(used, "design")).toEqual(used);
    expect(identityMatches(used, "QA")).toEqual(used);
  });

  it("narrows to names containing what was typed, ignoring case", () => {
    expect(identityMatches(used, "q")).toEqual(["qa"]);
    expect(identityMatches(used, "E")).toEqual(["design", "fe"]);
  });

  it("returns nothing when nothing matches (the list then folds)", () => {
    expect(identityMatches(used, "zz")).toEqual([]);
  });
});
