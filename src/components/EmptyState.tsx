import type { ComponentType, ReactNode } from "react";

import type { IconProps } from "./icons";

interface Action {
  label: string;
  onClick: () => void;
  icon?: ComponentType<IconProps>;
  /** Primary styling — reserve it for the one obvious next step. */
  primary?: boolean;
}

interface Props {
  /** What is (not) here, as a statement. One line. */
  title: string;
  /** Where the first step is. Say the place ("the form below", "the Tasks
   *  view"), not just the verb — a hint that does not point anywhere is the
   *  B-grade this component exists to retire. */
  hint?: ReactNode;
  /** Ordered first-run steps. Presence selects the `guide` variant. */
  steps?: string[];
  action?: Action;
  /**
   * `inline` — a slot inside a populated page (a list that happens to be
   *   empty, a filter that matched nothing).
   * `guide` — this whole surface is empty and the user has never used it;
   *   carries a heading and, usually, `steps`.
   */
  variant?: "inline" | "guide";
  /** Layout hook for the surrounding surface (rail padding, grid placement).
   *  Visual weight belongs to `variant`; this is only for where it sits. */
  className?: string;
}

/**
 * The shared empty state (D65).
 *
 * Before this, 22 call sites hand-rolled `<p className="muted">…</p>` — a
 * generic secondary-text colour borrowed as a container — and the two places
 * that did it properly (the projects hero, the team canvas guide card) shared
 * no CSS with each other. There was nothing to collect, so this is the
 * collection point: new empty states go through it.
 *
 * Three rules the call sites are responsible for, because no type can enforce
 * them:
 *  - **`title` is a short statement; the next step goes in `hint`.** This is
 *    the one the first cut got wrong: the existing strings were written as
 *    self-contained "statement + what to do" messages, so reusing them as
 *    titles left `title` and `hint` saying the same thing — and in `guide`,
 *    rendered a three-clause sentence as an `<h2>`. If a title needs a comma
 *    and a verb, it is a hint wearing the wrong hat.
 *  - **Say where the next step is.** "No tasks yet" alone is a dead end; the
 *    hint has to name the place — the form above, the Tasks view. When there
 *    is nowhere to point (the user is waiting on someone else), say where the
 *    thing will come *from* instead.
 *  - **"Nothing here" and "your filter matched nothing" are different
 *    states.** The second one gets an action that clears the filter, never a
 *    "create your first" invitation — the thing already exists, it is hidden.
 */
export default function EmptyState({
  title,
  hint,
  steps,
  action,
  variant = "inline",
  className,
}: Props) {
  const Icon = action?.icon;
  return (
    <div className={`empty empty--${variant}${className === undefined ? "" : ` ${className}`}`}>
      {variant === "guide" ? (
        <h2 className="empty-title">{title}</h2>
      ) : (
        <p className="empty-title">{title}</p>
      )}
      {hint !== undefined && <p className="empty-hint">{hint}</p>}
      {steps !== undefined && steps.length > 0 && (
        <ol className="empty-steps">
          {steps.map((step, i) => (
            // Index, not the text: steps are a fixed-order list, and two of
            // them could legitimately read the same once interpolated.
            <li key={i}>{step}</li>
          ))}
        </ol>
      )}
      {action !== undefined && (
        <div className="empty-actions">
          <button
            className={`btn btn-small ${action.primary === true ? "btn-primary" : ""}`}
            onClick={action.onClick}
          >
            {Icon !== undefined && <Icon size={14} />} {action.label}
          </button>
        </div>
      )}
    </div>
  );
}
