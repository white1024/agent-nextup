import { describe, expect, it } from "vitest";
import { shortTemplateDescription, splitAroundCount, workspaceName } from "./format";
import type { WorkspaceOverview } from "../types";

/** Only the two fields workspaceName reads; the rest of the overview row is
 *  irrelevant to it and spelling it out would only date this file. */
const ws = (root: string, name: string) => ({ root, name }) as WorkspaceOverview;

describe("workspaceName", () => {
  it("prefers the name the project declares", () => {
    const overview = [ws("C:\\ws\\agent-nextup-dev", "Agent NextUp")];
    expect(workspaceName(overview, "C:\\ws\\agent-nextup-dev")).toBe("Agent NextUp");
  });

  // A running session can outlive its registry entry (drop the project from
  // the recent list, the agent keeps running), and the pop-out window renders
  // before its first `recent_workspaces` resolves. Both land here.
  it("falls back to the folder name when the registry has no row", () => {
    expect(workspaceName([], "C:\\ws\\agent-nextup-dev")).toBe("agent-nextup-dev");
    expect(workspaceName(null, "/srv/projects/shop-api")).toBe("shop-api");
  });

  it("ignores a trailing separator rather than answering with an empty name", () => {
    expect(workspaceName(null, "C:\\ws\\shop\\")).toBe("shop");
    expect(workspaceName(null, "/srv/shop/")).toBe("shop");
  });

  // Roots are compared whole: a project nested inside another must not
  // inherit its parent's name just because the path starts the same way.
  it("matches the root exactly, not by prefix", () => {
    const overview = [ws("C:\\ws\\shop", "Shop")];
    expect(workspaceName(overview, "C:\\ws\\shop-api")).toBe("shop-api");
  });
});

describe("splitAroundCount", () => {
  it("splits a sentence around its number", () => {
    expect(splitAroundCount((n) => `${n} gate(s)`)).toEqual(["", " gate(s)"]);
    expect(splitAroundCount((n) => `gates: ${n}`)).toEqual(["gates: ", ""]);
  });

  it("keeps the whole sentence when the number is missing", () => {
    expect(splitAroundCount(() => "gates")).toEqual(["gates", ""]);
  });
});

describe("shortTemplateDescription", () => {
  it("takes the phase chain out and keeps the other half of the sentence", () => {
    expect(shortTemplateDescription("Spec → Implement → Verify → Release → Retrospect, with built-in quality gates.")).toBe(
      "With built-in quality gates",
    );
    expect(shortTemplateDescription("A basic loop for any domain: Plan → Execute → Review → Retrospect.")).toBe(
      "A basic loop for any domain",
    );
    expect(shortTemplateDescription("Clarify → Plan → Act → Reflect, a lightweight loop.")).toBe("A lightweight loop");
  });

  it("leaves nothing when the description was only the chain", () => {
    expect(shortTemplateDescription("Discover → Strategy → Execute → Measure → Retrospect.")).toBe("");
  });

  it("reads full-width punctuation the same way (the zh-TW built-ins)", () => {
    // "A → B → C<comma>X<stop>" and "Y<colon>A → B<stop>", full-width, written as
    // escapes (no CJK in source, D81). x is a zh-TW template name.
    const comma = "\uff0c";
    const stop = "\u3002";
    const colon = "\uff1a";
    const x = "\u5167\u5efa\u54c1\u8cea\u95dc\u5361";
    expect(shortTemplateDescription(`a → b → c${comma}${x}${stop}`)).toBe(x);
    expect(shortTemplateDescription(`${x}${colon}a → b → c${stop}`)).toBe(x);
    expect(shortTemplateDescription(`a → b${stop}`)).toBe("");
  });

  it("only trims a description with no chain in it", () => {
    expect(shortTemplateDescription("Our own release checklist.")).toBe("Our own release checklist");
    expect(shortTemplateDescription("")).toBe("");
  });
});
