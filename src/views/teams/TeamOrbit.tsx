import { useEffect, useRef, type CSSProperties } from "react";

import { IconStar } from "../../components/icons";
import { motionOff } from "../../lib/fx";
import type { Team } from "../../types";
import { ORBIT_LOOK, positionsFor } from "./looks";
import { CORE, MINI_CUBE, type StarState } from "./motion";
import { miniFlowPath, miniOrbit } from "./orbit";
import WireCube from "./WireCube";

/** C134: one flow at a time, each taking a 2600ms slot of which the light runs 1500ms. */
const SLOT = 2600;
const GO = 1500;
/** The light's head and three fading pieces of tail: length, width, opacity (pathLength 100). */
const TAIL: [number, number, number][] = [
  [30, 1.1, 0.14],
  [17, 1.5, 0.32],
  [8, 1.9, 0.62],
  [0.3, 2.8, 1],
];
const easeInOut = (u: number) => (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);

/**
 * The team card's orbit (D157, spec 50 §12, C61 and C134): a small wire cube
 * with a light breathing behind it, two tilted rings, and the members as
 * planets going round the outer one — starting where they sit on the canvas,
 * so upstream starts on the left. A coordinator is a small star on the cube.
 *
 * No lines: instead one light at a time leaves an upstream planet, bends
 * through the cube and reaches its downstream, following the planets as they
 * turn (C134). With reduced motion the planets stand still and every flow
 * keeps one light parked near its downstream end, tail towards upstream.
 *
 * Flat on purpose: the tilt is a `scaleY`, not 3D — on the design owner's
 * screen a 3D tilt clipped the planets' glow (T-0084).
 *
 * Purely a picture, like the star map's TeamSky — the card's words say the
 * same things — so the whole of it is aria-hidden.
 */
export default function TeamOrbit({ team, state, j }: { team: Team; state: (id: string) => StarState; j: number }) {
  const { deg, flows } = miniOrbit(team, positionsFor(ORBIT_LOOK, team));
  const skyRef = useRef<HTMLSpanElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const flowKey = flows.map((f) => f.join(",")).join(";");

  useEffect(() => {
    const sky = skyRef.current;
    const svg = svgRef.current;
    if (sky === null || svg === null || flows.length === 0) return;
    const light = (d: string, hd: number) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      for (const [L, w, a] of TAIL) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        p.setAttribute("pathLength", "100");
        p.style.strokeDasharray = `${L} 400`;
        p.style.strokeDashoffset = (L - hd).toFixed(2);
        p.style.strokeWidth = String(w);
        p.style.strokeOpacity = String(a);
        g.appendChild(p);
      }
      return g;
    };
    if (motionOff()) {
      svg.replaceChildren(...flows.map(([a1, a2]) => light(miniFlowPath(sky.clientWidth, sky.clientHeight, a1, a2), 86)));
      return () => svg.replaceChildren();
    }
    // The planets turn with a CSS animation; the light's two ends are worked
    // out each frame from how far it has turned, so they stay on the planets.
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const spin = sky.querySelector<HTMLElement>(".tvo-spin");
      const ct = spin?.getAnimations()[0]?.currentTime;
      const r = typeof ct === "number" ? ((ct % 40000) / 40000) * 360 : 0;
      // Once the card has come in (about a second), each card a little later
      // than the one before, so they do not all light at once.
      const tt = now - t0 - 1000 - j * 900;
      const period = flows.length * SLOT;
      const m = ((tt % period) + period) % period;
      const k = Math.floor(m / SLOT);
      const u = (m - k * SLOT) / GO;
      if (tt < 0 || u > 1) {
        if (svg.firstChild !== null) svg.replaceChildren();
      } else {
        const d = miniFlowPath(sky.clientWidth, sky.clientHeight, flows[k][0] + r, flows[k][1] + r);
        const hd = easeInOut(u) * 135;
        const g = svg.firstChild;
        if (g === null) svg.appendChild(light(d, hd));
        else {
          Array.from(g.childNodes).forEach((p, i) => {
            const el = p as SVGPathElement;
            el.setAttribute("d", d);
            el.style.strokeDashoffset = (TAIL[i][0] - hd).toFixed(2);
          });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      svg.replaceChildren();
    };
    // `flows` is rebuilt every render; its key is what changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowKey, j]);

  return (
    <span className="tvo-sky" ref={skyRef} aria-hidden="true">
      <span className="tvo-plane">
        <i className="tvo-mring" />
        <i className="tvo-mring r2" />
        <span className="tvo-spin">
          {team.members.map((m, k) =>
            deg[m.workspaceId] === undefined ? null : (
              <span key={m.workspaceId} className="tvo-arm" style={{ "--a": `${deg[m.workspaceId]}deg` } as CSSProperties}>
                <span className="tvo-cspin">
                  <i
                    className="tvo-planet"
                    data-star={m.workspaceId}
                    data-st={state(m.workspaceId)}
                    style={{ "--s": k } as CSSProperties}
                  />
                </span>
              </span>
            ),
          )}
        </span>
      </span>
      {flows.length > 0 && <svg className="tvo-mfl" ref={svgRef} />}
      <span className="tvo-mcore" data-star={CORE}>
        <WireCube e={MINI_CUBE.e} bw={MINI_CUBE.bw} />
        {team.prime && (
          <i className="tvo-mstar">
            <IconStar size={10} />
          </i>
        )}
      </span>
    </span>
  );
}
