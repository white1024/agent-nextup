import { describe, expect, it } from "vitest";
import { elidePath } from "./PathLabel";

describe("elidePath", () => {
  it("leaves a path that already fits alone", () => {
    expect(elidePath("C:\\ws\\agent-nextup")).toBe("C:\\ws\\agent-nextup");
  });

  it("elides the middle and keeps the informative tail", () => {
    expect(elidePath("C:\\ws\\dev\\clients\\acme\\api", 20)).toBe("C:\\…\\acme\\api");
  });

  it("follows the separator the path actually uses", () => {
    expect(elidePath("/srv/dev/clients/acme/api", 20)).toBe("srv/…/acme/api");
  });

  // r2 3-4. A delivery's attachment directory ends in a bare UUID, which is
  // exactly the segment the elision above protects — so without this the one
  // unreadable part of the path was the one guaranteed to survive.
  it("shortens a UUID segment even when it is the tail", () => {
    expect(
      elidePath(
        "C:\\ws\\projects\\shop\\.nextup\\attachments\\c414c1da-1b2c-4d3e-8f90-fd003735bdcf",
      ),
    ).toBe("C:\\…\\attachments\\c414c1da…");
  });

  // Shortening can bring a path back under the limit on its own; when it does,
  // there is nothing left to elide and the middle should stay readable.
  it("does not elide a path the UUID shortening alone made short enough", () => {
    expect(elidePath("C:\\ws\\out\\c414c1da-1b2c-4d3e-8f90-fd003735bdcf")).toBe(
      "C:\\ws\\out\\c414c1da…",
    );
  });

  it("only touches a segment that is nothing but a UUID", () => {
    const named = "C:\\ws\\run-c414c1da-1b2c-4d3e-8f90-fd003735bdcf";
    expect(elidePath(named)).toBe(named);
  });
});
