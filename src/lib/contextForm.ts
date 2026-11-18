// The project-info form (D142): the context fields a person may edit after
// creation — the name too since D151 — held as the text the form shows and
// compared against what is on disk.

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
  name: string;
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
    name: ctx.name,
    domain: shownDomain(ctx.domain) ?? "",
    description: ctx.description,
    goals: ctx.goals.join("\n"),
    boundaries: ctx.boundaries.join("\n"),
  };
}

/** The fields in the order the form shows them (and the save light runs down them). */
export const CONTEXT_FIELDS = ["name", "domain", "description", "goals", "boundaries"] as const;

export type ContextField = (typeof CONTEXT_FIELDS)[number];

/**
 * Which fields saving would change, in form order. Normalised the way the
 * engine normalises (ops::edit_context), so padding, blank lines and an
 * emptied domain field do not count as edits. Per field because the page
 * marks each edited field on its own (C198, spec 10) — a page-wide "dirty"
 * cannot say which line to draw.
 */
export function dirtyFields(form: ContextForm, ctx: ProjectContext): ContextField[] {
  const domain = form.domain.trim() === "" ? UNSET_DOMAIN : form.domain.trim();
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const changed: Record<ContextField, boolean> = {
    name: form.name.trim() !== ctx.name,
    domain: domain !== ctx.domain,
    description: form.description.trim() !== ctx.description,
    goals: !same(splitLines(form.goals), ctx.goals),
    boundaries: !same(splitLines(form.boundaries), ctx.boundaries),
  };
  return CONTEXT_FIELDS.filter((k) => changed[k]);
}

/** Whether saving would change anything — the Save button lights on exactly this. */
export function isDirty(form: ContextForm, ctx: ProjectContext): boolean {
  return dirtyFields(form, ctx).length > 0;
}

/** A project always has a name — the engine refuses a blank one, as init does,
 *  so the Save button should not offer it. */
export function nameMissing(form: ContextForm): boolean {
  return form.name.trim() === "";
}

/** Whether this save is a rename: the curriculum rendered the old name in and
 *  keeps it until an asset upgrade, which the page then points at (D151). */
export function renames(form: ContextForm, ctx: ProjectContext): boolean {
  return form.name.trim() !== ctx.name;
}
