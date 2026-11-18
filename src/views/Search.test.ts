import { describe, expect, it } from "vitest";

import { snippetParts } from "./Search";

// The engine marks matches with « and » (index/store.rs, FTS5 snippet()).
// The search page turns them into <mark>; the markers must never reach the
// screen, and nothing in a snippet may become markup.
describe("snippetParts", () => {
  it("splits matches out of the text and drops the markers", () => {
    expect(snippetParts(" … the «ledger» is «append»-only … ")).toEqual([
      { text: " … the ", hit: false },
      { text: "ledger", hit: true },
      { text: " is ", hit: false },
      { text: "append", hit: true },
      { text: "-only … ", hit: false },
    ]);
  });

  it("returns plain text when nothing is marked", () => {
    expect(snippetParts("no match here")).toEqual([{ text: "no match here", hit: false }]);
  });

  it("marks the rest when a match is cut before its closing marker", () => {
    expect(snippetParts("start «cut off")).toEqual([
      { text: "start ", hit: false },
      { text: "cut off", hit: true },
    ]);
  });

  it("keeps angle brackets and tags as text", () => {
    const parts = snippetParts("<b>«x»</b>");
    expect(parts.map((p) => p.text).join("")).toBe("<b>x</b>");
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(["x"]);
  });

  it("skips an empty match", () => {
    expect(snippetParts("a«»b")).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: false },
    ]);
  });
});
