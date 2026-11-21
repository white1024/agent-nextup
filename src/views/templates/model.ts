/**
 * Pure helpers for the template editor (spec 60), kept out of the component so
 * the node test runner can reach them.
 */

/**
 * The phase id a core refusal names, if any (C148: the save's light stops at
 * that phase and its tile is marked). Core's `validate_template` has no
 * structured field for it, so this reads the English original —
 * `phase 'x': …`, `phase 'x' needs a title`, `duplicate phase id 'x'`.
 * `null` for refusals about the template as a whole (empty id, a built-in id).
 */
export function failedPhaseId(message: string): string | null {
  const m = /phase (?:id )?'([^']*)'/.exec(message);
  return m === null ? null : m[1];
}

/**
 * A textarea's lines as instructions: trimmed, blank lines dropped (core
 * refuses an empty ongoing line outright, and an empty phase line says
 * nothing to an agent).
 */
export function instructionLines(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter(Boolean);
}

/**
 * The ongoing instructions as the template carries them (D171 ⑧): none at all
 * when there are no lines, so an emptied field means "staged only" exactly as
 * a template that never had the field — and the draft compares equal to it.
 */
export function ongoingOrNone(lines: string[]): string[] | undefined {
  return lines.length > 0 ? lines : undefined;
}

/**
 * A sentence split so the few characters right before "——" stay on one line
 * with the dash (spec 60 `.tp-nw`): CJK may break anywhere, and a dash that
 * opens a line reads as a list item. Up to six characters, stopping at a space
 * or a comma. Returns [before, kept together, after]; a sentence without the
 * dash (every English one) comes back whole in the first slot.
 */
export function dashParts(s: string): [string, string, string] {
  const i = s.indexOf("——");
  if (i < 0) return [s, "", ""];
  let j = i;
  // Whitespace and the CJK full-width comma, full stop, semicolon and
  // enumeration comma, escaped (D81: no CJK in source outside i18n.ts).
  while (j > 0 && i - j < 6 && !/[\s\uff0c\u3002\uff1b\u3001]/.test(s[j - 1])) j -= 1;
  return [s.slice(0, j), s.slice(j, i + 2), s.slice(i + 2)];
}
