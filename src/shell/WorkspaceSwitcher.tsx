// Aliased: the Esc handler below listens on `document` and needs the DOM
// `KeyboardEvent`, which an unaliased React import would shadow.
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";

import { api, errorMessage } from "../api";
import { useGuardedMutation, useRecentWorkspaces } from "../hooks";
import { IconCaretDown, IconX } from "../components/icons";
import type { SystemStatus, WorkspaceInfo, WorkspaceOverview } from "../types";
import ConfirmDanger from "../components/ConfirmDanger";
import { hasOpenModal } from "../components/Modal";

interface Props {
  workspace: WorkspaceInfo;
  onSwitched: (status: SystemStatus) => void;
}

/**
 * Sidebar workspace switcher: switch to a recent workspace or open another
 * folder without the close-then-reopen detour (open_workspace already swaps
 * state and watcher atomically). Getting back to the projects home is the
 * sidebar's permanent All projects item; actually closing the workspace lives in
 * Settings.
 */
export default function WorkspaceSwitcher({ workspace, onSwitched }: Props) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState(false);
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

  // Close when clicking anywhere outside the switcher.
  useEffect(() => {
    if (!openMenu) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpenMenu(false);
      }
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

  function switchTo(root: string) {
    if (root === workspace.root) {
      setOpenMenu(false);
      return;
    }
    return run(async () => {
      setError(null);
      const status = await api.openWorkspace(root);
      setOpenMenu(false);
      onSwitched(status);
    });
  }

  async function openOther() {
    setError(null);
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await switchTo(dir);
  }

  async function removeRecent(root: string) {
    setError(null);
    try {
      setRecent(await api.removeRecentWorkspace(root));
      setConfirmRemove(null);
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
        <span className="ws-dot" aria-hidden="true" />
        <span className="ws-name">{workspace.name}</span>
        <IconCaretDown size={14} className="caret" />
      </button>

      {openMenu && (
        <div className="switcher-menu" role="menu" ref={menuRef} onKeyDown={onMenuKey}>
          {error && <div className="alert alert-error switcher-error">{error}</div>}
          {busy && <div className="muted switcher-hint">{t("switcher.switching")}</div>}

          {recent !== null && recent.length > 0 && (
            <>
              <div className="switcher-section">{t("welcome.recentTitle")}</div>
              {recent.map((ws) => {
                const isCurrent = ws.root === workspace.root;
                return (
                  <div className="switcher-row" key={ws.root}>
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
              <div className="switcher-divider" />
            </>
          )}

          <button
            className="switcher-item"
            role="menuitem"
            disabled={busy}
            onClick={() => void openOther()}
          >
            <span className="ws-dot" aria-hidden="true" />
            {t("switcher.openOther")}
          </button>
        </div>
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
