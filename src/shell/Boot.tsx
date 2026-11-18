import { useLayoutEffect, useRef, type CSSProperties, type RefObject } from "react";

import { AppMark, IconWarn } from "../components/icons";
import { BOOT_EXIT_MS } from "../lib/boot";

/**
 * The boot screen, as App renders it once the bundle is in (D153 C1 / C2,
 * D154 ④).
 *
 * It is the same markup index.html paints before React exists, under the same
 * classes — those styles sit in index.html's `<head>` and outlive `#root`, so
 * nothing here restyles it, and a second copy of them would be a second source
 * for one screen. Keep the two trees identical; `boot.test.ts` holds the mark's
 * drawing and the timeline numbers to each other.
 */

/** The product name, one span per character for C1's letter-by-letter
 *  arrival (`--k` is the character's index; the space keeps its slot). */
function BootName() {
  return (
    <div className="boot-name" aria-hidden="true">
      {[..."Agent NextUp"].map((ch, k) =>
        ch === " " ? (
          " "
        ) : (
          <span key={k} className="ch" style={{ "--k": k } as CSSProperties}>
            {ch}
          </span>
        ),
      )}
    </div>
  );
}

function BootMark({ iconRef }: { iconRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div className="boot-mark">
      <i className="boot-flash" />
      <div className="boot-cube-wrap">
        <div className="boot-cube">
          <i />
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
      <div className="boot-icon" ref={iconRef}>
        <AppMark size={168} />
      </div>
    </div>
  );
}

/**
 * While the app waits for its first `system_status`. `delays` places the C1
 * sequence on the timeline index.html's copy started (lib/boot.ts
 * `bootSplashDelays`), so the cube does not turn in twice.
 *
 * `slow` (C226) appends a way out and sets the mark beating — it does not say
 * anything failed, because nothing is known to have. `error` puts the failure
 * in that same place and stops the beat.
 */
export function BootScreen({
  delays,
  label,
  slow,
  slowText,
  error,
  retryLabel,
  onRetry,
}: {
  delays: { hold?: string; t0?: string };
  label: string;
  slow: boolean;
  slowText: string;
  error: string | null;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div
      className={`boot${slow && error === null ? " is-slow" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={label}
      style={{ animationDelay: delays.hold, "--boot-t0": delays.t0 } as CSSProperties}
    >
      <div className="boot-c">
        <BootMark />
        <BootName />
        <div className="boot-sub" aria-hidden="true">
          nextup hub
        </div>
        {(slow || error !== null) && (
          <div className="boot-tail">
            {error !== null ? (
              <div className="boot-err" role="alert">
                <IconWarn size={14} />
                <span>{error}</span>
              </div>
            ) : (
              <span className="boot-slow-text">{slowText}</span>
            )}
            <button className="btn" onClick={onRetry}>
              {retryLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * C2: the splash leaving, over the shell that has just rendered under it. The
 * icon flies into the sidebar's logo slot, the words lift away, the dark
 * ground fades out, and the sidebar slides in from the left. The sidebar's own
 * logo stays hidden until the flying one lands on it, so there is never two.
 *
 * App mounts this only when the splash was actually on screen and motion is
 * allowed; `onDone` unmounts it.
 */
export function BootExit({
  target,
  onDone,
}: {
  target: RefObject<HTMLElement | null>;
  onDone: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const icon = iconRef.current;
    const slot = target.current;
    // Set by the cleanup. Cancelling the flight below rejects its `finished`,
    // and that must not count as landing.
    let torn = false;
    let finished = false;
    const finish = () => {
      if (finished || torn) return;
      finished = true;
      if (slot) slot.style.visibility = "";
      doneRef.current();
    };
    if (root === null || icon === null) {
      finish();
      return;
    }

    // Everything this effect starts, so the cleanup can take it all back.
    // It has to: the slot is measured while the sidebar is still, and the
    // sidebar's slide-in below moves it. An effect run again over animations
    // it left playing (StrictMode does exactly that in dev) measured the slot
    // 30px short of home, and the mark landed there before jumping across.
    const started: Animation[] = [];
    const flyEase = "cubic-bezier(.65,0,.15,1)";
    if (slot !== null) {
      const from = icon.getBoundingClientRect();
      const to = slot.getBoundingClientRect();
      slot.style.visibility = "hidden";
      icon.style.transformOrigin = "0 0";
      const fly = icon.animate(
        [
          { transform: "none" },
          {
            transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width})`,
          },
        ],
        { duration: 820, easing: flyEase, fill: "forwards" },
      );
      started.push(fly);
      fly.finished.then(finish, finish);
    }
    for (const el of root.querySelectorAll<HTMLElement>(".boot-name, .boot-sub")) {
      started.push(
        el.animate([{ opacity: 1 }, { opacity: 0, transform: "translateY(-10px)" }], {
          duration: 320,
          fill: "forwards",
        }),
      );
    }
    started.push(
      root.animate([{ backgroundColor: getComputedStyle(root).backgroundColor }, { backgroundColor: "transparent" }], {
        duration: 700,
        easing: "ease-in",
        fill: "forwards",
      }),
    );
    const sidebarIn = document.querySelector<HTMLElement>(".sidebar")?.animate(
      [
        { transform: "translateX(-30px)", opacity: 0 },
        { transform: "none", opacity: 1 },
      ],
      { duration: 700, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    if (sidebarIn) started.push(sidebarIn);
    // Safety net: never leave an overlay over a live app.
    const timers = [window.setTimeout(finish, BOOT_EXIT_MS + 400)];
    if (slot === null) timers.push(window.setTimeout(finish, BOOT_EXIT_MS));
    return () => {
      torn = true;
      timers.forEach((t) => window.clearTimeout(t));
      started.forEach((a) => a.cancel());
      if (slot) slot.style.visibility = "";
    };
  }, [target]);

  return (
    <div className="boot boot--exit" ref={rootRef} aria-hidden="true">
      <div className="boot-c">
        <BootMark iconRef={iconRef} />
        <BootName />
        <div className="boot-sub">nextup hub</div>
      </div>
    </div>
  );
}

/**
 * C227: closing the app is the boot played backwards. The running dots go
 * out one by one, the interface fades, the boot ground comes back, the mark
 * flies from the sidebar back to the centre, turns back into the wireframe
 * cube and spins away — and then `onDone` really quits. App mounts this only
 * after the sessions are saved and only when motion is allowed (D154).
 */
export function BootBack({ from, onDone }: { from: RefObject<HTMLElement | null>; onDone: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const icon = iconRef.current;
    if (root === null || icon === null) {
      doneRef.current();
      return;
    }
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms));

    // The agent's running dots go out, one after another.
    const dots = [
      ...document.querySelectorAll<HTMLElement>(".term-tab .dot-run, .sidebar .dot-run, .agent-live-dot"),
    ].filter((d) => d.getClientRects().length > 0);
    dots.forEach((d, i) =>
      d.animate(
        [
          { transform: "scale(1)", opacity: 1 },
          { transform: "scale(1.6)", opacity: 1, offset: 0.25 },
          { transform: "scale(0)", opacity: 0 },
        ],
        { duration: 360, delay: i * 180, easing: "ease-in", fill: "forwards" },
      ),
    );
    const t1 = dots.length * 180 + 260;

    // The interface fades (no scaling).
    at(t1, () => {
      for (const el of document.querySelectorAll<HTMLElement>(".sidebar, main.content")) {
        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-in", fill: "forwards" });
      }
      document
        .querySelector(".toast-stack")
        ?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" });
    });

    // The ground returns and the mark flies home.
    at(t1 + 360, () => {
      root.style.visibility = "visible";
      root
        .querySelector(".boot-back-bg")
        ?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 520, easing: "ease-out", fill: "forwards" });
      const slot = from.current?.getBoundingClientRect();
      const home = icon.getBoundingClientRect();
      if (slot !== undefined && slot.width > 0) {
        icon.style.transformOrigin = "0 0";
        icon.animate(
          [
            {
              transform: `translate(${slot.left - home.left}px, ${slot.top - home.top}px) scale(${slot.width / home.width})`,
            },
            { transform: "none" },
          ],
          { duration: 760, easing: "cubic-bezier(.65,0,.15,1)", fill: "both" },
        );
      }
    });

    // The mark gives way to the cube, and the cube spins off.
    at(t1 + 360 + 860, () => {
      icon.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, fill: "forwards" });
      root
        .querySelector(".boot-cube-wrap")
        ?.animate(
          [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }],
          { duration: 1150, fill: "forwards" },
        );
      root
        .querySelector(".boot-cube")
        ?.animate(
          [
            { transform: "rotateX(-35.264deg) rotateY(45deg) scale(1)" },
            { transform: "rotateX(250deg) rotateY(-470deg) scale(.35)" },
          ],
          { duration: 1150, easing: "cubic-bezier(.6,0,.85,.3)", fill: "forwards" },
        );
    });

    at(t1 + 360 + 2150, () => doneRef.current());
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [from]);

  return (
    <div className="boot boot--back" ref={rootRef} aria-hidden="true">
      <i className="boot-back-bg" />
      <div className="boot-c">
        <BootMark iconRef={iconRef} />
      </div>
    </div>
  );
}
