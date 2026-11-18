import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import Modal from "../components/Modal";
import EmptyState from "../components/EmptyState";
import { IconSearch } from "../components/icons";
import { centreOf, fx, motionOff, stashBox } from "../lib/fx";

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
  /**
   * Where the pick flies to (C211, D153): the sidebar cell its page lives
   * under, read at the moment of the pick. No target (recording a decision)
   * means no flight — the palette just closes.
   */
  flyTo?: () => Element | null;
  /**
   * The pick opens a dialog (recording a decision): the palette grows into it
   * rather than collapsing onto its row, and the scrim stays as it is
   * (R-10-25, my-design review F5).
   */
  opensDialog?: boolean;
  run: () => void;
}

/** Wraps the first case-insensitive occurrence of `q` in `text` (C210's hit). */
function highlight(text: string, q: string): ReactNode {
  if (q === "") return text;
  const at = text.toLowerCase().indexOf(q);
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <span className="cmdk-hit">{text.slice(at, at + q.length)}</span>
      {text.slice(at + q.length)}
    </>
  );
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Command palette (D66, product review §2-6): one keyboard entry point for switching
 * project/view, finding a task and recording a decision.
 *
 * Navigation uses the `aria-activedescendant` pattern rather than moving real
 * focus: the input keeps focus and the arrow keys move a *virtual* cursor. That
 * is the standard combobox contract, and it is also what lets this live inside
 * `Modal` at all — Modal's focus trap owns Tab, so a list that navigated by
 * really focusing each row would fight it on every keystroke.
 *
 * Motion (D153): the cursor is one background block that slides between rows;
 * typing slides the rows that stay into their new places and lights the
 * matched text (C210). Picking collapses the panel into the chosen row, sends
 * a beam of light into the sidebar cell the command leads to, lights that cell,
 * and only then runs the command (C211). Under reduced motion the panel just
 * goes, the cell lights for a moment, and the command runs.
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
  const [picking, setPicking] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => {
    if (q === "") return commands.filter((cmd) => cmd.searchOnly !== true);
    return commands.filter((cmd) =>
      `${cmd.title} ${cmd.hint ?? ""} ${cmd.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, q]);

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

  // The cursor block follows the active row (C210: slides, 190ms, in CSS).
  useLayoutEffect(() => {
    const cur = curRef.current;
    const row = rowsRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${active}`);
    if (cur === null) return;
    if (row === null || row === undefined) {
      cur.style.opacity = "0";
      return;
    }
    cur.style.opacity = "1";
    cur.style.transform = `translateY(${row.offsetTop}px)`;
    cur.style.height = `${row.offsetHeight}px`;
  }, [active, matches]);

  // C210: rows that survive a keystroke slide from where they were; rows that
  // are new fade in. Keyed by command id, measured before and after the commit.
  const lastTops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const rows = rowsRef.current;
    if (rows === null) return;
    const now = new Map<string, number>();
    for (const el of rows.querySelectorAll<HTMLElement>("[data-cmd]")) {
      now.set(el.dataset.cmd ?? "", el.offsetTop);
    }
    const before = lastTops.current;
    lastTops.current = now;
    if (before.size === 0 || motionOff()) return;
    for (const el of rows.querySelectorAll<HTMLElement>("[data-cmd]")) {
      const id = el.dataset.cmd ?? "";
      const was = before.get(id);
      const is = now.get(id) ?? 0;
      if (was === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
      } else if (was !== is) {
        el.animate([{ transform: `translateY(${was - is}px)` }, { transform: "none" }], {
          duration: 260,
          easing: "cubic-bezier(.16,1,.3,1)",
        });
      }
    }
    // Only typing moves rows; the arrow keys move the cursor block alone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function move(delta: number) {
    if (matches.length === 0) return;
    // Wrap around: at the bottom of a short list, pressing ↓ again returning to
    // the top beats going nowhere.
    setActive((cur) => (cur + delta + matches.length) % matches.length);
  }

  /** C211, then the command. */
  async function pick(cmd: Command, index: number) {
    if (picking) return;
    setPicking(true);
    if (cmd.opensDialog === true) {
      // Hand the panel's box to the dialog and leave without our own exit:
      // the dialog grows out of it over a scrim that never went away.
      const panel = rootRef.current?.closest<HTMLElement>(".modal-panel") ?? null;
      const backdrop = rootRef.current?.closest<HTMLElement>(".modal-backdrop") ?? null;
      if (panel !== null && backdrop !== null && !motionOff()) {
        const r = panel.getBoundingClientRect();
        stashBox("dialog", { left: r.left, top: r.top, width: r.width, height: r.height });
        backdrop.dataset.exit = "none";
      }
      onClose();
      cmd.run();
      return;
    }
    const target = cmd.flyTo?.() ?? null;
    const root = rootRef.current;
    const backdrop = root?.closest<HTMLElement>(".modal-backdrop") ?? null;
    const panel = root?.closest<HTMLElement>(".modal-panel") ?? null;
    const row = rowsRef.current?.querySelector<HTMLElement>(`#cmdk-opt-${index}`) ?? null;

    const lightTarget = (ms: number) => {
      if (!(target instanceof HTMLElement)) return;
      target.classList.remove("shell-flash");
      void target.offsetWidth;
      target.classList.add("shell-flash");
      window.setTimeout(() => target.classList.remove("shell-flash"), ms);
    };

    if (motionOff() || backdrop === null || panel === null || row === null) {
      // The result at once: close, mark where it landed, go.
      onClose();
      lightTarget(260);
      cmd.run();
      return;
    }

    // Our own exit; the Modal's sink must not play over it.
    backdrop.dataset.exit = "none";
    const others = [...panel.querySelectorAll<HTMLElement>(".cmdk-search, .cmdk-foot, .cmdk-group, [data-cmd]")].filter(
      (el) => el !== row,
    );
    for (const el of others) el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" });
    row.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, delay: 60, fill: "forwards" });
    backdrop.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, delay: 160, fill: "forwards" });

    // The panel itself becomes a frame that shrinks onto the row, then flattens
    // into a line and is gone.
    const from = panel.getBoundingClientRect();
    const to = row.getBoundingClientRect();
    const frame = document.createElement("div");
    frame.className = "cmdk-ghost";
    frame.setAttribute("aria-hidden", "true");
    Object.assign(frame.style, {
      left: `${from.left}px`,
      top: `${from.top}px`,
      width: `${from.width}px`,
      height: `${from.height}px`,
    });
    document.body.appendChild(frame);
    panel.style.opacity = "0";
    await frame.animate(
      [
        { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
        { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: 240, delay: 170, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" },
    ).finished.catch(() => undefined);
    await frame.animate([{ transform: "scaleY(1)", opacity: 1 }, { transform: "scaleY(.08)", opacity: 0 }], {
      duration: 150,
      easing: "ease-in",
      fill: "forwards",
    }).finished.catch(() => undefined);
    frame.remove();

    onClose();
    const start = centreOf(row) ?? { x: to.left + to.width / 2, y: to.top + to.height / 2 };
    const end = centreOf(target);
    if (end !== null) {
      // Into the sidebar: first to its edge at the row's height, then along it
      // to the cell — a straight shot would cut across the page.
      const sidebar = document.querySelector(".sidebar")?.getBoundingClientRect();
      if (sidebar !== undefined && end.x < sidebar.right) {
        const edge = { x: sidebar.right, y: start.y };
        fx.beam(start, edge, { width: 2.4, dur: 300 });
        fx.beam(edge, end, { width: 2.4, dur: 340, delay: 280 });
        await wait(620);
      } else {
        fx.beam(start, end, { width: 2.4, dur: 520 });
        await wait(520);
      }
      lightTarget(620);
      await wait(170);
    }
    cmd.run();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (picking) {
      e.preventDefault();
      return;
    }
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
      void pick(picked, active);
    }
    // Escape is Modal's — it owns the open-dialog stack.
  }

  // Section headers are derived, not stored: `commands` arrives already ordered
  // by group, so a header renders wherever the group changes.
  let lastGroup: string | null = null;

  return (
    <Modal top label={t("cmdk.label")} onClose={onClose}>
      <div className="cmdk" ref={rootRef}>
        <label className="cmdk-search">
          <IconSearch size={16} />
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
            readOnly={picking}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </label>

        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label={t("cmdk.results")} ref={listRef}>
          <div className="cmdk-rows" ref={rowsRef}>
            <div className="cmdk-cur" ref={curRef} aria-hidden="true" />
            {matches.map((cmd, i) => {
              const header = cmd.group !== lastGroup ? cmd.group : null;
              lastGroup = cmd.group;
              return (
                <div key={cmd.id}>
                  {header !== null && <div className="cmdk-group">{header}</div>}
                  <div
                    id={`cmdk-opt-${i}`}
                    data-cmd={cmd.id}
                    role="option"
                    aria-selected={i === active}
                    className={`cmdk-item${i === active ? " cmdk-item--on" : ""}`}
                    // Pointer users get the same rows. `onMouseDown` rather than
                    // `onClick` so the press lands before the input's blur.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      void pick(cmd, i);
                    }}
                    onMouseMove={() => {
                      if (!picking) setActive(i);
                    }}
                  >
                    {cmd.icon !== undefined && (
                      <span className="cmdk-icon" aria-hidden="true">
                        {cmd.icon}
                      </span>
                    )}
                    {/* Keyed by the query so the hit's flash replays on every
                        keystroke (C210), and only on a keystroke. */}
                    <span className="cmdk-title" key={`t${q}`}>
                      {highlight(cmd.title, q)}
                    </span>
                    {cmd.hint !== undefined && (
                      <span className="cmdk-hint" key={`h${q}`}>
                        {highlight(cmd.hint, q)}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Three states, not two (invariant 10): still fetching is not the same
              claim as "nothing matches what you typed". */}
          {matches.length === 0 &&
            (loading ? (
              <p className="cmdk-loading">{t("common.loading")}</p>
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
