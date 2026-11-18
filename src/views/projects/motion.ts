/**
 * Motion for the overview's card grid (spec 20 §1 C230 / C232, §3 C217): cards
 * move in two dimensions, so the tasks page's row helpers (vertical only, in
 * lib/listMotion.ts) do not fit. Same rules: reduced motion means the end state
 * at once, nothing runs on render, and only transforms on nodes React owns.
 */
import { motionOff } from "../../lib/fx";
import { EASE_IN, EASE_OUT } from "../../lib/listMotion";

export interface Spot {
  x: number;
  y: number;
}

/** Where each `[data-row]` card sits, relative to the grid's own corner. */
export function spotsOf(grid: HTMLElement | null): Map<string, Spot> {
  const out = new Map<string, Spot>();
  if (grid === null) return out;
  const g = grid.getBoundingClientRect();
  for (const el of grid.querySelectorAll<HTMLElement>(":scope > [data-row]")) {
    const r = el.getBoundingClientRect();
    out.set(el.dataset.row ?? "", { x: r.left - g.left, y: r.top - g.top });
  }
  return out;
}

/**
 * Cards present before and after slide from their old spot to the new one
 * (340 ms); cards that were not there rise from 14 px below (420 ms, staggered
 * 80 + 60 i). Cards off screen at both ends are left alone.
 */
export function settleCards(grid: HTMLElement | null, before: Map<string, Spot>): void {
  if (grid === null || motionOff()) return;
  const g = grid.getBoundingClientRect();
  const h = window.innerHeight;
  let i = 0;
  for (const el of grid.querySelectorAll<HTMLElement>(":scope > [data-row]")) {
    const r = el.getBoundingClientRect();
    if (r.top > h || r.bottom < 0) continue;
    const was = before.get(el.dataset.row ?? "");
    if (was === undefined) {
      el.animate(
        [
          { opacity: 0, transform: "translateY(14px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 420, delay: 80 + 60 * i, easing: EASE_OUT, fill: "backwards" },
      );
      i += 1;
      continue;
    }
    const dx = was.x - (r.left - g.left);
    const dy = was.y - (r.top - g.top);
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration: 340,
      easing: EASE_OUT,
    });
  }
}

/** Fades cards out where they stand (190 ms) and resolves when they are gone. */
export async function fadeCards(els: HTMLElement[], duration = 190): Promise<void> {
  if (els.length === 0 || motionOff()) return;
  const anims = els.map((el) => {
    el.style.pointerEvents = "none";
    return el.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration,
      easing: EASE_IN,
      fill: "forwards",
    });
  });
  await Promise.all(anims.map((a) => a.finished.catch(() => undefined)));
}

/** C232: the empty state rises into the grid's place. */
export function riseIn(el: Element | null, delay = 60): void {
  if (!(el instanceof HTMLElement) || motionOff()) return;
  el.animate(
    [
      { opacity: 0, transform: "translateY(18px)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 380, delay, easing: EASE_OUT, fill: "backwards" },
  );
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Replays one of the card's light layers by re-adding `go`. */
function replay(el: Element | null, duration: number) {
  if (!(el instanceof HTMLElement)) return;
  el.style.animationDuration = `${duration}ms`;
  el.classList.remove("go", "you");
  void el.offsetWidth;
  el.classList.add("go");
}

/**
 * C38 (spec 20 section 9): the wizard's preview card charges up once the
 * project exists - it lifts 4px, light runs once round its edge and glows under
 * it - and only then grows into the dashboard. Resolves when it is time to
 * start that page change (820 ms).
 */
export async function chargeCard(card: HTMLElement | null): Promise<void> {
  if (card === null || motionOff()) return;
  card.animate([{ transform: "none" }, { transform: "translateY(-4px)" }], {
    duration: 420,
    easing: EASE_OUT,
    fill: "forwards",
  });
  replay(card.querySelector(".card-sweep"), 900);
  replay(card.querySelector(".card-glow"), 1000);
  await wait(820);
}

/**
 * C40 (spec 20 section 8): the import's sealed card opens - the shackle lifts
 * and turns, the seal fades - and the card charges as in C38. Resolves at
 * 1100 ms, when the page change starts.
 */
export async function unsealCard(card: HTMLElement | null): Promise<void> {
  if (card === null || motionOff()) return;
  const shackle = card.querySelector<SVGElement>(".lock-shackle");
  shackle?.animate([{ transform: "none" }, { transform: "translateY(-3px) rotate(28deg)" }], {
    duration: 380,
    easing: EASE_OUT,
    fill: "forwards",
  });
  card.querySelector<HTMLElement>(".wz-seal")?.animate([{ opacity: 1 }, { opacity: 0 }], {
    duration: 420,
    delay: 420,
    easing: "ease-out",
    fill: "forwards",
  });
  await wait(420);
  void chargeCard(card);
  await wait(680);
}
