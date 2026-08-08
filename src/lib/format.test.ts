import { describe, expect, it } from "vitest";
import { workspaceName } from "./format";
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
