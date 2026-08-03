import type { TemplateSummary, WorkspaceOverview } from "../types";

// Synthetic catalog categories (D45/D46). Built-in template ids are
// versioned (`generic-v1`…) so these can never collide with a real key.
export const CAT_ALL = "all";
export const CAT_CUSTOM = "custom";
export const CAT_NONE = "none";

/** Which category a workspace belongs to: a built-in template id, the
 *  single "custom" bucket (any non-built-in id — robust even when the
 *  custom template file was deleted later), or "none" (no workflow.json). */
export function categoryOf(ws: WorkspaceOverview, builtInIds: Set<string>): string {
  if (!ws.templateId) return CAT_NONE;
  return builtInIds.has(ws.templateId) ? ws.templateId : CAT_CUSTOM;
}

export interface CategoryItem {
  id: string;
  label: string;
  count: number;
}

/** Sidebar category list: All + every built-in (template-registry order)
 *  and the custom bucket — always listed, zero counts included, so the
 *  directory reads as a stable catalog. Only "No template" is conditional: it is a
 *  legacy holding pen, not a template option, and would be pure noise as a
 *  permanent "0" row. `t` resolves the synthetic labels. */
export function categoryItems(
  overview: WorkspaceOverview[],
  templates: TemplateSummary[],
  t: (key: string) => string,
): CategoryItem[] {
  const builtIns = templates.filter((tpl) => tpl.source === "built_in");
  const builtInIds = new Set(builtIns.map((tpl) => tpl.id));
  const counts = new Map<string, number>();
  for (const ws of overview) {
    const cat = categoryOf(ws, builtInIds);
    counts.set(cat, (counts.get(cat) ?? 0) + 1);
  }
  const items: CategoryItem[] = [
    { id: CAT_ALL, label: t("welcome.catAll"), count: overview.length },
  ];
  for (const tpl of builtIns) {
    items.push({ id: tpl.id, label: tpl.name, count: counts.get(tpl.id) ?? 0 });
  }
  items.push({ id: CAT_CUSTOM, label: t("welcome.catCustom"), count: counts.get(CAT_CUSTOM) ?? 0 });
  const noneCount = counts.get(CAT_NONE) ?? 0;
  if (noneCount > 0) items.push({ id: CAT_NONE, label: t("welcome.catNone"), count: noneCount });
  return items;
}
