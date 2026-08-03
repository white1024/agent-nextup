import { usePulse } from "../../hooks/anim";

/**
 * Two tones, because there are two renderings (r2 2-4). The type used to
 * offer "accent" and "good" as well; nothing mapped them, so two of the six
 * dashboard tiles were declaring an intent that never reached the screen and
 * the next person to add a tile had four names to choose between and two
 * outcomes. If a third rendering is ever designed, add the name back with the
 * CSS that makes it real.
 */
export type StatTone = "neutral" | "serious";

interface Props {
  label: string;
  value: number;
  tone: StatTone;
}

/**
 * KPI stat tile. Quiet by design — only the "needs attention" tone (serious)
 * gets color. The number ticks when its value actually changes (usePulse).
 */
export default function StatTile({ label, value, tone }: Props) {
  const ticking = usePulse(value);
  return (
    <div className={`stat-tile ${tone === "serious" ? "stat-tile--warn" : ""}`}>
      <div className={`stat-num ${ticking ? "ticking" : ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
