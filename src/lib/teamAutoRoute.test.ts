import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SweepIo, ToastSpec } from "./teamAutoRoute";
import type { AutoRouted, RouteOutcome, Team, TeamEdge } from "../types";

// Which envelopes travel along which edges is core's call since D152
// (`exchange::auto_route`, tested in Rust next to the hub that runs it at
// publish time). What is left here is the app's half: when it sweeps, which
// workspaces a start-up sweep visits, and what the user hears.

const mocks = vi.hoisted(() => ({
  teamAutoRoute: vi.fn(),
}));

// The whole IPC surface this module touches. `./exchange` (normRoot) stays
// real, and it reaches for `errorMessage` from the same module, so the mock
// has to carry it too.
vi.mock("../api", () => ({
  api: { teamAutoRoute: mocks.teamAutoRoute },
  errorMessage: (e: unknown) => String(e),
}));

const ROOT = "C:/proj/mine";
const DEST = "C:/proj/dest";

function team(edges: TeamEdge[], mineRoot = ROOT): Team {
  return {
    id: "t1",
    name: "Team",
    members: [
      { workspaceId: "w1", root: mineRoot, name: "mine" },
      { workspaceId: "w2", root: DEST, name: "dest" },
      { workspaceId: "w3", root: "C:/proj/manual", name: "manual" },
    ],
    edges,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: "2026-07-30T00:00:00Z",
  };
}

const autoEdge: TeamEdge = { from: "w1", to: "w2", autoRoute: true };
const manualEdge: TeamEdge = { from: "w1", to: "w3", autoRoute: false };

function outcome(over: Partial<RouteOutcome> = {}): RouteOutcome {
  return { delivered: [], alreadyDelivered: [], failed: [], outboxCleared: false, ...over };
}

function routed(over: Partial<RouteOutcome> | null, envelopeId = "e1"): AutoRouted[] {
  return over === null
    ? [{ envelopeId, outcome: null, error: "disk gone" }]
    : [{ envelopeId, outcome: outcome(over), error: null }];
}

let mod: typeof import("./teamAutoRoute");
let pushToast: ReturnType<typeof vi.fn<(spec: ToastSpec) => void>>;
let io: SweepIo;

beforeEach(async () => {
  // The module keeps two pieces of state that must not survive a test: the
  // per-root concurrency gate and the already-announced failure memory.
  vi.resetModules();
  vi.clearAllMocks();
  mocks.teamAutoRoute.mockResolvedValue([]);
  pushToast = vi.fn<(spec: ToastSpec) => void>();
  io = { pushToast, t: (key: string) => key };
  mod = await import("./teamAutoRoute");
});

describe("which workspaces a start-up sweep visits", () => {
  it("every workspace an automatic edge leaves, and only those", () => {
    expect(mod.autoSources([team([autoEdge, manualEdge])])).toEqual([ROOT]);
    expect(mod.autoSources([team([manualEdge])])).toEqual([]);
  });

  // Windows roots arrive from three sources — the registry, teams.json and the
  // native picker — and none of them agree on separator, case or trailing slash.
  it("visits a workspace once however many teams send from it", () => {
    const other = { ...team([autoEdge], "C:\\proj\\Mine\\"), id: "t2" };
    expect(mod.autoSources([team([autoEdge]), other])).toHaveLength(1);
  });
});

describe("what the user hears about", () => {
  it("says what went out", async () => {
    mocks.teamAutoRoute.mockResolvedValue(routed({ delivered: ["dest"] }));

    expect(await mod.autoRouteSweep(ROOT, io)).toBe(true);
    expect(mocks.teamAutoRoute).toHaveBeenCalledWith(ROOT);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "autoRouted" }));
  });

  it("stays quiet when there was nothing to send", async () => {
    expect(await mod.autoRouteSweep(ROOT, io)).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
  });

  // Every watcher signal retries the send. Re-toasting each retry would drown
  // the user in the one place automation promised quiet.
  it("announces a thrown failure once, not once per retry", async () => {
    mocks.teamAutoRoute.mockResolvedValue(routed(null));

    await mod.autoRouteSweep(ROOT, io);
    await mod.autoRouteSweep(ROOT, io);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "autoRouteFailed" }));
  });

  it("announces an unreachable destination once, not once per retry", async () => {
    mocks.teamAutoRoute.mockResolvedValue(routed({ failed: [{ root: DEST, message: "unreachable" }] }));

    await mod.autoRouteSweep(ROOT, io);
    await mod.autoRouteSweep(ROOT, io);
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  // A delivery is a state change: whatever fails from there on is news again.
  it("re-arms the failure memory once something does get through", async () => {
    const failed = routed({ failed: [{ root: DEST, message: "unreachable" }] });

    mocks.teamAutoRoute.mockResolvedValueOnce(failed);
    await mod.autoRouteSweep(ROOT, io);
    mocks.teamAutoRoute.mockResolvedValueOnce(routed({ delivered: ["dest"] }));
    await mod.autoRouteSweep(ROOT, io);
    mocks.teamAutoRoute.mockResolvedValueOnce(failed);
    await mod.autoRouteSweep(ROOT, io);

    const failures = pushToast.mock.calls.filter(([spec]) => spec.kind === "autoRouteFailed");
    expect(failures).toHaveLength(2);
  });
});

describe("the per-root gate", () => {
  it("merges a concurrent trigger into one re-run instead of racing it", async () => {
    let release!: (rows: AutoRouted[]) => void;
    mocks.teamAutoRoute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = mod.autoRouteSweep(ROOT, io);
    const merged = mod.autoRouteSweep(ROOT, io);

    expect(await merged).toBe(false);
    expect(mocks.teamAutoRoute).toHaveBeenCalledTimes(1);

    release([]);
    await first;
    // The merged trigger becomes one re-run after the fact.
    await vi.waitFor(() => expect(mocks.teamAutoRoute).toHaveBeenCalledTimes(2));
  });
});
