/**
 * Frontend capability-module catalog (D48): one row per module, consumed by
 * the init wizard checkboxes, the settings switches and the nav gating — so
 * adding a module is one entry here (plus its i18n keys `wizard.module_<id>`,
 * `wizard.moduleHint_<id>`, `settings.module_<id>`, `settings.moduleOn_<id>`,
 * `settings.moduleOff_<id>`), not three hardcoded surfaces.
 *
 * Ids must match the Rust registry (`modules.rs` KNOWN_MODULES) — the engine
 * refuses unknown ids at init/toggle time, so a drift here fails loudly.
 */
export const MODULE_CATALOG = [
  { id: "collab", view: "collab" },
  { id: "specs", view: "specs" },
  { id: "team", view: "inbox" },
] as const;

export type ModuleId = (typeof MODULE_CATALOG)[number]["id"];

/** The workspace nav view a module contributes, if any. */
export function moduleForView(view: string): ModuleId | null {
  const entry = MODULE_CATALOG.find((m) => m.view === view);
  return entry ? entry.id : null;
}
