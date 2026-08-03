/**
 * Auto-send sweep (D71, 13 §3): route pending outbox envelopes along the
 * edges the user marked autoRoute. App-layer automation — the moving is done
 * by this GUI process, never by an agent (09 §1), and only when the app
 * happens to look: a watcher signal, a workspace open, or a team-page read.
 */
import { api } from "../api";
import { normRoot, sameRoot } from "./exchange";
import type { Toast } from "./notify";
import type { DeliverySummary, Team } from "../types";

export type ToastSpec = Omit<Toast, "id" | "count">;

export interface SweepIo {
  pushToast: (spec: ToastSpec) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

/** Reads a call site already paid for (the team page's outbox fan-out). */
export interface SweepPre {
  teams?: Team[];
  outbox?: DeliverySummary[];
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
export async function autoRouteSweep(root: string, io: SweepIo, pre?: SweepPre): Promise<boolean> {
  const key = normRoot(root);
  const gate = gates.get(key) ?? { busy: false, pending: false };
  gates.set(key, gate);
  if (gate.busy) {
    gate.pending = true;
    return false;
  }
  gate.busy = true;
  try {
    return await sweepOnce(root, io, pre);
  } finally {
    gate.busy = false;
    if (gate.pending) {
      gate.pending = false;
      // The merged re-run re-reads reality — preloaded rows are stale by now.
      void autoRouteSweep(root, io);
    }
  }
}

async function sweepOnce(root: string, io: SweepIo, pre?: SweepPre): Promise<boolean> {
  const teams = pre?.teams ?? (await api.teamsList());

  // This workspace's stable ids. Member roots are display caches, but for the
  // workspace a sweep was triggered on they are current (rebind refreshes).
  const mine = new Set<string>();
  for (const team of teams) {
    for (const member of team.members) {
      if (sameRoot(member.root, root)) mine.add(member.workspaceId);
    }
  }
  if (mine.size === 0) return false;

  // Outgoing edges across every team, split by policy. Auto only speaks for
  // its own edges: while manual edges remain, the envelope must stay pending
  // — nobody decided to skip them (keep_pending, 13 §3).
  const autoDests: { root: string; teamId: string; teamName: string }[] = [];
  let manualEdges = 0;
  for (const team of teams) {
    for (const edge of team.edges) {
      if (!mine.has(edge.from)) continue;
      if (!edge.autoRoute) {
        manualEdges += 1;
        continue;
      }
      const target = team.members.find((m) => m.workspaceId === edge.to);
      if (target) autoDests.push({ root: target.root, teamId: team.id, teamName: team.name });
    }
  }
  if (autoDests.length === 0) return false;

  const outbox = pre?.outbox ?? (await api.exchangeList(root, "outbox"));
  let deliveredAny = false;
  for (const envelope of outbox) {
    // A superseded envelope is one its own publisher has declared wrong. On a
    // manual edge the Replaced tag lets the user not send it; an automatic
    // edge has nobody to read the tag, so it would forward the mistake into
    // another project — and a delivery cannot be recalled. Skipping leaves it
    // pending forever, which is the right outcome: the correction is what
    // should travel, and it will, on the next sweep.
    if (envelope.supersededBy) continue;
    try {
      const outcome = await api.teamRouteDelivery(root, envelope.id, autoDests, {
        auto: true,
        keepPending: manualEdges > 0,
      });
      if (outcome.delivered.length > 0) {
        deliveredAny = true;
        // A delivery is a state change: re-arm the failure memory so what
        // fails from here on announces itself again.
        for (const k of [...failureToasted]) {
          if (k.startsWith(`${envelope.id}:`)) failureToasted.delete(k);
        }
        io.pushToast({
          kind: "autoRouted",
          tone: "info",
          message: io.t("notify.autoRouted", { to: outcome.delivered.join(", ") }),
          dedupeKey: `autoroute:${envelope.id}`,
        });
      }
      const freshFails = outcome.failed.filter((f) => !failureToasted.has(failKey(envelope.id, f.root)));
      if (freshFails.length > 0) {
        for (const f of freshFails) failureToasted.add(failKey(envelope.id, f.root));
        io.pushToast({
          kind: "autoRouteFailed",
          tone: "error",
          message: io.t("notify.autoRouteFailed"),
          dedupeKey: `autoroute-fail:${envelope.id}`,
        });
      }
    } catch (e) {
      // Errors cross the IPC bridge as { kind, message } objects (api.ts) —
      // never match on String(e), that is "[object Object]". A not_found here
      // means a concurrent send already moved this envelope: done, not an
      // error, and the failure toast would be a lie.
      if ((e as { kind?: unknown } | null)?.kind === "not_found") continue;
      if (!failureToasted.has(failKey(envelope.id, "!thrown"))) {
        failureToasted.add(failKey(envelope.id, "!thrown"));
        io.pushToast({
          kind: "autoRouteFailed",
          tone: "error",
          message: io.t("notify.autoRouteFailed"),
          dedupeKey: `autoroute-fail:${envelope.id}`,
        });
      }
    }
  }
  return deliveredAny;
}
