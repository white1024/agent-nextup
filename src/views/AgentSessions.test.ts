import { describe, expect, it } from "vitest";

import { initialSelection, stageKind } from "./AgentSessions";
import type { TerminalSessionMeta } from "../types";

function session(over: Partial<TerminalSessionMeta> = {}): TerminalSessionMeta {
  return {
    id: 1,
    root: "C:\\ws\\acme",
    workspaceId: null,
    agentId: "claude",
    title: "Claude Code",
    identity: null,
    startedAt: "2026-09-17T00:00:00Z",
    status: "running",
    exitCode: null,
    poppedOut: false,
    ...over,
  };
}

describe("stageKind", () => {
  it("gives a running, docked session the live pane", () => {
    expect(stageKind(session())).toBe("live");
  });

  /**
   * The one that matters. A popped-out session is *still* `running`, so a
   * version that checked status first would render a second live pane for a
   * PTY that already has one — and input would split between the two xterms,
   * which looks like dropped keystrokes rather than like a bug.
   */
  it("never gives a popped-out session a pane, even though it is running", () => {
    expect(stageKind(session({ poppedOut: true, status: "running" }))).toBe("in-window");
  });

  it("offers no pane for a session with no process behind it", () => {
    expect(stageKind(session({ status: "exited", exitCode: 0 }))).toBe("not-running");
    expect(stageKind(session({ status: "restored" }))).toBe("not-running");
  });

  /**
   * Exited *while* popped out — the case the check order decides. Both answers
   * are safe (neither is "live"), so this pins the chosen one: the window is
   * still on screen, and that is the thing the user can act on.
   */
  it("reports a session that died in its own window as still being in it", () => {
    expect(stageKind(session({ status: "exited", exitCode: 1, poppedOut: true }))).toBe(
      "in-window",
    );
  });

  it("says nothing is selected rather than guessing", () => {
    expect(stageKind(null)).toBe("none");
  });
});

describe("initialSelection", () => {
  const live = session({ id: 1 });
  const other = session({ id: 2 });

  it("comes back to the session that was selected last time", () => {
    expect(initialSelection([live, other], 2)).toBe(2);
  });

  it("falls back to the first usable one when nothing was remembered", () => {
    expect(initialSelection([live, other], null)).toBe(1);
  });

  /**
   * The failure this exists for. A remembered id is only an id: by the time
   * the page reopens that session may be in its own window or dead, and
   * restoring it blind lands the user on an explanation card while a working
   * session sits one row below.
   */
  it("ignores a remembered session that can no longer take a pane", () => {
    expect(initialSelection([live, session({ id: 2, poppedOut: true })], 2)).toBe(1);
    expect(initialSelection([live, session({ id: 2, status: "exited" })], 2)).toBe(1);
  });

  it("ignores a remembered session that is gone entirely", () => {
    expect(initialSelection([live], 99)).toBe(1);
  });

  it("selects nothing rather than something unusable", () => {
    expect(initialSelection([session({ id: 1, status: "restored" })], 1)).toBe(null);
    expect(initialSelection([], null)).toBe(null);
  });
});
