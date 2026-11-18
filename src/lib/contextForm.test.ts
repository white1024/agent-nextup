import { describe, expect, it } from "vitest";

import type { ProjectContext } from "../types";
import { dirtyFields, formOf, isDirty, nameMissing, renames, splitLines } from "./contextForm";

function ctx(over: Partial<ProjectContext> = {}): ProjectContext {
  return {
    schemaVersion: 1,
    name: "demo",
    domain: "coding",
    description: "a demo",
    goals: ["ship it"],
    boundaries: ["no paid APIs"],
    milestones: [],
    rejected: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("splitLines", () => {
  it("keeps one trimmed entry per non-empty line", () => {
    expect(splitLines("  a \n\n b\n   \n")).toEqual(["a", "b"]);
    expect(splitLines("")).toEqual([]);
  });
});

describe("project info form", () => {
  it("opens clean: a context and its own form are never dirty", () => {
    expect(isDirty(formOf(ctx()), ctx())).toBe(false);
    // The unset domain shows as an empty field and round-trips as unset.
    const unset = ctx({ domain: "general" });
    expect(formOf(unset).domain).toBe("");
    expect(isDirty(formOf(unset), unset)).toBe(false);
  });

  it("ignores edits the engine would normalise away", () => {
    const form = { ...formOf(ctx()), goals: "  ship it  \n\n", description: " a demo " };
    expect(isDirty(form, ctx())).toBe(false);
  });

  it("sees a real change in each field, the name included", () => {
    const base = formOf(ctx());
    expect(isDirty({ ...base, name: "renamed" }, ctx())).toBe(true);
    expect(isDirty({ ...base, domain: "research" }, ctx())).toBe(true);
    expect(isDirty({ ...base, description: "another" }, ctx())).toBe(true);
    expect(isDirty({ ...base, goals: "ship it\nmeasure it" }, ctx())).toBe(true);
    expect(isDirty({ ...base, boundaries: "" }, ctx())).toBe(true);
  });

  it("names exactly the fields that changed, in form order", () => {
    const base = formOf(ctx());
    expect(dirtyFields(base, ctx())).toEqual([]);
    expect(dirtyFields({ ...base, boundaries: "", name: "renamed" }, ctx())).toEqual(["name", "boundaries"]);
    // Normalised per field: padding one field does not mark it, editing another does.
    expect(dirtyFields({ ...base, description: " a demo ", goals: "ship it\nmeasure it" }, ctx())).toEqual([
      "goals",
    ]);
  });

  it("ignores padding around the name, as the engine trims it", () => {
    const form = { ...formOf(ctx()), name: "  demo " };
    expect(isDirty(form, ctx())).toBe(false);
    expect(renames(form, ctx())).toBe(false);
    expect(renames({ ...form, name: "demo 2" }, ctx())).toBe(true);
  });

  it("will not offer a blank name", () => {
    expect(nameMissing({ ...formOf(ctx()), name: "   " })).toBe(true);
    expect(nameMissing(formOf(ctx()))).toBe(false);
  });

  it("treats emptying the domain field as setting it back to unset", () => {
    expect(isDirty({ ...formOf(ctx()), domain: "  " }, ctx())).toBe(true);
    expect(isDirty({ ...formOf(ctx({ domain: "general" })), domain: "  " }, ctx({ domain: "general" }))).toBe(
      false,
    );
  });
});
