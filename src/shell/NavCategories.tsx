import { useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";

import Scramble from "../components/Scramble";
import { CAT_ALL, type CategoryItem } from "../lib/categories";
import { splitAroundCount } from "../lib/format";
import { motionOff } from "../lib/fx";
import { EASE_IN, EASE_OUT } from "../lib/listMotion";

interface Props {
  /** Every category except "All", with its count (from the overview list). */
  cats: CategoryItem[];
  /** How many projects there are — `null` until the overview has been read. */
  total: number | null;
  active: string;
  onSelect: (id: string) => void;
}

/** A row's or a sidebar entry's top, keyed the way it is found again. */
type Tops = Map<string, number>;

/**
 * The projects page's category directory in the sidebar (D46), and its three
 * motions (spec 10 / 20; my-design review F3, F14):
 *
 * - **C231** — "N more categories" / "fold the empty ones": the rows that go
 *   fade, the rows that stay and the sidebar entries below slide to their new
 *   place, and the rows that come in drop into place one after another.
 * - **C235** — the first time the overview is read, each count runs up from 0
 *   (staggered down the column) and the categories that have projects drop
 *   in. Not when the page is merely revisited: then the counts are already
 *   known and nothing plays.
 * - **C230, the sidebar half** — choosing another category slides the selected
 *   ground from the old row to the new one.
 *
 * Until the overview has been read the counts are unknown, not zero
 * (invariant 10): the cells stay blank and the fold row waits.
 */
export default function NavCategories({ cats, total, active, onSelect }: Props) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const loaded = total !== null;

  // Every built-in is always *listed* — but on a catalog where they are mostly
  // unused that meant four permanent "0" rows in the sidebar, pushing the
  // workspace nav below the fold for nothing (r2 3-5). The empty ones fold
  // behind one row instead. The selected category is never folded away, which
  // is what keeps "an emptied selection shows the empty-category message" true
  // rather than turning into a filter that vanished.
  const shown = expanded ? cats : cats.filter((c) => c.count > 0 || c.id === active);
  const folded = cats.length - shown.length;
  const [moreA, moreB] = splitAroundCount((n) => t("welcome.catMore", { n }));

  /** Rows (by `data-cat`) and the sidebar entries below the list (by `data-view`). */
  function tops(): Tops {
    const out: Tops = new Map();
    const list = listRef.current;
    if (list === null) return out;
    for (const el of list.querySelectorAll<HTMLElement>("[data-cat]")) {
      out.set(`c:${el.dataset.cat}`, el.getBoundingClientRect().top);
    }
    for (const el of below(list)) out.set(`v:${el.dataset.view}`, el.getBoundingClientRect().top);
    return out;
  }

  /** C231. */
  function toggle() {
    const list = listRef.current;
    if (list === null || motionOff()) {
      setExpanded((v) => !v);
      return;
    }
    const before = tops();
    const keep = new Set(
      (expanded ? cats.filter((c) => c.count > 0 || c.id === active) : cats).map((c) => c.id),
    );
    const leaving = expanded
      ? [...list.querySelectorAll<HTMLElement>("[data-cat]")].filter(
          (el) => el.dataset.cat !== CAT_ALL && el.dataset.cat !== MORE && !keep.has(el.dataset.cat ?? ""),
        )
      : [];
    const fades = leaving.map((el) => {
      el.style.pointerEvents = "none";
      return el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 190, easing: EASE_IN, fill: "forwards" });
    });
    void Promise.all(fades.map((a) => a.finished.catch(() => undefined))).then(() => {
      flushSync(() => setExpanded((v) => !v));
      slideFrom(list, before, { duration: 340, easing: EASE_OUT });
      let i = 0;
      for (const el of list.querySelectorAll<HTMLElement>("[data-cat]")) {
        if (before.has(`c:${el.dataset.cat}`)) continue;
        el.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "none" },
          ],
          { duration: 300, delay: 40 + i * 45, easing: EASE_OUT, fill: "backwards" },
        );
        i += 1;
      }
    });
  }

  // C235: the first read only. The counts run up through Scramble (each with
  // its own delay below); here, the categories that have projects drop in.
  const wasLoaded = useRef(loaded);
  const firstRead = !wasLoaded.current && loaded;
  useLayoutEffect(() => {
    if (wasLoaded.current || !loaded) return;
    wasLoaded.current = true;
    const list = listRef.current;
    if (list === null || motionOff()) return;
    let i = 0;
    for (const el of list.querySelectorAll<HTMLElement>("[data-cat]")) {
      const id = el.dataset.cat;
      if (id === CAT_ALL || id === MORE) continue;
      if ((cats.find((c) => c.id === id)?.count ?? 0) === 0) continue;
      el.animate(
        [
          { opacity: 0, transform: "translateY(-6px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, delay: 120 + i * 60, easing: EASE_OUT, fill: "backwards" },
      );
      i += 1;
    }
  }, [loaded, cats]);

  // C230, the sidebar half: the selected ground slides from the old row to
  // the new one. The new row's own ground waits until it arrives.
  const prevActive = useRef<{ id: string; top: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    const now = list?.querySelector<HTMLElement>(`[data-cat="${CSS.escape(active)}"]`) ?? null;
    const was = prevActive.current;
    prevActive.current = now === null ? null : { id: active, top: now.getBoundingClientRect().top };
    if (list === null || now === null || was === null || was.id === active || motionOff()) return;
    const listTop = list.getBoundingClientRect().top;
    const r = now.getBoundingClientRect();
    const pill = document.createElement("i");
    pill.className = "nav-cat-pill";
    pill.setAttribute("aria-hidden", "true");
    Object.assign(pill.style, { top: `${r.top - listTop}px`, height: `${r.height}px` });
    list.appendChild(pill);
    now.classList.add("nav-sub--wait");
    const dy = was.top - r.top;
    const slide = pill.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration: 320,
      easing: EASE_OUT,
    });
    const done = () => {
      pill.remove();
      now.classList.remove("nav-sub--wait");
    };
    void slide.finished.then(done, done);
  }, [active]);

  return (
    <div className="nav-cats" ref={listRef}>
      <button
        data-cat={CAT_ALL}
        className={`nav-item nav-sub ${active === CAT_ALL ? "active" : ""}`}
        onClick={() => onSelect(CAT_ALL)}
      >
        <span className="nav-sub-label">{t("welcome.catAll")}</span>
        <Scramble className="nav-count" value={total ?? ""} delayMs={firstRead ? 160 : 0} />
      </button>
      {shown.map((c, i) => (
        <button
          key={c.id}
          data-cat={c.id}
          className={`nav-item nav-sub ${active === c.id ? "active" : ""}`}
          onClick={() => onSelect(c.id)}
        >
          <span className="nav-sub-label">{c.label}</span>
          <Scramble className="nav-count" value={loaded ? c.count : ""} delayMs={firstRead ? 220 + i * 60 : 0} />
        </button>
      ))}
      {loaded && (folded > 0 || expanded) && (
        <button data-cat={MORE} className="nav-item nav-sub nav-sub-more" onClick={toggle}>
          <span className="nav-sub-label">
            {expanded ? (
              t("welcome.catFewer")
            ) : (
              <>
                {moreA}
                <Scramble value={folded} delayMs={firstRead ? 260 : 0} />
                {moreB}
              </>
            )}
          </span>
        </button>
      )}
    </div>
  );
}

/** The fold row's key among the rows. */
const MORE = "__more";

/** The sidebar entries after the list (Teams, Agents, …) — they move with it. */
function below(list: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let n = list.nextElementSibling; n !== null; n = n.nextElementSibling) {
    if (n instanceof HTMLElement && n.dataset.view !== undefined) out.push(n);
  }
  return out;
}

/** Everything measured in `before` that is still there plays from where it was. */
function slideFrom(list: HTMLElement, before: Tops, timing: KeyframeAnimationOptions) {
  const els: [string, HTMLElement][] = [
    ...[...list.querySelectorAll<HTMLElement>("[data-cat]")].map((el) => [`c:${el.dataset.cat}`, el] as [string, HTMLElement]),
    ...below(list).map((el) => [`v:${el.dataset.view}`, el] as [string, HTMLElement]),
  ];
  for (const [key, el] of els) {
    const was = before.get(key);
    if (was === undefined) continue;
    const dy = was - el.getBoundingClientRect().top;
    if (Math.abs(dy) >= 1) el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], timing);
  }
}
