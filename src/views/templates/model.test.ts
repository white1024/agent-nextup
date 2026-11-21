import { describe, expect, it } from "vitest";

import { dashParts, failedPhaseId, instructionLines, ongoingOrNone } from "./model";

// No CJK in source outside i18n.ts (D81's publish scan): the helpers are
// character-agnostic, so Latin stand-ins carry the cases; the one CJK-specific
// rule (the full-width comma stops the run) uses its escape.
const COMMA = "\uff0c";
const DASH = "\u2014\u2014";

describe("failedPhaseId", () => {
  it("reads the phase out of a gate refusal", () => {
    expect(failedPhaseId("phase 'phase-1': manual_confirm needs a prompt")).toBe("phase-1");
  });

  it("reads a missing title and a duplicate id", () => {
    expect(failedPhaseId("phase 'verify' needs a title")).toBe("verify");
    expect(failedPhaseId("duplicate phase id 'spec'")).toBe("spec");
  });

  it("survives a translated wrapper around the original", () => {
    expect(failedPhaseId("Invalid input: phase 'design': artifact path must be relative")).toBe("design");
  });

  it("is null for refusals about the template as a whole", () => {
    expect(failedPhaseId("template id cannot be empty")).toBeNull();
    expect(failedPhaseId("'coding-v1' is a built-in template id")).toBeNull();
  });
});

describe("instructionLines", () => {
  it("trims each line and drops the blank ones", () => {
    expect(instructionLines(["  Work the tasks ", "", "   ", "Ship it"])).toEqual(["Work the tasks", "Ship it"]);
  });
});

describe("ongoingOrNone", () => {
  it("keeps the lines when there are any", () => {
    expect(ongoingOrNone(["Work the tasks"])).toEqual(["Work the tasks"]);
  });

  it("is absent when there are none, so the template runs staged only", () => {
    expect(ongoingOrNone([])).toBeUndefined();
    expect(ongoingOrNone(instructionLines(["", "  "]))).toBeUndefined();
  });
});

describe("dashParts", () => {
  it("keeps up to six characters with the dash", () => {
    expect(dashParts(`abcdef${DASH}rest`)).toEqual(["", `abcdef${DASH}`, "rest"]);
    expect(dashParts(`abcdefgh${DASH}rest`)).toEqual(["ab", `cdefgh${DASH}`, "rest"]);
  });

  it("stops at a space and at the full-width comma", () => {
    expect(dashParts(`one two${DASH}x`)).toEqual(["one ", `two${DASH}`, "x"]);
    expect(dashParts(`a${COMMA}bcd${DASH}x`)).toEqual([`a${COMMA}`, `bcd${DASH}`, "x"]);
  });

  it("leaves a sentence without the dash whole", () => {
    expect(dashParts("Built-ins are read-only - copy one.")).toEqual(["Built-ins are read-only - copy one.", "", ""]);
  });
});
