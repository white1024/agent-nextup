/**
 * The workspace notification layer's orchestration (D62/D63/D71), lifted out of
 * the app shell.
 *
 * Six effects and five coordinating refs used to sit inline in `App.tsx`
 * between the router and the sidebar, which made a 1,200-line component the
 * only place where "when do we announce things" could be read — and the refs
 * the easiest thing in the file to mistake for one another. They are not
 * variations on a theme; each guards something different:
 *
 *  - `tailBusyRef` / `tailPendingRef` — a **concurrency merge**. Two ledger
 *    reads would share one cursor and announce the same denial twice, so a
 *    signal arriving mid-flight is re-run afterwards rather than dropped.
 *  - `notifiedDeliveriesRef` / `startupScanRef` — genuine **one-shots**.
 *    Unread is a standing fact; announcing is not.
 *  - `inboxOnScreenRef` — a **mirror**, so an effect can read the current view
 *    at the moment it resolves without taking it as a dependency.
 *
 * The persisted ledger cursor (`notify.ts`, localStorage) is a fourth,
 * separate mechanism: it survives restarts and answers "has this machine seen
 * this line", which no ref can.
 *
 * The shell keeps only what it renders: the unread count.
 */
import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { api } from "../api";
import { readBoxes } from "../lib/exchange";
import {
  deniedCalls,
  ledgerCursor,
  markDeliveriesSeen,
  setLedgerCursor,
  unseenDeliveries,
} from "../lib/notify";
import { markConnected } from "../lib/prefs";
import { autoRouteSweep, type ToastSpec } from "../lib/teamAutoRoute";
import type { LedgerAppendedPayload, SystemStatus, WorkspaceChangedPayload } from "../types";

/** The i18n `t` this layer needs — same shape the auto-send sweep takes. */
type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Denials older than this are not announced (D62). Reopening the app can leave
 * the ledger cursor far behind, and a denial from last week is history, not a
 * request for attention — the agent that hit it is long gone.
 */
const DENIAL_FRESH_MS = 5 * 60_000;

export interface NotificationIo {
  /** Open workspace root; `null` with none open. */
  wsRoot: string | null;
  /** Bumped on every workspace change (watcher event or local mutation). */
  refreshKey: number;
  /** First system status; until it lands the open workspace is unknown. */
  status: SystemStatus | null;
  /** Capability-module test for the open workspace. */
  moduleOn: (id: string) => boolean;
  /**
   * Is the inbox the view on screen? Standing on it counts as reading it. A
   * boolean rather than the view id: this layer does not own that vocabulary,
   * and every other view is the same "not the inbox" to it.
   */
  inboxOnScreen: boolean;
  pushToast: (spec: ToastSpec) => void;
  t: Translate;
  /** Where the toasts' actions jump to. Called, never depended on. */
  openInbox: () => void;
  openProjects: () => void;
  authorizeTool: (tool: string) => void;
}

/**
 * The startup cross-project summary line: one project by name, several by
 * count. One summary rather than one toast per project — this fires at
 * startup, when a stack of popups is exactly what nobody wants. Pure given
 * `t`, so the wording rule can be checked without mounting anything. Callers
 * announce nothing at all for an empty list.
 */
export function otherDeliveriesMessage(names: string[], t: Translate): string {
  return names.length === 1
    ? t("notify.deliveryOther", { name: names[0] })
    : t("notify.deliveryOthers", { n: names.length });
}

export function useWorkspaceNotifications(io: NotificationIo): { inboxUnseen: number } {
  const { wsRoot, refreshKey, status, moduleOn, inboxOnScreen, pushToast, t } = io;
  const [inboxUnseen, setInboxUnseen] = useState(0);

  // Jump targets are ref-stabilized so the shell may pass inline arrows: they
  // are only ever *called* (from a toast action), never compared, so keeping
  // them out of the dependency arrays below is what stops a re-render from
  // re-arming every listener in this file.
  const ioRef = useRef(io);
  ioRef.current = io;

  // Denied agent calls (D62). A denial writes one ledger line and nothing
  // else, so `workspace://changed` never fires for it — this listens to the
  // ledger's own signal instead, and reads the tail from a persisted line
  // cursor so the same denial is announced exactly once.
  const tailBusyRef = useRef(false);
  const tailPendingRef = useRef(false);
  useEffect(() => {
    if (wsRoot === null) return;
    let cancelled = false;

    const readTail = async () => {
      // Two concurrent reads would share one cursor and announce the same
      // denial twice. Coalesce instead of dropping: a signal that arrives
      // mid-flight is re-run afterwards, because a denial writes nothing else
      // and may be the last event for a long while — dropping it would
      // recreate the very silence this feature exists to end.
      if (tailBusyRef.current) {
        tailPendingRef.current = true;
        return;
      }
      tailBusyRef.current = true;
      try {
        const cursor = ledgerCursor(wsRoot);
        const tail = await api.ledgerSince(cursor ?? 0, 50);
        // Adopt the position even if this effect was torn down mid-flight
        // (StrictMode's double-mount does exactly that): leaving the cursor
        // unwritten would make the next read look like a first sight and
        // silently swallow the first real denial.
        setLedgerCursor(wsRoot, tail.nextLine);
        if (cancelled) return;
        // No cursor yet (first sight of this workspace on this machine) or a
        // replaced ledger: adopt the position silently. Announcing here would
        // dump the entire history on screen.
        if (tail.events.some((e) => e.kind === "agent_tool_called")) {
          markConnected(wsRoot);
        }
        if (cursor === null || tail.reset) return;
        for (const denial of deniedCalls(tail.events)) {
          if (Date.now() - new Date(denial.at).getTime() > DENIAL_FRESH_MS) continue;
          pushToast({
            kind: "agentDenied",
            tone: "error",
            message: t("notify.agentDenied", {
              actor: denial.actor ?? t("notify.someAgent"),
              tool: denial.tool,
            }),
            // Same agent retrying the same tool folds into one toast.
            dedupeKey: `denied:${denial.actor ?? "?"}:${denial.tool}`,
            action: {
              label: t("notify.goAuthorize"),
              run: () => ioRef.current.authorizeTool(denial.tool),
            },
          });
        }
      } catch (e) {
        console.warn("ledger tail failed:", e);
      } finally {
        tailBusyRef.current = false;
        if (tailPendingRef.current && !cancelled) {
          tailPendingRef.current = false;
          void readTail();
        }
      }
    };

    // Align the cursor on open, then follow appends.
    void readTail();
    const unlisten = listen<LedgerAppendedPayload>("ledger://appended", (ev) => {
      // Guard against a switch mid-flight: the watcher follows the open
      // workspace, but the event and this effect can disagree for a tick.
      if (ev.payload.root === wsRoot) void readTail();
    });
    return () => {
      cancelled = true;
      void unlisten.then((f) => f());
    };
  }, [wsRoot, pushToast, t]);

  // Auto-send sweep (D71). Depend on the boolean, not `moduleOn`: the
  // callback's identity changes on every modules re-read (every refreshKey
  // bump), which would re-register the listener and re-run the stock check on
  // every watcher signal. The boolean only flips when the module actually
  // toggles — or when modules finish loading after boot, which is exactly
  // when the stock check below becomes allowed to run.
  const teamModuleOn = moduleOn("team");

  // Call site ①: a watcher delta may mean a new outbox envelope. The root
  // comes from the event payload — this listener's closure never sees a
  // wsRoot update.
  useEffect(() => {
    if (!teamModuleOn) return;
    const unlisten = listen<WorkspaceChangedPayload>("workspace://changed", (ev) => {
      void autoRouteSweep(ev.payload.root, { pushToast, t });
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, [teamModuleOn, pushToast, t]);

  // Call site ③: the watcher only reports increments. A workspace opened (or
  // the app started) with envelopes already waiting needs one stock check, or
  // a hub publish made while the app was closed lies around until the next
  // unrelated change.
  useEffect(() => {
    if (wsRoot === null || !teamModuleOn) return;
    void autoRouteSweep(wsRoot, { pushToast, t });
  }, [wsRoot, teamModuleOn, pushToast, t]);

  // Inbound deliveries (D62): toast for new envelopes, silent count for the
  // sidebar. Re-runs on watcher deltas because `.nextup/exchange` is
  // whitelisted, so an arrival while the app is open lands here.
  // Announced-this-run envelope ids. Not keyed by workspace and never pruned
  // on switch: envelope ids are UUIDs, so collisions across workspaces cannot
  // happen and the set is bounded by deliveries actually seen this run.
  const notifiedDeliveriesRef = useRef(new Set<string>());
  // Read through a ref, not a dependency: this effect only needs to know
  // whether the inbox is on screen *at the moment it resolves*. As a
  // dependency it would re-scan the inbox (IPC + read_dir + a JSON parse per
  // envelope) on every single page switch.
  const inboxOnScreenRef = useRef(inboxOnScreen);
  inboxOnScreenRef.current = inboxOnScreen;
  useEffect(() => {
    // The inbox is a team-module surface: with the module off there is no nav
    // entry and no badge, so a toast would point at a page that is not there.
    if (wsRoot === null || !moduleOn("team")) {
      setInboxUnseen(0);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.exchangeList(wsRoot, "inbox");
        if (cancelled) return;
        const fresh = unseenDeliveries(wsRoot, list);
        // Standing on the inbox counts as reading it: announcing what is
        // already on screen is noise, and the badge would be a lie. Marking
        // them read is the next effect's job.
        if (inboxOnScreenRef.current) {
          setInboxUnseen(0);
          return;
        }
        setInboxUnseen(fresh.length);
        for (const delivery of fresh) {
          // Unread is a standing fact (the badge), but announcing is a
          // one-shot: without this the toast would return on every refresh
          // until the inbox is opened.
          if (notifiedDeliveriesRef.current.has(delivery.id)) continue;
          notifiedDeliveriesRef.current.add(delivery.id);
          pushToast({
            kind: "deliveryArrived",
            tone: "info",
            message: t("notify.deliveryArrived", { from: delivery.from.name }),
            dedupeKey: `delivery:${delivery.id}`,
            action: { label: t("notify.openInbox"), run: () => ioRef.current.openInbox() },
          });
        }
      } catch (e) {
        console.warn("inbox scan failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wsRoot, refreshKey, moduleOn, pushToast, t]);

  // Opening the inbox is what marks deliveries read. Separate from the scan
  // above so that switching *away* costs nothing: this bails immediately on
  // every other view instead of re-listing the mailbox.
  useEffect(() => {
    if (!inboxOnScreen || wsRoot === null || !moduleOn("team")) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.exchangeList(wsRoot, "inbox");
        if (cancelled) return;
        markDeliveriesSeen(
          wsRoot,
          list.map((d) => d.id),
        );
        for (const d of list) notifiedDeliveriesRef.current.add(d.id);
        setInboxUnseen(0);
      } catch (e) {
        console.warn("inbox read-mark failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inboxOnScreen, wsRoot, refreshKey, moduleOn]);

  // Deliveries that arrived in *other* projects while this one was open (or
  // while the app was closed). Startup-only: the watcher follows the open
  // workspace alone, so this is the one moment the rest can be checked.
  const startupScanRef = useRef(false);
  useEffect(() => {
    // Wait for the first status: without it the open workspace is unknown and
    // would be counted among the "other" projects it is excluded from below.
    if (status === null) return;
    // Not a cleanup flag — a ref that survives StrictMode's remount, so the
    // scan cannot run twice and fold into a "×2" toast.
    if (startupScanRef.current) return;
    startupScanRef.current = true;
    const openRoot = status.workspace?.root ?? null;
    void (async () => {
      try {
        const workspaces = await api.recentWorkspaces();
        // A workspace that cannot be read contributes no rows, so it drops out
        // of the filter below exactly as a rejected scan used to.
        const scans = await readBoxes(workspaces, (w) => w.root, "inbox");
        const projects = scans
          // The open workspace has its own live listener above.
          .filter((s) => s.target.root !== openRoot)
          .filter((s) => unseenDeliveries(s.target.root, s.rows).length > 0)
          .map((s) => s.target);
        if (projects.length === 0) return;
        pushToast({
          kind: "deliveryArrived",
          tone: "info",
          message: otherDeliveriesMessage(
            projects.map((p) => p.name),
            t,
          ),
          dedupeKey: "delivery:other",
          action: { label: t("notify.openProjects"), run: () => ioRef.current.openProjects() },
        });
      } catch (e) {
        console.warn("cross-project inbox scan failed:", e);
      }
    })();
  }, [pushToast, t, status]);

  return { inboxUnseen };
}
