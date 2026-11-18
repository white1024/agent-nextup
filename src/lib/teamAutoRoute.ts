/**
 * Auto-send sweep (D71, 13 §3): route pending outbox envelopes along the
 * edges the user marked autoRoute. The *policy* — which edges, which
 * envelopes, whether the original stays pending — lives in core
 * (`exchange::auto_route`, D152), the same copy the hub runs the moment an
 * agent publishes. What lives here is the app's half: when to sweep, and what
 * the user hears about it.
 *
 * The app sweeps on its own triggers — a watcher signal, a workspace open, a
 * team-page read, and once per start for every workspace an automatic edge
 * leaves — so a delivery the hub could not send at publish time (downstream
 * offline, say) still goes out without anyone pressing send.
 */
import { api } from "../api";
import { normRoot } from "./exchange";
import type { Toast } from "./notify";
import type { Team } from "../types";

export type ToastSpec = Omit<Toast, "id" | "count">;

export interface SweepIo {
  pushToast: (spec: ToastSpec) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

// One gate per workspace root: concurrent triggers merge into a re-run
// instead of racing (the ledger-tail busy/pending shape, D62).
const gates = new Map<string, { busy: boolean; pending: boolean }>();

// (envelope, destination) pairs whose auto-send failure was already announced
// this app session. Every watcher signal retries the send, and re-toasting
// each retry would drown the user in the one place automation promised quiet.
// Keyed per destination, not per envelope: a newly-added auto edge that fails
// deserves its own first toast even when an older destination already failed.
const failureToasted = new Set<string>();

function failKey(envelopeId: string, destRoot: string): string {
  return `${envelopeId}:${normRoot(destRoot)}`;
}

/**
 * Route every pending envelope of `root` along its auto edges. Resolves true
 * when something was newly delivered, so callers refresh their outbox reads.
 */
export async function autoRouteSweep(root: string, io: SweepIo): Promise<boolean> {
  const key = normRoot(root);
  const gate = gates.get(key) ?? { busy: false, pending: false };
  gates.set(key, gate);
  if (gate.busy) {
    gate.pending = true;
    return false;
  }
  gate.busy = true;
  try {
    return await sweepOnce(root, io);
  } finally {
    gate.busy = false;
    if (gate.pending) {
      gate.pending = false;
      void autoRouteSweep(root, io);
    }
  }
}

/**
 * The workspaces at least one automatic edge leaves, by root — what the
 * start-up sweep visits. Edges name members by id; roots are the graph's own
 * display caches, which is also what routing writes through.
 */
export function autoSources(teams: Team[]): string[] {
  const roots = new Map<string, string>();
  for (const team of teams) {
    for (const edge of team.edges) {
      if (!edge.autoRoute) continue;
      const from = team.members.find((m) => m.workspaceId === edge.from);
      if (from) roots.set(normRoot(from.root), from.root);
    }
  }
  return [...roots.values()];
}

async function sweepOnce(root: string, io: SweepIo): Promise<boolean> {
  const results = await api.teamAutoRoute(root);
  let deliveredAny = false;
  for (const { envelopeId, outcome } of results) {
    if (outcome === null) {
      // Routing this envelope raised outright (unreadable envelope, a failed
      // write on this side). Announce it once, like an unreachable destination.
      if (!failureToasted.has(failKey(envelopeId, "!thrown"))) {
        failureToasted.add(failKey(envelopeId, "!thrown"));
        io.pushToast({
          kind: "autoRouteFailed",
          tone: "you",
          warn: true,
          source: "logo",
          message: io.t("notify.autoRouteFailed"),
          dedupeKey: `autoroute-fail:${envelopeId}`,
        });
      }
      continue;
    }
    if (outcome.delivered.length > 0) {
      deliveredAny = true;
      // A delivery is a state change: re-arm the failure memory so what
      // fails from here on announces itself again.
      for (const k of [...failureToasted]) {
        if (k.startsWith(`${envelopeId}:`)) failureToasted.delete(k);
      }
      io.pushToast({
        kind: "autoRouted",
        tone: "hub",
        source: "logo",
        message: io.t("notify.autoRouted", { to: outcome.delivered.join(", ") }),
        dedupeKey: `autoroute:${envelopeId}`,
      });
    }
    const freshFails = outcome.failed.filter((f) => !failureToasted.has(failKey(envelopeId, f.root)));
    if (freshFails.length > 0) {
      for (const f of freshFails) failureToasted.add(failKey(envelopeId, f.root));
      io.pushToast({
        kind: "autoRouteFailed",
        tone: "you",
        warn: true,
        source: "logo",
        message: io.t("notify.autoRouteFailed"),
        dedupeKey: `autoroute-fail:${envelopeId}`,
      });
    }
  }
  return deliveredAny;
}
