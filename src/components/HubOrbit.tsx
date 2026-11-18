import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { useTranslation } from "react-i18next";

import { motionOff } from "../lib/fx";

/** One chip on the orbit. */
export interface OrbitSession {
  id: string;
  label: string;
  /** The project's short name. */
  project: string;
  waiting: boolean;
}

/** What the page needs from the hub to aim light at it. */
export interface HubHandle {
  orb: () => HTMLElement | null;
  chip: (id: string) => HTMLElement | null;
  /** C7 / C30: the orb's ring pulses once; amber when it is a denial. */
  pulse: (you?: boolean) => void;
  /** C7: the session's chip lights its edge for a moment. */
  flash: (id: string, you?: boolean) => void;
}

/** Most chips on the orbit before the rest fold into one "+N" (invariant 16). */
const ORBIT_MAX = 8;
const LAP_MS = 48000;

/**
 * C6, the hub (spec 20 §1): the orb with every running session circling it on
 * a tilted ellipse. Shared by the projects overview and the agent overview
 * (spec 40), which also draws its two quieter states:
 *
 * - `loading` — the session list has not been read: orb and rings, nothing
 *   turning (invariant 10: the empty look must not play before it is known);
 * - `empty` — read, and nothing is running (C223): the rings turn slowly, the
 *   orb does not breathe.
 *
 * The orbit is a requestAnimationFrame loop at most ~60 fps that writes only
 * transforms, opacity and z-index; under reduced motion the chips are placed
 * once at their starting angles and stay.
 */
export type HubState = "live" | "empty" | "loading";

interface Props {
  sessions: OrbitSession[];
  small?: boolean;
  state?: HubState;
  className?: string;
  /** Chips laid out but not yet shown: a launch keeps its new chip back until
   *  the light lands on it (C293 / C224). */
  hidden?: ReadonlySet<string>;
}

const HubOrbit = forwardRef<HubHandle, Props>(
  function HubOrbit({ sessions, small = false, state = "live", className, hidden }, ref) {
    const { t } = useTranslation();
    const root = useRef<HTMLElement>(null);
    const orbRef = useRef<HTMLDivElement>(null);
    const pulseRef = useRef<HTMLElement>(null);
    const ringsRef = useRef<HTMLDivElement>(null);
    const angle = useRef(0.55);

    const shown = sessions.slice(0, ORBIT_MAX);
    const more = sessions.length - shown.length;
    const chipKey = shown.map((s) => `${s.id}:${s.waiting ? 1 : 0}`).join(",") + `+${more}`;

    useImperativeHandle(ref, () => ({
      orb: () => orbRef.current,
      chip: (id) =>
        root.current?.querySelector<HTMLElement>(`.sess[data-sid="${CSS.escape(id)}"]`) ?? null,
      pulse: (you = false) => {
        const el = pulseRef.current;
        if (el === null || motionOff()) return;
        el.classList.remove("go", "you");
        void el.offsetWidth;
        if (you) el.classList.add("you");
        el.classList.add("go");
      },
      flash: (id, you = false) => {
        const el = root.current?.querySelector<HTMLElement>(`.sess[data-sid="${CSS.escape(id)}"]`);
        if (!el || motionOff()) return;
        const cls = you ? "flash-you" : "flash";
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
        window.setTimeout(() => el.classList.remove(cls), you ? 640 : 650);
      },
    }));

    useEffect(() => {
      const hub = root.current;
      if (hub === null || small) return;
      const place = () => {
        const chips = [...hub.querySelectorAll<HTMLElement>(".sess")];
        const widest = Math.max(0, ...chips.map((c) => c.offsetWidth));
        const rx = Math.min(330, Math.max(150, Math.min(330, hub.clientWidth / 2 - widest / 2 - 8)));
        const ry = rx * 0.242;
        if (ringsRef.current) ringsRef.current.style.transform = `scale(${(rx / 330).toFixed(3)})`;
        chips.forEach((c, i) => {
          const a = angle.current + (i * Math.PI * 2) / chips.length;
          const z = Math.sin(a);
          const s = 0.82 + (0.18 * (z + 1)) / 2;
          c.style.transform = `translate(-50%,-50%) translate(${(Math.cos(a) * rx).toFixed(1)}px,${(z * ry).toFixed(1)}px) scale(${s.toFixed(3)})`;
          c.style.zIndex = z > 0 ? "4" : "1";
          const fade = 0.55 + (0.45 * (z + 1)) / 2;
          c.style.opacity = Math.max(c.dataset.wait ? 0.9 : 0, fade).toFixed(2);
        });
      };
      place();
      if (motionOff()) {
        const ro = new ResizeObserver(place);
        ro.observe(hub);
        return () => ro.disconnect();
      }
      let raf = 0;
      let last = 0;
      const frame = (now: number) => {
        raf = requestAnimationFrame(frame);
        const dt = last === 0 ? 16 : Math.min(now - last, 50);
        if (dt < 15) return;
        last = now;
        angle.current += (dt * Math.PI * 2) / LAP_MS;
        place();
      };
      raf = requestAnimationFrame(frame);
      return () => cancelAnimationFrame(raf);
    }, [chipKey, small]);

    const still = motionOff();
    const ringAmb = still || state === "loading" ? "" : " amb";
    const amb = still || state !== "live" ? "" : " amb";
    return (
      <section
        ref={root}
        className={`hub${small ? " hub--small" : ""}${className ? ` ${className}` : ""}`}
        aria-label={small ? undefined : t("welcome.hubAria", { n: sessions.length })}
        aria-hidden={small ? true : undefined}
      >
        {!small && (
          <div className="hub-rings" aria-hidden="true">
            <div className="hub-plane" ref={ringsRef}>
              <i className={`hub-ring r3${ringAmb}`} />
              <i className={`hub-ring r1${ringAmb}`} />
              <i className="hub-ring r2" />
            </div>
          </div>
        )}
        <div className={`orb${amb}`} ref={orbRef} aria-hidden="true">
          <i className="orb-halo" />
          <i className="orb-core" />
          <i className="orb-pulse" ref={pulseRef} />
        </div>
        {!small && (
          <div className="orb-label" aria-hidden="true">
            nextup hub
          </div>
        )}
        {!small &&
          shown.map((s) => (
            <div
              key={s.id}
              className={`sess${s.waiting ? " is-wait" : ""}${hidden?.has(s.id) ? " is-held" : ""}`}
              data-sid={s.id}
              data-wait={s.waiting ? "1" : undefined}
            >
              {s.waiting ? (
                <i className="mk-y" aria-hidden="true" />
              ) : (
                <i className={`dot-run${amb}`} aria-hidden="true" />
              )}
              <b>{s.label}</b>
              <small>{s.project}</small>
              {s.waiting && <span className="sess-wait">{t("welcome.waitAuth")}</span>}
            </div>
          ))}
        {!small && more > 0 && (
          <div className="sess sess--more" data-sid="+more">
            {t("welcome.hubMore", { n: more })}
          </div>
        )}
      </section>
    );
  },
);

export default HubOrbit;
