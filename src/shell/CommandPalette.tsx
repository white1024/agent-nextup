import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Modal from "../components/Modal";
import EmptyState from "../components/EmptyState";

/** One runnable entry. `group` heads the section it renders under. */
export interface Command {
  id: string;
  group: string;
  title: string;
  /** Secondary line — a path, a status, whatever disambiguates two same-named rows. */
  hint?: string;
  /** Extra text folded into matching but never shown (English name of a zh label, etc). */
  keywords?: string;
  /**
   * Listed only once something has been typed. Tasks run to hundreds in a real
   * workspace; offered unconditionally they bury the handful of navigation
   * commands the palette exists for.
   */
  searchOnly?: boolean;
  icon?: ReactNode;
  run: () => void;
}

/**
 * Command palette (D66, product review §2-6): one keyboard entry point for switching
 * project/view, finding a task and recording a decision.
 *
 * Navigation uses the `aria-activedescendant` pattern rather than moving real
 * focus: the input keeps focus and the arrow keys move a *virtual* cursor. That
 * is the standard combobox contract, and it is also what lets this live inside
 * `Modal` at all — Modal's focus trap owns Tab, so a list that navigated by
 * really focusing each row would fight it on every keystroke.
 */
export default function CommandPalette({
  commands,
  loading = false,
  onClose,
}: {
  commands: Command[];
  /**
   * Some source behind `commands` has not answered yet (invariant 10). The list
   * still renders what has arrived — this only decides whether "no matches" is
   * an honest statement or a guess.
   */
  loading?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return commands.filter((cmd) => cmd.searchOnly !== true);
    return commands.filter((cmd) =>
      `${cmd.title} ${cmd.hint ?? ""} ${cmd.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  // Typing changes the list under the cursor; anchoring back to the top is the
  // only position that is meaningful across two different result sets.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // The active row can be off-screen after arrow-keying down a long list. Only
  // scrolls the list box, never the page (`block: "nearest"`).
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${active}`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, matches]);

  function move(delta: number) {
    if (matches.length === 0) return;
    // Wrap around: at the bottom of a short list, pressing ↓ again returning to
    // the top beats going nowhere.
    setActive((cur) => (cur + delta + matches.length) % matches.length);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActive(Math.max(0, matches.length - 1));
    } else if (e.key === "Enter") {
      const picked = matches[active];
      if (picked === undefined) return;
      e.preventDefault();
      // Close first: several commands switch view, and unmounting the palette
      // after the switch would restore focus into a tree that no longer exists.
      onClose();
      picked.run();
    }
    // Escape is Modal's — it owns the open-dialog stack.
  }

  // Section headers are derived, not stored: `commands` arrives already ordered
  // by group, so a header renders wherever the group changes.
  let lastGroup: string | null = null;

  return (
    <Modal top label={t("cmdk.label")} onClose={onClose}>
      <div className="cmdk">
        <input
          autoFocus
          className="cmdk-input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={matches.length > 0 ? `cmdk-opt-${active}` : undefined}
          aria-label={t("cmdk.label")}
          placeholder={t("cmdk.placeholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />

        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label={t("cmdk.results")} ref={listRef}>
          {matches.map((cmd, i) => {
            const header = cmd.group !== lastGroup ? cmd.group : null;
            lastGroup = cmd.group;
            return (
              <div key={cmd.id}>
                {header !== null && <div className="cmdk-group">{header}</div>}
                <div
                  id={`cmdk-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`cmdk-item${i === active ? " cmdk-item--on" : ""}`}
                  // Pointer users get the same rows. `onMouseDown` rather than
                  // `onClick` so the press lands before the input's blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    onClose();
                    cmd.run();
                  }}
                  onMouseMove={() => setActive(i)}
                >
                  {cmd.icon !== undefined && (
                    <span className="cmdk-icon" aria-hidden="true">
                      {cmd.icon}
                    </span>
                  )}
                  <span className="cmdk-title">{cmd.title}</span>
                  {cmd.hint !== undefined && <span className="cmdk-hint">{cmd.hint}</span>}
                </div>
              </div>
            );
          })}

          {/* Three states, not two (invariant 10): still fetching is not the same
              claim as "nothing matches what you typed". */}
          {matches.length === 0 &&
            (loading ? (
              <p className="cmdk-loading muted">{t("common.loading")}</p>
            ) : (
              <EmptyState title={t("cmdk.noMatch")} hint={t("cmdk.noMatchHint")} />
            ))}
        </div>

        <div className="cmdk-foot">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          <span>{t("cmdk.footMove")}</span>
          <kbd>Enter</kbd>
          <span>{t("cmdk.footRun")}</span>
          <kbd>Esc</kbd>
          <span>{t("cmdk.footClose")}</span>
        </div>
      </div>
    </Modal>
  );
}
