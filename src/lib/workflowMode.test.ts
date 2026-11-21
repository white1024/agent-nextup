import { describe, expect, it } from "vitest";

import type { TemplateSummary, WorkflowState } from "../types";
import { modeSwitchKey, modeToSend, runsStaged } from "./workflowMode";

function template(supportsOngoing: boolean): TemplateSummary {
  return {
    id: "t",
    name: "T",
    description: "",
    domainHint: "",
    phaseCount: 1,
    phases: [],
    source: "custom",
    supportsOngoing,
  };
}

describe("runsStaged (D171 ②)", () => {
  it("is ongoing unless asked, when the template can run that way", () => {
    expect(runsStaged(false, template(true))).toBe(false);
    expect(runsStaged(true, template(true))).toBe(true);
  });

  it("is staged when the template has no ongoing instructions, whatever the box says", () => {
    expect(runsStaged(false, template(false))).toBe(true);
  });

  it("does not force staged before the template is known", () => {
    expect(runsStaged(false, null)).toBe(false);
  });
});

describe("modeToSend (review W4 of D171)", () => {
  it("sends nothing until the template is known", () => {
    expect(modeToSend(false, null)).toBeUndefined();
    expect(modeToSend(true, null)).toBeUndefined();
  });

  it("sends the resolved mode once it is", () => {
    expect(modeToSend(false, template(true))).toBe("ongoing");
    expect(modeToSend(false, template(false))).toBe("staged");
    expect(modeToSend(true, template(true))).toBe("staged");
  });
});

function state(vias: string[], completed = false): WorkflowState {
  return {
    currentPhase: "spec",
    completed,
    history: vias.map((via) => ({ phase: "spec", enteredAt: "2026-11-21T00:00:00Z", via })),
    confirmations: [],
  };
}

describe("modeSwitchKey (D171 ③)", () => {
  it("returns to the phase a project left when it was staged before", () => {
    expect(modeSwitchKey(true, state(["start", "advance", "ongoing", "staged"]))).toBe("workflowToStaged");
  });

  it("starts at the first phase for a project that has only ever run ongoing", () => {
    expect(modeSwitchKey(true, state(["start", "staged"]))).toBe("workflowToStagedFirst");
  });

  it("says where it stopped when switching to ongoing", () => {
    expect(modeSwitchKey(false, state(["start", "ongoing"]))).toBe("workflowToOngoing");
  });

  it("keeps a finished workflow finished either way", () => {
    expect(modeSwitchKey(true, state(["start", "ongoing", "staged"], true))).toBe("workflowToStagedDone");
    expect(modeSwitchKey(false, state(["start", "ongoing"], true))).toBe("workflowToOngoingDone");
  });
});
