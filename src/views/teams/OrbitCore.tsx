import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { IconStar } from "../../components/icons";
import type { Team } from "../../types";
import type { Positions } from "./layout";
import { CORE, CUBE } from "./motion";
import { orbitHoles, type OrbitGeo } from "./orbit";
import WireCube from "./WireCube";

/**
 * The orbit canvas's centre (D157, spec 50 §15, C63): the wire cube with a
 * soft light breathing behind it, the orbit every member sits on — broken
 * wherever it would run through a name — with one light going round it, and
 * a dashed inner ring turning slowly. Drawn in xyflow's viewport, above the
 * flows and below the nodes, so it pans and zooms with them.
 *
 * Nothing under the cube says "hub" (the design owner's T-0084: drop the
 * word). When the team has a coordinator its name sits there instead — the
 * one place the canvas names it, because the orbit's centre is above the
 * flow, which is where D117 puts the prime. It is still not a member: no
 * node, no edges, nothing to click.
 *
 * Purely a picture; the header says who coordinates, so this is aria-hidden.
 */
export default function OrbitCore({ team, geo, pos }: { team: Team; geo: OrbitGeo; pos: Positions }) {
  const { t } = useTranslation();
  // The ring's light and the inner ring carry on from where they were when the
  // core is redrawn (a drag, a re-read), instead of starting over.
  const [phase] = useState(() => Math.round(performance.now() % 9000));
  const w = 2 * geo.rx + 80;
  const h = 2 * geo.ry + 80;
  const maskId = `tvo-ring-mask-${team.id}`;
  return (
    <div
      className={`tvo-core${team.prime ? " prime" : ""}`}
      data-core=""
      aria-hidden="true"
      style={{ transform: `translate(${geo.cx}px,${geo.cy}px)`, "--ph": `-${phase}ms` } as CSSProperties}
    >
      <svg
        className="tvo-rings"
        width={w}
        height={h}
        viewBox={`${-w / 2} ${-h / 2} ${w} ${h}`}
        style={{ left: -w / 2, top: -h / 2 }}
      >
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x={-w / 2} y={-h / 2} width={w} height={h}>
            {/* White keeps, black cuts: a mask's own luminance, not a theme colour. */}
            <rect x={-w / 2} y={-h / 2} width={w} height={h} fill="white" />
            <g fill="black">
              {orbitHoles(team, geo, pos).map((r, i) => (
                <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} rx={10} />
              ))}
            </g>
          </mask>
        </defs>
        <g mask={`url(#${maskId})`}>
          <ellipse className="tvo-ring" rx={geo.rx} ry={geo.ry} />
          <ellipse className="tvo-ring-run" rx={geo.rx} ry={geo.ry} pathLength={100} />
        </g>
        <ellipse className="tvo-ring2" rx={Math.round(geo.rx * 0.34)} ry={Math.round(geo.ry * 0.34)} pathLength={100} />
      </svg>
      <div className="tvo-orb" data-star={CORE}>
        <i className="tvo-orb-halo" />
        <WireCube e={CUBE.e} bw={CUBE.bw} />
      </div>
      {team.prime && (
        <div className="tvo-label">
          <IconStar size={12} />
          <span>{t("teams.primeAction")}</span>
          <b>{team.prime.name}</b>
        </div>
      )}
    </div>
  );
}
