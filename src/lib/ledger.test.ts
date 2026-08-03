import { describe, expect, it } from "vitest";
import { eventCat, eventKey, isDeniedCall, shortenIds } from "./ledger";
import type { LedgerEvent } from "../types";

function event(over: Partial<LedgerEvent> = {}): LedgerEvent {
  return { at: "2026-07-30T21:04:00Z", kind: "agent_tool_called", message: "hub.task_add", ...over };
}

describe("isDeniedCall", () => {
  it("reads the structured outcome when the line has one (D75)", () => {
    expect(isDeniedCall(event({ outcome: "denied" }))).toBe(true);
    expect(isDeniedCall(event({ outcome: "ok" }))).toBe(false);
  });

  // The reason the structured field exists. A post-D75 failure whose error text
  // happens to say "denied" is a failure, not a denial — if the regex were ever
  // allowed to judge these lines again, it would light the deny chip on them.
  it("does not let denial wording override the outcome on a post-D75 line", () => {
    const failure = event({ outcome: "failed", message: "write failed: access denied by the OS" });
    expect(isDeniedCall(failure)).toBe(false);
  });

  // The other half of the same contract: lines written before D75 carry no
  // outcome at all, and the wording is the only signal they will ever have.
  it("falls back to the wording only when the outcome is absent", () => {
    expect(isDeniedCall(event({ message: "hub.task_add denied by gate" }))).toBe(true);
    expect(isDeniedCall(event({ message: "hub.task_add ok" }))).toBe(false);
  });

  it("is case-insensitive on the pre-D75 wording", () => {
    expect(isDeniedCall(event({ message: "Denied: phase gate" }))).toBe(true);
  });

  it("only ever speaks for agent_tool_called lines", () => {
    expect(isDeniedCall(event({ kind: "note", message: "denied" }))).toBe(false);
    expect(isDeniedCall(event({ kind: "mcp_tool_called", outcome: "denied" }))).toBe(false);
  });
});

describe("eventCat", () => {
  it("routes a denied call to its own chip family", () => {
    expect(eventCat(event({ outcome: "denied" }))).toBe("deny");
    expect(eventCat(event({ outcome: "ok" }))).toBe("tool");
    expect(eventCat(event({ kind: "mcp_tool_called" }))).toBe("tool");
  });

  it("groups the task lifecycle kinds", () => {
    for (const kind of ["task_created", "task_status_changed", "spec_folded", "task_deleted"] as const) {
      expect(eventCat(event({ kind }))).toBe("task");
    }
  });

  it("groups the gate kinds", () => {
    for (const kind of ["phase_advanced", "gate_confirmed", "workflow_adopted"] as const) {
      expect(eventCat(event({ kind }))).toBe("gate");
    }
  });

  // D78: a session summary sits in the same "read this on takeover" tier as a
  // decision, which is why it borrows the chip rather than falling to default.
  it("gives a progress line the decision chip", () => {
    expect(eventCat(event({ kind: "progress" }))).toBe("decision");
    expect(eventCat(event({ kind: "decision" }))).toBe("decision");
  });

  it("leaves everything else uncategorised", () => {
    expect(eventCat(event({ kind: "workspace_opened" }))).toBe("");
  });
});

describe("shortenIds", () => {
  it("cuts a UUID to the 8-character prefix the rest of the app quotes", () => {
    expect(shortenIds("delivery c414c1da-1b2c-4d3e-8f90-fd003735bdcf published to outbox")).toBe(
      "delivery c414c1da… published to outbox",
    );
  });

  it("shortens every id in the line, in either case", () => {
    const two = shortenIds(
      "AAAAAAAA-1111-2222-3333-444444444444 superseded by bbbbbbbb-1111-2222-3333-444444444444",
    );
    expect(two).toBe("AAAAAAAA… superseded by bbbbbbbb…");
  });

  // The regex is bounded on both ends. A hyphenated word, a short hash or a
  // UUID glued into a longer token is not a machine id the row can drop —
  // mangling those would corrupt the message rather than tidy it.
  it("leaves anything that is not a standalone UUID alone", () => {
    for (const text of [
      "phase advanced: design-review-2 passed",
      "commit 50c819d",
      "task T-0007 blocked",
      "xc414c1da-1b2c-4d3e-8f90-fd003735bdcfx",
    ]) {
      expect(shortenIds(text)).toBe(text);
    }
  });

  it("is a no-op on a message with no ids at all", () => {
    expect(shortenIds("Decision recorded")).toBe("Decision recorded");
  });
});

describe("eventKey", () => {
  it("separates two events that differ only in kind", () => {
    const a = event({ kind: "note", message: "same" });
    const b = event({ kind: "decision", message: "same" });
    expect(eventKey(a)).not.toBe(eventKey(b));
  });

  it("is stable for the same event", () => {
    expect(eventKey(event())).toBe(eventKey(event()));
  });
});
