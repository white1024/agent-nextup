import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IconX } from "./icons";

/**
 * Minimal modal surface (D46 — the app's first modal convention): centered
 * panel over a scrim; Esc, backdrop click and the ✕ button all close it.
 * Content brings its own heading and actions (the wizards' cancel buttons
 * simply call the same onClose).
 *
 * D64 filled in the half of aria-modal that had been declared but never
 * implemented: focus moves in on open, is restored on close, and Tab can't
 * escape behind the dialog.
 */

/** Stack of open dialogs. Esc closes only the topmost one — the listener
 *  used to be on document with no stack, so with two dialogs open a single
 *  Esc closed both. */
const openStack: symbol[] = [];

/** Whether any dialog is open. Used by overlays that are **not** Modals
 *  (the switcher menu and friends) to decide whether to consume Esc — they
 *  have their own document listeners and aren't governed by the stack
 *  above, so without yielding, one Esc would close the dialog and the menu
 *  underneath it together. */
export function hasOpenModal(): boolean {
  return openStack.length > 0;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export default function Modal({
  label,
  onClose,
  wide = false,
  top = false,
  reader = false,
  children,
}: {
  /** Accessible dialog name (content renders the visible heading). */
  label: string;
  onClose: () => void;
  /** Roomier panel for two-column content (the snapshot reader, D61). */
  wide?: boolean;
  /**
   * Anchor near the top of the window instead of centring (the command
   * palette, D66): the list grows downward as you type, and a centred panel
   * would shift under the cursor on every keystroke.
   */
  top?: boolean;
  /**
   * This dialog is something to *read*, not to fill in (the envelope, the
   * handoff snapshot). D64's focus-in assumes the first focusable element
   * is a real field near the top; a reader has no field, so the first one
   * is whatever button happens to sit inside the content — focusing it
   * starts the reader partway down its own text. Readers take focus on the
   * panel instead, which is also where a screen reader should begin.
   */
  reader?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol("modal");
  const id = idRef.current;

  // Capture the trigger element **during render**, not in an effect: React
  // moves focus into the autoFocus field during the commit phase, and
  // passive effects run after commit — reading document.activeElement there
  // would pick up an input *inside* the dialog, which unmounts with it, so
  // restoring becomes a no-op and focus falls back to <body>. On the first
  // render commit hasn't happened yet, so activeElement at that moment is
  // the real trigger.
  const restoreRef = useRef<HTMLElement | null>(null);
  if (restoreRef.current === null) {
    restoreRef.current = document.activeElement as HTMLElement | null;
  }

  // Same reason the focus effect below only depends on [id]: captured at
  // render so flipping the prop mid-life can't re-run the whole
  // "restore focus, then move it back in" cycle.
  const readerRef = useRef(reader);

  /** Runs on mount/unmount only: pushing and popping the stack, moving
   *  focus in and restoring it. Deliberately doesn't take onClose — callers
   *  mostly pass an inline arrow function, and putting it in the deps would
   *  re-run the whole "restore focus, then move it back in" cycle on every
   *  parent render. */
  useEffect(() => {
    openStack.push(id);
    const panel = panelRef.current;

    // A caller can use autoFocus to send focus to a particular field, and
    // that takes effect before this effect — if focus is already inside,
    // don't steal it. (StrictMode's double mount restores focus to the
    // trigger first, so in dev the second pass lands on "the first
    // focusable element" instead; where autoFocus points at that same first
    // field — usually the case — the two agree, otherwise dev and
    // production differ in exactly this one place.)
    if (panel !== null && !panel.contains(document.activeElement)) {
      const first = readerRef.current ? null : panel.querySelector<HTMLElement>(FOCUSABLE);
      // preventScroll + scrollTop: the panel is the scroll container
      // (max-height + overflow-y in styles.css), so focusing anything below
      // the fold scrolls the dialog to it. Every dialog opens at the top of
      // its own content — a reader shows its first line, a long form shows
      // its heading — and the focus ring, if any, is what moves instead.
      (first ?? panel).focus({ preventScroll: true });
      panel.scrollTop = 0;
    }

    return () => {
      const at = openStack.indexOf(id);
      if (at !== -1) openStack.splice(at, 1);
      restoreRef.current?.focus();
    };
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Completely inert while stacked underneath another dialog.
      if (openStack[openStack.length - 1] !== id) return;

      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const panel = panelRef.current;
      if (panel === null) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = panel.contains(active);
      if (e.shiftKey && (!inside || active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id, onClose]);

  return (
    <div
      className={`modal-backdrop${top ? " modal-backdrop--top" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`modal-panel${wide ? " modal-panel--wide" : ""}${top ? " modal-panel--top" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {children}
        {/* Placed after the content in DOM order so that "the first
            focusable element" is a real field rather than the close button;
            .modal-close is position:absolute, so its visual position is
            unaffected.
            Trade-off: its tab order (last) therefore diverges from its
            visual position (top right, where it looks first). That is the
            convention for most dialogs — read the content before being
            offered the exit — but it genuinely is an order shift in the
            sense of WCAG 2.4.3. It is deliberate; don't "fix" it back. */}
        <button
          className="btn btn-ghost btn-icon modal-close"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={onClose}
        >
          <IconX size={14} />
        </button>
      </div>
    </div>
  );
}
