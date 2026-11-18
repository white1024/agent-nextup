import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { IconX } from "./icons";
import { motionOff, takeBox } from "../lib/fx";
import { boxClose, boxOf, pictureOf, settleBox } from "../lib/listMotion";

/**
 * Minimal modal surface (D46 — the app's first modal convention): centered
 * panel over a scrim; Esc, backdrop click and the ✕ button all close it.
 * Content brings its own heading and actions (the wizards' cancel buttons
 * simply call the same onClose).
 *
 * D64 filled in the half of aria-modal that had been declared but never
 * implemented: focus moves in on open, is restored on close, and Tab can't
 * escape behind the dialog.
 *
 * D153 gave it the design's one dialog motion: it rises from below on open
 * (CSS) and sinks on close. The sink is played on an inert copy — see
 * `playExit` — so the real dialog still unmounts the moment its owner drops
 * it, and nothing about focus or the open stack waits for an animation.
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

/**
 * Plays the closing sink on a detached, inert copy of the dialog.
 *
 * The owner unmounts a Modal by no longer rendering it, so the live panel
 * cannot outlive that moment — and should not: focus restore and the open
 * stack (D64) are tied to the real unmount. Instead, while React is removing
 * the node, a copy is taken; once the removal is confirmed, the copy is put
 * back where the original stood, marked `modal-backdrop--leaving` (CSS does
 * the motion), and removed when its animation ends. It is `inert` and
 * `aria-hidden`, so it can be neither focused nor read.
 *
 * Skipped under reduced motion: the dialog just goes.
 */
function playExit(node: HTMLElement) {
  if (!node.isConnected) return;
  // An owner that has already played its own way out (the command palette's
  // C211 collapse) marks the backdrop so the sink does not play on top of it.
  if (node.dataset.exit === "none") return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  // An owner that carries the panel away itself (the envelope folding back into
  // its row, C42) leaves only the scrim to this copy: it fades, the panel in it
  // is never shown.
  const scrimOnly = node.dataset.exit === "scrim";

  const ghost = node.cloneNode(true) as HTMLElement;
  // cloneNode copies attributes, not live state: carry the typed-in values
  // and the panel's scroll offset across so the picture matches the dialog.
  const fields = "input, textarea, select";
  const live = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(fields);
  const copies = ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(fields);
  live.forEach((el, i) => {
    const copy = copies[i];
    if (copy !== undefined) copy.value = el.value;
  });
  const scrollTop = node.querySelector(".modal-panel")?.scrollTop ?? 0;
  const parent = node.parentNode;
  const next = node.nextSibling;

  // A microtask runs after React has finished removing the node and before
  // the browser paints, so the copy appears in the same frame the original
  // leaves. If the node is still attached by then, this was not an unmount
  // (StrictMode re-running effects in dev) and there is nothing to play.
  queueMicrotask(() => {
    if (node.isConnected) return;
    ghost.classList.add("modal-backdrop--leaving");
    if (scrimOnly) ghost.classList.add("modal-backdrop--scrim-only");
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    const host = parent !== null && parent.isConnected ? parent : document.body;
    host.insertBefore(ghost, next !== null && next.parentNode === host ? next : null);
    const panel = ghost.querySelector<HTMLElement>(".modal-panel");
    if (panel !== null) panel.scrollTop = scrollTop;

    let gone = false;
    const remove = () => {
      if (gone) return;
      gone = true;
      ghost.remove();
    };
    panel?.addEventListener("animationend", (e) => {
      if (e.target === panel) remove();
    });
    ghost.addEventListener("animationend", (e) => {
      if (scrimOnly && e.target === ghost) remove();
    });
    // Safety net in case the animation never runs (the sheet failed to load).
    window.setTimeout(remove, 1000);
  });
}

/**
 * Spec 00 §5.8 (D-0035; my-design review F1): a dialog that has just added or
 * saved something closes *into* the row that now holds it, instead of
 * sinking. Call this once the save has landed, while the dialog is still on
 * screen, then drop the dialog and call the returned function with the row
 * once it has rendered. The Modal fades only its scrim (the panel is carried
 * here), and the row stays hidden until the frame arrives — the same frame
 * the envelope folds back with (C42).
 *
 * With nothing to land in (the row off screen, or no row), the scrim fades
 * and the panel simply goes. Reduced motion: an ordinary close.
 */
export function closeIntoRow(inside: Element | null): (row: Element | null) => void {
  const panel = inside?.closest<HTMLElement>(".modal-panel") ?? null;
  const backdrop = panel?.parentElement ?? null;
  if (panel === null || backdrop === null || motionOff()) return () => {};
  backdrop.dataset.exit = "scrim";
  const from = boxOf(panel);
  const out = pictureOf(panel);
  return (row) => {
    if (!(row instanceof HTMLElement)) return;
    const to = boxOf(row);
    if (to.height === 0 || to.top + to.height < 0 || to.top > window.innerHeight) return;
    settleBox();
    const layer = document.createElement("div");
    layer.className = "dlg-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    boxClose({ host: layer, from, to, out, src: row, hide: [row], cls: "dlg-ghost", done: () => layer.remove() });
  };
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
  wizard = false,
  narrow = false,
  top = false,
  reader = false,
  grow = false,
  className,
  tone,
  children,
}: {
  /** Accessible dialog name (content renders the visible heading). */
  label: string;
  onClose: () => void;
  /** Roomier panel for two-column content (the snapshot reader, D61). */
  wide?: boolean;
  /**
   * The new-project wizards' frame (spec 20 section 6): 1120 wide, as tall as
   * the window allows, and the content scrolls inside it instead of the panel.
   */
  wizard?: boolean;
  /**
   * The design's standard dialog width, 480px (D153): confirmations and short
   * forms. Content-heavy dialogs keep the roomier default until their own
   * screen is moved onto the design.
   */
  narrow?: boolean;
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
  /**
   * The owner grows this dialog out of the thing it details (C42, the envelope
   * out of its row): the panel's own rise is off and the scrim darkens more
   * slowly, under the owner's frame. Closing is the owner's too — it marks the
   * backdrop `data-exit="scrim"` before dropping the dialog.
   */
  grow?: boolean;
  /** Extra class on the panel (its width and inner layout). */
  className?: string;
  /**
   * `"danger"` marks a tier-1 confirm (invariant 7; ConfirmDanger is the only
   * caller): a red-tinted edge and a red line drawn across the top.
   */
  tone?: "danger";
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
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

  // Handed a box by the overlay this replaces (the command palette, R-10-25):
  // grow out of it instead of rising, and keep the scrim at full strength from
  // the first frame — the screen behind never brightens and darkens again.
  useLayoutEffect(() => {
    const from = takeBox("dialog");
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (from === null || backdrop === null || panel === null || motionOff()) return;
    backdrop.classList.add("modal-backdrop--handed");
    const to = panel.getBoundingClientRect();
    if (to.width === 0 || to.height === 0) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    panel.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})` },
        { transform: "none" },
      ],
      { duration: 360, easing: "cubic-bezier(.16,1,.3,1)" },
    );
    for (const child of panel.children) {
      child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 160, easing: "ease-out", fill: "backwards" });
    }
  }, []);

  // Layout-effect cleanup runs while the node is still in the document —
  // the last moment a faithful copy can be taken for the exit.
  useLayoutEffect(() => {
    const node = backdropRef.current;
    return () => {
      if (node !== null) playExit(node);
    };
  }, []);

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
      ref={backdropRef}
      className={`modal-backdrop${top ? " modal-backdrop--top" : ""}${grow ? " modal-backdrop--grow" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`modal-panel${wide ? " modal-panel--wide" : ""}${wizard ? " modal-panel--wizard" : ""}${narrow ? " modal-panel--narrow" : ""}${top ? " modal-panel--top" : ""}${
          tone === "danger" ? " modal-panel--danger" : ""
        }${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
      >
        {tone === "danger" && <span className="modal-danger-line" aria-hidden="true" />}
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
