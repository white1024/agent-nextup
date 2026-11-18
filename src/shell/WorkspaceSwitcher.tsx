// Aliased: the Esc handler below listens on `document` and needs the DOM
// `KeyboardEvent`, which an unaliased React import would shadow.
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal, flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useGuardedMutation, useRecentWorkspaces } from "../hooks";
import { IconCaretDown, IconX } from "../components/icons";
import type { SystemStatus, WorkspaceInfo, WorkspaceOverview } from "../types";
import ConfirmDanger from "../components/ConfirmDanger";
import { hasOpenModal } from "../components/Modal";
import Scramble from "../components/Scramble";
import { motionOff } from "../lib/fx";
import { EASE_OUT, easeHeight, fadeRowsOut, rowTops, slideRows } from "../lib/listMotion";
import { switchVeil } from "../lib/transitions";

/**
 * How many recent projects the dropdown lists. Six keeps the popup shorter
 * than the shortest window we support even with the section header, the
 * remainder row and "open another folder" stacked under it.
 */
const RECENT_LIMIT = 6;

/** The menu is never narrower than this, even when the sidebar is (D153). */
const MENU_MIN_W = 272;

interface Props {
  workspace: WorkspaceInfo;
  /** "phase · template" under the name (D153); null until the overview is read. */
  meta: string | null;
  onSwitched: (status: SystemStatus) => void;
  /** Jump to the projects home — where the list is complete. */
  onSeeAll: () => void;
}

/**
 * Sidebar workspace switcher: switch to a recent workspace or open another
 * folder without the close-then-reopen detour (open_workspace already swaps
 * state and watcher atomically). Getting back to the projects home is the
 * sidebar's permanent All projects item; actually closing the workspace lives in
 * Settings.
 *
 * Only the most recent few are listed. The registry keeps every project ever
 * opened and never evicts one, which is the right promise for the projects
 * home but the wrong shape for a dropdown — past a dozen or so the menu is
 * taller than the screen and the thing you want is rarely down there anyway.
 */
export default function WorkspaceSwitcher({ workspace, meta, onSwitched, onSeeAll }: Props) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState(false);
  // The menu outlives `openMenu` by its exit animation: closing first marks
  // it leaving, and it unmounts when that animation ends (instantly under
  // reduced motion).
  const [menuShown, setMenuShown] = useState(false);
  const [menuBox, setMenuBox] = useState<CSSProperties>({});
  const { recent, setRecent, reload: reloadRecent } = useRecentWorkspaces();
  /** Recent entry awaiting removal confirmation. Same API as the overview
      card ×, so it gets the same dialog — one action, one risk story. */
  const [confirmRemove, setConfirmRemove] = useState<WorkspaceOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { busy, run } = useGuardedMutation(setError);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (openMenu) {
      setError(null);
      reloadRecent();
    }
  }, [openMenu, reloadRecent]);

  // Placement. The menu is wider than the sidebar (272px against 236px), so
  // nothing inside the sidebar may hold it: the scroller's edge fade is a
  // `mask-image`, and a mask clips every descendant — `position: fixed` ones
  // included — while the sidebar's own `z-index` caps whatever is in it. Being
  // fixed was not enough (my-design review F2: ~46px of the right edge, the
  // "missing" chip and the focus ring were cut off). So the menu is portalled
  // to `body` and placed from the trigger's box when it opens. Anything that
  // would move the trigger out from under it closes it instead of chasing it.
  useLayoutEffect(() => {
    if (!openMenu) return;
    const r = triggerRef.current?.getBoundingClientRect();
    if (r === undefined) return;
    const top = r.bottom + 6;
    setMenuBox({
      top,
      left: r.left,
      width: Math.max(r.width, MENU_MIN_W),
      maxHeight: window.innerHeight - top - 22,
    });
    setMenuShown(true);
    const close = () => setOpenMenu(false);
    const scroller = triggerRef.current?.closest(".sidebar-scroll");
    window.addEventListener("resize", close);
    scroller?.addEventListener("scroll", close, { passive: true });
    return () => {
      window.removeEventListener("resize", close);
      scroller?.removeEventListener("scroll", close);
    };
  }, [openMenu]);

  // Closing: let the exit play, then unmount.
  useEffect(() => {
    if (openMenu || !menuShown) return;
    if (motionOff() || menuRef.current === null) setMenuShown(false);
  }, [openMenu, menuShown]);

  // Close when clicking anywhere outside the switcher.
  useEffect(() => {
    if (!openMenu) return;
    // The menu is portalled out of the switcher, so "inside" is either of them.
    const onDown = (e: MouseEvent) => {
      const at = e.target as Node;
      if (rootRef.current?.contains(at) || menuRef.current?.contains(at)) return;
      setOpenMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openMenu]);

  // Esc closes and returns focus to the trigger button (D64). There used to
  // be only one way out — mousedown — so a keyboard user who tabbed away
  // left the menu hanging open behind them with nowhere for focus to go.
  useEffect(() => {
    if (!openMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Yield while a dialog is stacked above the menu (the remove-project
      // confirmation, say) — that Esc was meant for the dialog.
      if (hasOpenModal()) return;
      setOpenMenu(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openMenu]);

  /**
   * Arrow-key navigation, the contract `role="menu"` signs on the reader's
   * behalf (2026-08-01 UI review, P2 2-6). Declaring the role and then handling
   * only Esc left this the one composite widget in the app without its keyboard
   * pattern — the terminal tabs and the command palette both have theirs.
   *
   * Focus moves, nothing is selected: switching workspaces is a real action, so
   * it waits for Enter on the item rather than following the cursor.
   */
  function menuItems(): HTMLButtonElement[] {
    // The row's remove × is deliberately not a `menuitem`: it is a secondary
    // action *on* a row, and folding it into the same ring would make Down
    // alternate between "go to that project" and "forget that project".
    return [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
      .filter((el) => !el.disabled);
  }

  function onMenuKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    // Tab leaves the menu (ARIA's menu pattern). Portalled to the end of
    // `body`, the menu no longer sits right after the trigger, so the browser's
    // own next stop would be nowhere near the sidebar: hand focus back to the
    // trigger and let this same Tab carry on from there.
    if (e.key === "Tab") {
      setOpenMenu(false);
      triggerRef.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = menuItems();
    if (items.length === 0) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? items.length - 1
          : e.key === "ArrowDown"
            ? // -1 (focus is on nothing in the ring) lands on the first item.
              (at + 1) % items.length
            : at <= 0
              ? items.length - 1
              : at - 1;
    items[next]?.focus();
  }

  // Opening moves focus into the menu (ARIA's menu pattern), which is also what
  // makes the arrow keys above reachable at all: without it the first Down goes
  // to the document, not to the list.
  //
  // Exactly once per opening. `recent` has to be in the deps — opening triggers
  // a reload, so on a cold first open the only item rendered is "Open another
  // folder" and the list arrives a tick later — but without the latch that same
  // dependency would drag focus back to the top every time the reload returns a
  // fresh array, yanking it out from under anyone already arrowing down.
  const focusedForThisOpenRef = useRef(false);
  useEffect(() => {
    if (!openMenu) {
      focusedForThisOpenRef.current = false;
      return;
    }
    if (focusedForThisOpenRef.current) return;
    const first = menuItems()[0];
    if (first === undefined) return;
    focusedForThisOpenRef.current = true;
    first.focus();
  }, [openMenu, recent]);

  const { listed, hidden } = menuSlice(recent, RECENT_LIMIT);

  function switchTo(root: string) {
    if (root === workspace.root) {
      setOpenMenu(false);
      return;
    }
    return run(async () => {
      setError(null);
      const status = await api.openWorkspace(root);
      setOpenMenu(false);
      // C221: the menu gets its moment to fold away, then the old page is
      // pictured and wiped off over the new one. The swap itself is the same
      // `onSwitched` as always — the page stays (invariant 19) and every
      // workspace view remounts under the picture.
      if (!motionOff()) await new Promise((r) => window.setTimeout(r, 200));
      switchVeil(document.querySelector<HTMLElement>("main.content"), () => onSwitched(status));
    });
  }

  async function openOther() {
    setError(null);
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await switchTo(dir);
  }

  /**
   * C217 in the menu (my-design review F4): once confirmed, the row fades where
   * it stands, then the rows after it close the gap and the menu shortens with
   * them. The removal itself has already happened; this is only where the
   * row goes. Reduced motion: the list just changes.
   */
  async function removeRecent(root: string) {
    setError(null);
    try {
      const next = await api.removeRecentWorkspace(root);
      setConfirmRemove(null);
      const menu = menuRef.current;
      const row = menu?.querySelector<HTMLElement>(`[data-row="${CSS.escape(root)}"]`) ?? null;
      const before = rowTops(menu);
      const height = menu?.getBoundingClientRect().height ?? 0;
      await fadeRowsOut([row]);
      flushSync(() => setRecent(next));
      const timing = { duration: 340, easing: EASE_OUT };
      slideRows(menu, before, timing);
      easeHeight(menu, height, timing);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        className="switcher-trigger"
        title={t("switcher.tooltip")}
        aria-haspopup="menu"
        aria-expanded={openMenu}
        onClick={() => setOpenMenu((v) => !v)}
      >
        <span className="ws-lines">
          <Scramble className="ws-name" value={workspace.name} durationMs={760} />
          {meta !== null && <Scramble className="ws-meta" value={meta} durationMs={760} />}
        </span>
        <IconCaretDown size={14} className="caret" />
      </button>

      {menuShown &&
        createPortal(
        <div
          className={`switcher-menu${openMenu ? "" : " switcher-menu--leaving"}`}
          role="menu"
          ref={menuRef}
          style={menuBox}
          onKeyDown={onMenuKey}
          onAnimationEnd={(e) => {
            if (!openMenu && e.target === e.currentTarget) setMenuShown(false);
          }}
        >
          {error && <div className="alert alert-error switcher-error">{error}</div>}
          {busy && <div className="muted switcher-hint">{t("switcher.switching")}</div>}

          {listed.length > 0 && (
            <>
              <div className="switcher-section">{t("welcome.recentTitle")}</div>
              {listed.map((ws) => {
                const isCurrent = ws.root === workspace.root;
                return (
                  <div className="switcher-row" key={ws.root} data-row={ws.root}>
                    <button
                      className={`switcher-item ${isCurrent ? "current" : ""}`}
                      role="menuitem"
                      title={ws.root}
                      disabled={busy || !ws.exists}
                      onClick={() => void switchTo(ws.root)}
                    >
                      <span className="ws-dot" aria-hidden="true" />
                      <span className="item-name">{ws.name}</span>
                      {!ws.exists && (
                        <span className="chip">{t("welcome.recentMissing")}</span>
                      )}
                    </button>
                    {!isCurrent && (
                      <button
                        className="switcher-remove danger-trigger"
                        title={t("welcome.removeRecent")}
                        aria-label={`${t("welcome.removeRecent")} — ${ws.name}`}
                        disabled={busy}
                        onClick={() => setConfirmRemove(ws)}
                      >
                        <IconX size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
              {hidden > 0 && (
                <button
                  data-row="__more"
                  className="switcher-item switcher-more"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => {
                    setOpenMenu(false);
                    onSeeAll();
                  }}
                >
                  {t("switcher.more", { n: hidden })}
                </button>
              )}
              <div className="switcher-divider" />
            </>
          )}

          <button
            data-row="__open"
            className="switcher-item"
            role="menuitem"
            disabled={busy}
            onClick={() => void openOther()}
          >
            <span className="ws-dot" aria-hidden="true" />
            {t("switcher.openOther")}
          </button>
        </div>,
          document.body,
        )}
      {confirmRemove !== null && (
        <ConfirmDanger
          heading={t("welcome.removeConfirmHeading")}
          body={t("welcome.removeConfirmBody", { name: confirmRemove.name })}
          confirmLabel={t("welcome.removeConfirmAction")}
          busy={busy}
          onConfirm={() => void removeRecent(confirmRemove.root)}
          onCancel={() => setConfirmRemove(null)}
        />
      )}

    </div>
  );
}

/**
 * The head of the recent list, plus how many rows that leaves out.
 *
 * Taking the head is what makes this "the most recent few": `record_workspace`
 * re-inserts at index 0 on every open, so the list arrives most-recently-opened
 * first and the cut only ever falls on projects untouched for a while. The
 * current project is always row one, because opening it is what put it there.
 *
 * `hidden` exists so the cut can be *said*. Silently showing six of thirty
 * would read as "the rest are gone", and this app deliberately never forgets a
 * project — the registry has no size cap and removal is explicit only. Keeping
 * the count next to the slice is what stops the two from drifting apart.
 */
export function menuSlice<T>(all: T[] | null, limit: number): { listed: T[]; hidden: number } {
  const listed = (all ?? []).slice(0, limit);
  return { listed, hidden: (all?.length ?? 0) - listed.length };
}
