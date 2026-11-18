import type { CSSProperties } from "react";

/**
 * The orbit's centre (D157, spec 50 §15): a wire cube settled at the logo's
 * angle, drawn the way the boot cube is (six faces turned into a box) — the
 * boot's own copy lives in index.html and is sized and timed for the splash,
 * so it cannot be reused here. `e` is the edge, `bw` the line width.
 *
 * `motion.ts` (`cubeNode`) builds the same markup for the cubes it adds and
 * removes itself: change one, change both.
 */
export default function WireCube({ e, bw }: { e: number; bw: number }) {
  return (
    <span className="tvo-cw" aria-hidden="true">
      <span className="tvo-cube" style={{ "--e": `${e}px`, "--bw": `${bw}px` } as CSSProperties}>
        <i />
        <i />
        <i />
        <i />
        <i />
        <i />
      </span>
    </span>
  );
}
