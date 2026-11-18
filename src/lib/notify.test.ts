import { describe, expect, it } from "vitest";

import { unreadFor } from "./notify";
import type { DeliverySummary } from "../types";

// Only the pure half of notify.ts is covered here, as with prefs.test.ts:
// everything else in the module reaches localStorage, and vitest runs in the
// node environment with no DOM.

const row = (id: string, extra: Partial<DeliverySummary> = {}): DeliverySummary => ({
  id,
  from: { workspaceId: "w-up", name: "upstream" },
  payloadType: "note",
  attachmentCount: 0,
  publishedAt: "2026-11-15T00:00:00Z",
  ...extra,
});

describe("unreadFor", () => {
  it("is unread until this machine has seen it", () => {
    expect(unreadFor(new Set(), row("a"))).toBe(true);
    expect(unreadFor(new Set(["a"]), row("a"))).toBe(false);
  });

  it("counts the project's own agent reading it as read (D160)", () => {
    // The career-learning case: never opened on this machine, but the agent
    // had read it — the toast came back on every start-up.
    const picked = row("a", { agentReadAt: "2026-10-20T10:02:37Z", agentReadBy: "claude" });
    expect(unreadFor(new Set(), picked)).toBe(false);
    // An agent with no name still counts; the time is what matters.
    expect(unreadFor(new Set(), row("b", { agentReadAt: "2026-10-20T10:02:37Z" }))).toBe(false);
  });

  it("finds nothing new in a mailbox this machine has never listed", () => {
    expect(unreadFor(null, row("a"))).toBe(false);
  });
});
