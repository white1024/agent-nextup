import { useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * Segmented choice (`.seg`, D153): one block of highlight under the selected
 * option that slides to the next pick rather than jumping. The slide is CSS
 * (a transform on one element); this component only measures where the
 * selected button is. Its edge is --control-line: the group is one control
 * (invariant 9(c)).
 *
 * An option may carry a `count` (the tasks page's status cells, `.n`): it sits
 * after the word in mono, and is part of the button's accessible name.
 */
export default function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  label,
  className,
  markName,
}: {
  options: { value: T; label: string; count?: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name for the group. */
  label: string;
  className?: string;
  /** View-transition name for the sliding block, when a caller runs the pick
   *  through a View Transition (the tasks page, C24) — the block then morphs
   *  with the rows instead of sliding on its own underneath the picture. */
  markName?: string;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const mark = markRef.current;
    const on = root?.querySelector<HTMLElement>("button.active");
    if (root === null || mark === null || on === null || on === undefined) return;
    // The first placement must not slide in from the left edge.
    if (!placed.current) mark.style.transition = "none";
    mark.style.width = `${on.offsetWidth}px`;
    mark.style.height = `${on.offsetHeight}px`;
    mark.style.transform = `translate(${on.offsetLeft}px, ${on.offsetTop}px)`;
    if (!placed.current) {
      void mark.offsetWidth;
      mark.style.transition = "";
      placed.current = true;
    }
  });

  return (
    <div className={`seg${className ? ` ${className}` : ""}`} ref={rootRef} role="group" aria-label={label}>
      <span className="seg-i" ref={markRef} aria-hidden="true" data-vt-name={markName} />
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          className={o.value === value ? "active" : ""}
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined && <span className="n">{o.count}</span>}
        </button>
      ))}
    </div>
  );
}
