/** Lines past this are summarised as "+N" — the rail is about 196px wide and
 *  a line takes 5 (spec 60 leaves the overflow to us). */
const MAX_LINES = 36;

/**
 * A capability's requirements as a spectrum (C166): one thin line per
 * requirement — "N requirements" drawn another way, beside the words that
 * still say it. The selected one is violet with a point of light sweeping
 * across; one whose file cannot be read is a broken line instead.
 *
 * C169 marks: lines from `grownFrom` on have just been folded in and grow up
 * one after another; lines from `fadeFrom` on are about to go.
 */
export default function SpecSpectrum({
  n,
  on,
  broken,
  grownFrom,
  fadeFrom,
}: {
  n: number;
  on: boolean;
  broken: boolean;
  grownFrom?: number;
  fadeFrom?: number;
}) {
  if (broken) {
    return (
      <span className="spc-spec is-broken" aria-hidden="true">
        <i />
        <i />
      </span>
    );
  }
  const shown = Math.min(n, MAX_LINES);
  return (
    <span className={`spc-spec${on ? " on" : ""}`} aria-hidden="true" data-spc-spec="">
      {Array.from({ length: shown }, (_, i) => {
        const grown = grownFrom !== undefined && i >= grownFrom;
        const going = fadeFrom !== undefined && i >= fadeFrom;
        const style: Record<string, number> | undefined = grown ? { "--d": i - (grownFrom ?? 0) } : undefined;
        return <i key={i} className={grown ? "add" : going ? "out" : undefined} style={style} />;
      })}
      {n > MAX_LINES && <b className="spc-more">+{n - MAX_LINES}</b>}
      {on && <span className="spc-sweep" />}
    </span>
  );
}
