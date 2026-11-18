import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { Toast } from "../lib/notify";
import { IconWarn, IconX } from "../components/icons";
import Scramble from "../components/Scramble";
import { awaitLight, centreOf, fx, motionOff, tokenRgb, type Point } from "../lib/fx";

/** The exit (C31's sink); the row is unmounted once it has played. */
const EXIT_MS = 240;
/** How long the beam from the source travels before the toast rises (C214). */
const BEAM_MS = 480;

/** How long a refusal's toast waits for the overview's core to split (C30). */
const CORE_WAIT_MS = 1600;

/**
 * A light from `from` to the toast's mark, then the toast rises as it lands
 * (C214). From the overview's core (C30) the light is the core's second
 * branch: a little thinner, bending the other way, 520ms.
 */
function rise(el: HTMLElement, from: Point | null, fromCore: boolean) {
  const mark = centreOf(el.querySelector(".toast-mk"));
  const dur = fromCore ? 520 : BEAM_MS;
  let delay = 0;
  if (from !== null && mark !== null) {
    fx.beam(from, mark, { width: fromCore ? 2 : 2.4, bend: fromCore ? -0.16 : 0, dur, rgb: tokenRgb("--orange") });
    delay = dur - 10;
  }
  el.animate([{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }], {
    duration: 460,
    delay,
    easing: "cubic-bezier(.2,1.25,.4,1)",
    fill: "backwards",
  });
}

/** Where a toast's event happened, on screen right now (C214). */
function sourceOf(toast: Toast): Element | null {
  switch (toast.source) {
    case "inbox":
      return (
        document.querySelector('.sidebar [data-view="inbox"] .badge') ??
        document.querySelector('.sidebar [data-view="inbox"]')
      );
    case "projects":
      return (
        document.querySelector(".sidebar .side-back") ??
        document.querySelector('.sidebar [data-view="projects"]')
      );
    case "logo":
      return document.querySelector(".sidebar .brand-mark");
    default:
      return null;
  }
}

/**
 * The app's transient notification surface (D62).
 *
 * The container is always mounted, empty or not, because `aria-live` only
 * announces changes *inside* a region that was already there — a region that
 * appears together with its first message is silent for screen readers, which
 * is precisely the case that matters here.
 *
 * `polite` rather than `assertive`: these arrive while the user is reading or
 * typing, and even the urgent one (an agent waiting on permission) is not
 * worth cutting off mid-sentence.
 *
 * Motion (D153): a beam carries the event from where it happened (the inbox
 * badge, the way out to all projects, the logo) to the toast's mark, and the
 * toast rises as it lands (C214, C31). Its edge burns down over its life
 * (C215) and refills when the same thing happens again. Leaving, it sinks and
 * the rest slide into place. Only real arrivals and departures animate — the
 * queue changing for any other reason moves nothing.
 */
export default function ToastStack({
  toasts,
  ttlMs,
  onDismiss,
}: {
  toasts: Toast[];
  /** The queue's TTL, so the burning edge empties exactly when the toast goes. */
  ttlMs: number;
  onDismiss: (id: number) => void;
}) {
  const { t } = useTranslation();

  // Exit animation (D65). The queue in `useToasts` drops a toast the moment
  // its TTL fires, so the row has to outlive its own removal to animate out —
  // that extra life is kept here rather than in the hook, whose TTL/dedupe
  // logic (D62) has no business knowing about a transition.
  //
  // The removal timers are deliberately NOT cancelled by an effect cleanup.
  // This effect depends on `toasts` and advances `prevRef` as a side effect,
  // so it is not re-entrant: any later change to the queue re-runs it, and a
  // cleanup would cancel the in-flight exit timers of toasts that `prevRef`
  // has already moved past — they would never be re-armed and would sit on
  // screen forever. Production, not just StrictMode: pushing a second toast
  // while the first is animating out is enough.
  const [leaving, setLeaving] = useState<Toast[]>([]);
  const prevRef = useRef<Toast[]>([]);
  const timersRef = useRef(new Map<number, number>());
  const stackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const gone = prevRef.current.filter((p) => !toasts.some((cur) => cur.id === p.id));
    prevRef.current = toasts;
    for (const toast of gone) {
      if (timersRef.current.has(toast.id)) continue;
      setLeaving((cur) => (cur.some((l) => l.id === toast.id) ? cur : [...cur, toast]));
      timersRef.current.set(
        toast.id,
        window.setTimeout(
          () => {
            timersRef.current.delete(toast.id);
            setLeaving((cur) => cur.filter((l) => l.id !== toast.id));
          },
          motionOff() ? 0 : EXIT_MS,
        ),
      );
    }
  }, [toasts]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Ids are monotonic, so sorting by id restores the original order and a
  // toast dismissed from the middle animates out in place instead of
  // jumping to the bottom of the stack first.
  const rendered = [
    ...toasts.map((toast) => ({ toast, leaving: false })),
    ...leaving.map((toast) => ({ toast, leaving: true })),
  ].sort((a, b) => a.toast.id - b.toast.id);

  // C31 / C214, measured around each commit: new rows rise (after a beam, if
  // their event has a place on screen), leaving rows sink, and the rows that
  // stay slide from where they were.
  const tops = useRef(new Map<number, number>());
  const seen = useRef(new Set<number>());
  const leavingKey = leaving.map((l) => l.id).join(",");
  const liveKey = toasts.map((x) => x.id).join(",");
  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (stack === null) return;
    const now = new Map<number, number>();
    const rows = [...stack.querySelectorAll<HTMLElement>("[data-toast]")];
    for (const el of rows) now.set(Number(el.dataset.toast), el.offsetTop);
    const before = tops.current;
    tops.current = now;
    if (motionOff()) {
      for (const el of rows) seen.current.add(Number(el.dataset.toast));
      return;
    }
    for (const el of rows) {
      const id = Number(el.dataset.toast);
      const isLeaving = el.classList.contains("toast--leaving");
      if (isLeaving) {
        if (el.dataset.sinking === undefined) {
          el.dataset.sinking = "1";
          el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px)" }], {
            duration: EXIT_MS,
            easing: "ease-in",
            fill: "forwards",
          });
        }
        continue;
      }
      if (!seen.current.has(id)) {
        seen.current.add(id);
        const toast = toasts.find((x) => x.id === id);
        // C30 (F15): a refusal seen on the projects overview — the light comes
        // from the overview's core as it splits, so the toast waits for it
        // (hidden) rather than rising from the logo on its own clock.
        if (toast?.kind === "agentDenied" && document.querySelector(".view--projects .orb") !== null) {
          el.style.opacity = "0";
          void awaitLight("toast-you", CORE_WAIT_MS).then((core) => {
            el.style.opacity = "";
            rise(el, core ?? centreOf(sourceOf(toast)), core !== null);
          });
          continue;
        }
        const from = toast === undefined ? null : centreOf(sourceOf(toast));
        const mark = centreOf(el.querySelector(".toast-mk"));
        let delay = 0;
        if (from !== null && mark !== null && toast !== undefined) {
          fx.beam(from, mark, {
            width: 2.4,
            dur: BEAM_MS,
            rgb: tokenRgb(toast.tone === "hub" ? "--agent" : "--orange"),
          });
          delay = BEAM_MS - 10;
        }
        el.animate([{ opacity: 0, transform: "translateY(18px)" }, { opacity: 1, transform: "none" }], {
          duration: 460,
          delay,
          easing: "cubic-bezier(.2,1.25,.4,1)",
          fill: "backwards",
        });
        continue;
      }
      const was = before.get(id);
      const is = now.get(id);
      if (was !== undefined && is !== undefined && was !== is) {
        el.animate([{ transform: `translateY(${was - is}px)` }, { transform: "none" }], {
          duration: 320,
          easing: "cubic-bezier(.16,1,.3,1)",
        });
      }
    }
  }, [liveKey, leavingKey, toasts]);

  return (
    <div className="toast-stack" role="status" aria-live="polite" ref={stackRef}>
      {rendered.map(({ toast, leaving: isLeaving }) => (
        <div
          key={toast.id}
          data-toast={toast.id}
          className={`toast toast--${toast.tone}${isLeaving ? " toast--leaving" : ""}`}
          aria-hidden={isLeaving}
          style={{ "--toast-ttl": `${ttlMs}ms` } as CSSProperties}
        >
          {/* Mark beside the words (9(a)): amber circle = waiting on you,
              violet dot = the hub acted, warning glyph = something failed. */}
          <span className="toast-mk" aria-hidden="true">
            {toast.warn === true ? (
              <IconWarn size={14} />
            ) : toast.tone === "hub" ? (
              <span className="dot-run" />
            ) : (
              <span className="mk-y" />
            )}
          </span>
          <div className="toast-body">
            <span className="toast-message">{toast.message}</span>
            {toast.count > 1 && (
              // Folded repeats: the count is the whole point of folding, so it
              // has to be visible rather than just restarting the timer.
              <span className="toast-count" title={t("notify.repeated", { n: toast.count })}>
                ×<Scramble value={toast.count} />
              </span>
            )}
          </div>
          <div className="toast-actions">
            {toast.action !== undefined && (
              <button
                className="btn btn-ghost btn-small"
                onClick={(e) => {
                  toast.action?.run(e.currentTarget.closest<HTMLElement>(".toast"));
                  onDismiss(toast.id);
                }}
              >
                {toast.action.label}
              </button>
            )}
            <button
              className="btn btn-ghost btn-icon"
              title={t("common.close")}
              aria-label={t("common.close")}
              onClick={() => onDismiss(toast.id)}
            >
              <IconX size={12} />
            </button>
          </div>
          {/* C215. Keyed by the repeat count: a repeat restarts the burn and
              plays the refill, exactly when the queue restarts its clock. */}
          <svg className="toast-ring" aria-hidden="true" key={toast.count}>
            <rect x="0" y="0" width="100%" height="100%" rx="18" pathLength={100} />
          </svg>
        </div>
      ))}
    </div>
  );
}
