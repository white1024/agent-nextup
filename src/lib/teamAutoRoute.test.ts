import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SweepIo, ToastSpec } from "./teamAutoRoute";
import type { DeliverySummary, RouteOutcome, Team, TeamEdge } from "../types";

const mocks = vi.hoisted(() => ({
  teamsList: vi.fn(),
  exchangeList: vi.fn(),
  teamRouteDelivery: vi.fn(),
}));

// The whole IPC surface this module touches. `./exchange` (normRoot/sameRoot)
// stays real — path shapes are part of what these tests check — and it reaches
// for `errorMessage` from the same module, so the mock has to carry it too.
vi.mock("../api", () => ({
  api: {
    teamsList: mocks.teamsList,
    exchangeList: mocks.exchangeList,
    teamRouteDelivery: mocks.teamRouteDelivery,
  },
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
const autoDestination = { root: DEST, teamId: "t1", teamName: "Team" };

function envelope(over: Partial<DeliverySummary> = {}): DeliverySummary {
  return {
    id: "e1",
    from: { workspaceId: "w1", name: "mine" },
    payloadType: "note",
    attachmentCount: 0,
    publishedAt: "2026-07-30T21:04:00Z",
    ...over,
  };
}

function outcome(over: Partial<RouteOutcome> = {}): RouteOutcome {
  return { delivered: [], alreadyDelivered: [], failed: [], outboxCleared: false, ...over };
}

let sweep: typeof import("./teamAutoRoute").autoRouteSweep;
let pushToast: ReturnType<typeof vi.fn<(spec: ToastSpec) => void>>;
let io: SweepIo;

beforeEach(async () => {
  // The module keeps two pieces of state that must not survive a test: the
  // per-root concurrency gate and the already-announced failure memory.
  vi.resetModules();
  vi.clearAllMocks();
  mocks.teamsList.mockResolvedValue([team([autoEdge])]);
  mocks.exchangeList.mockResolvedValue([]);
  mocks.teamRouteDelivery.mockResolvedValue(outcome());
  pushToast = vi.fn<(spec: ToastSpec) => void>();
  io = { pushToast, t: (key: string) => key };
  sweep = (await import("./teamAutoRoute")).autoRouteSweep;
});

describe("what gets sent", () => {
  it("routes a pending envelope along the auto edge and says so", async () => {
    mocks.exchangeList.mockResolvedValue([envelope()]);
    mocks.teamRouteDelivery.mockResolvedValue(outcome({ delivered: ["dest"] }));

    expect(await sweep(ROOT, io)).toBe(true);
    expect(mocks.teamRouteDelivery).toHaveBeenCalledWith(ROOT, "e1", [autoDestination], {
      auto: true,
      keepPending: false,
    });
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "autoRouted" }));
  });

  // A superseded envelope is one its own publisher has declared wrong. On a
  // manual edge the Replaced tag lets a person not send it; an automatic edge
  // has nobody to read that tag, and a delivery cannot be recalled.
  it("never forwards an envelope its publisher has already superseded", async () => {
    mocks.exchangeList.mockResolvedValue([envelope({ supersededBy: "e2" })]);

    expect(await sweep(ROOT, io)).toBe(false);
    expect(mocks.teamRouteDelivery).not.toHaveBeenCalled();
  });

  // Auto only speaks for its own edges. While a manual edge is still waiting,
  // nobody has decided to skip it, so the envelope has to stay pending.
  it("keeps the envelope pending while a manual edge is still unsent", async () => {
    mocks.teamsList.mockResolvedValue([team([autoEdge, manualEdge])]);
    mocks.exchangeList.mockResolvedValue([envelope()]);

    await sweep(ROOT, io);
    expect(mocks.teamRouteDelivery).toHaveBeenCalledWith(ROOT, "e1", [autoDestination], {
      auto: true,
      keepPending: true,
    });
  });

  it("does not read the outbox at all when no edge is automatic", async () => {
    mocks.teamsList.mockResolvedValue([team([manualEdge])]);

    expect(await sweep(ROOT, io)).toBe(false);
    expect(mocks.exchangeList).not.toHaveBeenCalled();
  });

  it("stops early when this workspace belongs to no team", async () => {
    mocks.teamsList.mockResolvedValue([team([autoEdge], "C:/proj/somebody-else")]);

    expect(await sweep(ROOT, io)).toBe(false);
    expect(mocks.exchangeList).not.toHaveBeenCalled();
  });

  // Windows roots arrive from three sources — the registry, teams.json and the
  // native picker — and none of them agree on separator, case or trailing slash.
  it("matches this workspace however its path happens to be written", async () => {
    mocks.teamsList.mockResolvedValue([team([autoEdge], "C:\\proj\\mine\\")]);
    mocks.exchangeList.mockResolvedValue([envelope()]);
    mocks.teamRouteDelivery.mockResolvedValue(outcome({ delivered: ["dest"] }));

    expect(await sweep("C:/proj/Mine", io)).toBe(true);
  });

  it("uses rows the caller already paid for instead of reading them again", async () => {
    await sweep(ROOT, io, { teams: [team([autoEdge])], outbox: [] });

    expect(mocks.teamsList).not.toHaveBeenCalled();
    expect(mocks.exchangeList).not.toHaveBeenCalled();
  });
});

describe("what the user hears about", () => {
  // Errors cross the IPC bridge as objects, so `String(e)` is "[object Object]"
  // and would never match. A not_found means a concurrent send already moved
  // this envelope: done, not an error, and a failure toast would be a lie.
  it("treats a concurrent send as done, not as a failure", async () => {
    mocks.exchangeList.mockResolvedValue([envelope()]);
    mocks.teamRouteDelivery.mockRejectedValue({ kind: "not_found", message: "already moved" });

    expect(await sweep(ROOT, io)).toBe(false);
    expect(pushToast).not.toHaveBeenCalled();
  });

  // Every watcher signal retries the send. Re-toasting each retry would drown
  // the user in the one place automation promised quiet.
  it("announces a thrown failure once, not once per retry", async () => {
    mocks.exchangeList.mockResolvedValue([envelope()]);
    mocks.teamRouteDelivery.mockRejectedValue({ kind: "io", message: "disk gone" });

    await sweep(ROOT, io);
    await sweep(ROOT, io);
    expect(pushToast).toHaveBeenCalledTimes(1);
    expect(pushToast).toHaveBeenCalledWith(expect.objectContaining({ kind: "autoRouteFailed" }));
  });

  it("announces an unreachable destination once, not once per retry", async () => {
    mocks.exchangeList.mockResolvedValue([envelope()]);
    mocks.teamRouteDelivery.mockResolvedValue(
      outcome({ failed: [{ root: DEST, message: "unreachable" }] }),
    );

    await sweep(ROOT, io);
    await sweep(ROOT, io);
    expect(pushToast).toHaveBeenCalledTimes(1);
  });

  // A delivery is a state change: whatever fails from there on is news again.
  it("re-arms the failure memory once something does get through", async () => {
    mocks.exchangeList.mockResolvedValue([envelope()]);
    const failed = outcome({ failed: [{ root: DEST, message: "unreachable" }] });

    mocks.teamRouteDelivery.mockResolvedValueOnce(failed);
    await sweep(ROOT, io);
    mocks.teamRouteDelivery.mockResolvedValueOnce(outcome({ delivered: ["dest"] }));
    await sweep(ROOT, io);
    mocks.teamRouteDelivery.mockResolvedValueOnce(failed);
    await sweep(ROOT, io);

    const failures = pushToast.mock.calls.filter(([spec]) => spec.kind === "autoRouteFailed");
    expect(failures).toHaveLength(2);
  });
});

describe("the per-root gate", () => {
  it("merges a concurrent trigger into one re-run instead of racing it", async () => {
    let release!: (rows: DeliverySummary[]) => void;
    mocks.exchangeList.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    const first = sweep(ROOT, io);
    const merged = sweep(ROOT, io);

    expect(await merged).toBe(false);
    expect(mocks.exchangeList).toHaveBeenCalledTimes(1);

    release([]);
    await first;
    // The merged trigger becomes one re-run after the fact, and it re-reads
    // reality rather than reusing rows that are stale by now.
    await vi.waitFor(() => expect(mocks.exchangeList).toHaveBeenCalledTimes(2));
  });
});
