/**
 * The project domain as a *label to show a person* — which is not the same
 * thing as the value on disk.
 *
 * `general` is what init writes when nobody named a domain and the chosen
 * template has no domain of its own (init.rs, D137). Rendering it puts the
 * same word on every card and every dashboard of a default catalog: one chip
 * per project carrying no information the page did not already have (r2 3-5,
 * which hid it in the project grid). The dashboard kept showing it for another
 * seven weeks because the rule lived inline in the grid — so it lives here now,
 * and both callers ask the same question.
 */
export const UNSET_DOMAIN = "general";

/** The domain worth showing, or `null` when there is nothing to say. */
export function shownDomain(domain: string | null | undefined): string | null {
  const d = (domain ?? "").trim();
  return d === "" || d === UNSET_DOMAIN ? null : d;
}
