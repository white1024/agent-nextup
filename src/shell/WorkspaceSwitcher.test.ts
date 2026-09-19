import { describe, expect, it } from "vitest";

import { menuSlice } from "./WorkspaceSwitcher";

describe("menuSlice", () => {
  it("keeps the head, which is the most recently opened", () => {
    const { listed } = menuSlice(["a", "b", "c", "d"], 2);
    expect(listed).toEqual(["a", "b"]);
  });

  /** The cap is only allowed to be silent when it cut nothing. */
  it("reports nothing hidden while everything fits", () => {
    expect(menuSlice(["a", "b"], 6).hidden).toBe(0);
    expect(menuSlice(["a", "b", "c", "d", "e", "f"], 6).hidden).toBe(0);
  });

  it("counts exactly what it left out", () => {
    const all = Array.from({ length: 30 }, (_, i) => `p${i}`);
    const { listed, hidden } = menuSlice(all, 6);
    expect(listed).toHaveLength(6);
    expect(hidden).toBe(24);
    expect(listed.length + hidden).toBe(all.length);
  });

  /**
   * `recent` is null until the first read returns — the menu can be open
   * before it lands. A negative remainder there would render as "-6 more
   * projects" in the row that exists to reassure.
   */
  it("is empty, not negative, before the list has been read", () => {
    expect(menuSlice(null, 6)).toEqual({ listed: [], hidden: 0 });
  });
});
