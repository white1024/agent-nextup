import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { Toast } from "../lib/notify";
import { IconX } from "../components/icons";

/** Must match `--dur-micro`; the row is unmounted once the exit has played. */
const EXIT_MS = 150;

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
 */
export default function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
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

  useEffect(() => {
    const gone = prevRef.current.filter((p) => !toasts.some((cur) => cur.id === p.id));
    prevRef.current = toasts;
    for (const toast of gone) {
      if (timersRef.current.has(toast.id)) continue;
      setLeaving((cur) => (cur.some((l) => l.id === toast.id) ? cur : [...cur, toast]));
      timersRef.current.set(
        toast.id,
        window.setTimeout(() => {
          timersRef.current.delete(toast.id);
          setLeaving((cur) => cur.filter((l) => l.id !== toast.id));
        }, EXIT_MS),
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

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {rendered.map(({ toast, leaving: isLeaving }) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.tone}${isLeaving ? " toast--leaving" : ""}`}
          aria-hidden={isLeaving}
        >
          <div className="toast-body">
            <span className="toast-message">{toast.message}</span>
            {toast.count > 1 && (
              // Folded repeats: the count is the whole point of folding, so it
              // has to be visible rather than just restarting the timer.
              <span className="toast-count" title={t("notify.repeated", { n: toast.count })}>
                ×{toast.count}
              </span>
            )}
          </div>
          <div className="toast-actions">
            {toast.action !== undefined && (
              <button
                className="btn btn-ghost btn-small"
                onClick={() => {
                  toast.action?.run();
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
        </div>
      ))}
    </div>
  );
}
