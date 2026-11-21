import { describe, expect, it } from "vitest";

// The threshold lives in two languages; the doctor's is the one that warns, so
// the band must turn amber on the same day (`?raw` holds the rule's real home).
import doctorSource from "../../../crates/nextup-core/src/workspace/doctor.rs?raw";
import { daysInPhase, READY_IDLE_DAYS } from "./phaseAge";

const at = (iso: string) => Date.parse(iso);

describe("daysInPhase (D169)", () => {
  const history = [
    { phase: "scope", enteredAt: "2026-10-14T03:00:00Z", via: "start" },
    { phase: "gather", enteredAt: "2026-10-20T03:00:00Z", via: "advance" },
    { phase: "scope", enteredAt: "2026-10-25T03:00:00Z", via: "override", reason: "redo" },
  ];

  it("counts whole days from the last time the phase was entered", () => {
    expect(daysInPhase(history, "scope", at("2026-11-09T02:00:00Z"))).toBe(14);
    expect(daysInPhase(history, "gather", at("2026-10-20T12:00:00Z"))).toBe(0);
  });

  it("says nothing when the history does not name the phase or the date is garbage", () => {
    expect(daysInPhase(history, "draft")).toBeNull();
    expect(daysInPhase([{ phase: "x", enteredAt: "not a date", via: "start" }], "x")).toBeNull();
  });

  it("never goes negative on a clock that runs behind the file", () => {
    expect(daysInPhase(history, "scope", at("2026-10-01T00:00:00Z"))).toBe(0);
  });
});

describe("READY_IDLE_DAYS", () => {
  it("is the doctor's PHASE_READY_IDLE_DAYS", () => {
    const m = /PHASE_READY_IDLE_DAYS: i64 = (\d+);/.exec(doctorSource);
    expect(m?.[1]).toBe(String(READY_IDLE_DAYS));
  });
});
