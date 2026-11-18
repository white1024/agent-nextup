import type { CSSProperties } from "react";

import type { Team } from "../../types";
import { edgeKey, positionsOf, skyPoints } from "./layout";
import type { StarState } from "./motion";

/**
 * The team card's constellation (spec 50 §1, C55): the canvas drawn small.
 * Members are stars where they sit on the canvas, flows are rays of light,
 * the automatic ones carry two lights running along them; a member waiting
 * on you is an amber star with a pulse, one whose folder is gone is hollow.
 *
 * Purely a picture — the card's own text says the same things (counts, the
 * member names, "Pending N"), so the whole sky is `aria-hidden`.
 *
 * `state` is asked per member and must answer "ok" until the outbox read has
 * landed: an amber star before then would claim something about a folder
 * nobody has opened yet (invariant 10, spec 50 §1, the status section).
 */
export default function TeamSky({ team, state }: { team: Team; state: (id: string) => StarState }) {
  const sky = skyPoints(team, positionsOf(team, team.layout));
  const pts = Object.values(sky);
  const neb =
    pts.length > 0
      ? {
          left: `${(pts.reduce((s, p) => s + p.x, 0) / pts.length).toFixed(1)}%`,
          top: `${(pts.reduce((s, p) => s + p.y, 0) / pts.length).toFixed(1)}%`,
        }
      : null;
  return (
    <span className="tsm-sky" aria-hidden="true">
      {neb !== null && <i className="tsm-neb" style={neb} />}
      {team.edges.map((e, k) => {
        const a = sky[e.from];
        const b = sky[e.to];
        if (a === undefined || b === undefined) return null;
        const vars = {
          "--s": k,
          "--x1": `${a.x}%`,
          "--y1": `${a.y}%`,
          "--x2": `${b.x}%`,
          "--y2": `${b.y}%`,
        } as CSSProperties;
        return (
          <span key={edgeKey(e)} className="tsm-ray" data-auto={e.autoRoute ? "1" : "0"} style={vars}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none">
              <line className="tsm-ray-glow" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            </svg>
            {e.autoRoute && (
              <>
                <i className="tsm-mote" style={{ "--k": 0 } as CSSProperties} />
                <i className="tsm-mote" style={{ "--k": 1 } as CSSProperties} />
              </>
            )}
          </span>
        );
      })}
      {team.members.map((m, k) => {
        const p = sky[m.workspaceId];
        if (p === undefined) return null;
        return (
          <i
            key={m.workspaceId}
            className="tsm-star"
            data-star={m.workspaceId}
            data-st={state(m.workspaceId)}
            style={{ left: `${p.x}%`, top: `${p.y}%`, "--s": k } as CSSProperties}
          />
        );
      })}
    </span>
  );
}
