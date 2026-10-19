// The project-info form (D142): the four context fields a person may edit
// after creation, held as the text the form shows and compared against what
// is on disk.

import type { ProjectContext } from "../types";
import { UNSET_DOMAIN, shownDomain } from "./domain";

/** Textarea → one trimmed entry per non-empty line. */
export function splitLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Domains the inputs suggest. No "general": it is the word for "nobody said"
 *  (D137), and picking it from a list is picking a value that renders as
 *  nothing — offering it is offering a no-op. */
export const DOMAIN_SUGGESTIONS = ["coding", "research", "business", "life"];

/** What the form fields hold. */
export interface ContextForm {
  domain: string;
  description: string;
  goals: string;
  boundaries: string;
}

/** The form a context opens as. `general` shows as an empty field — the same
 *  rule the dashboard chip follows, so the editor never displays a value the
 *  rest of the app hides. */
export function formOf(ctx: ProjectContext): ContextForm {
  return {
    domain: shownDomain(ctx.domain) ?? "",
    description: ctx.description,
    goals: ctx.goals.join("\n"),
    boundaries: ctx.boundaries.join("\n"),
  };
}

/**
 * Whether saving would change anything. Normalised the way the engine
 * normalises (ops::edit_context), so padding, blank lines and an emptied
 * domain field do not light up a Save button that would then write nothing.
 */
export function isDirty(form: ContextForm, ctx: ProjectContext): boolean {
  const domain = form.domain.trim() === "" ? UNSET_DOMAIN : form.domain.trim();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return (
    domain !== ctx.domain ||
    form.description.trim() !== ctx.description ||
    !same(splitLines(form.goals), ctx.goals) ||
    !same(splitLines(form.boundaries), ctx.boundaries)
  );
}
