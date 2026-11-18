/**
 * Motion for the agent overview (spec 40): the in-group launch row opening
 * and closing (C290), and a new session arriving (C293 / C224).
 *
 * Same rules as lib/fx.ts and lib/listMotion.ts: reduced motion means the end
 * state at once, only events start anything, and React keeps owning the DOM —
 * what fades out is a picture, what slides is a transform that ends where
 * React put the node.
 */
import { centreOf, fx, motionOff, type Point } from "../../lib/fx";
import { EASE_OUT, pictureOf } from "../../lib/listMotion";

/** Where the groups, their lists and the stage sit before a change. */
export interface Layout {
  /** `[data-row]` (each group, the stage) → top, relative to the split. */
  tops: Map<string, number>;
  /** `[data-list]` (each group's list) → top, relative to its own group. */
  lists: Map<string, number>;
}

export function layoutOf(split: HTMLElement | null): Layout {
  const tops = new Map<string, number>();
  const lists = new Map<string, number>();
  if (split === null) return { tops, lists };
  const top = split.getBoundingClientRect().top;
  for (const el of split.querySelectorAll<HTMLElement>("[data-row]")) {
    tops.set(el.dataset.row ?? "", el.getBoundingClientRect().top - top);
  }
  for (const el of split.querySelectorAll<HTMLElement>("[data-list]")) {
    const group = el.closest<HTMLElement>("[data-row]");
    if (group === null) continue;
    lists.set(el.dataset.list ?? "", el.getBoundingClientRect().top - group.getBoundingClientRect().top);
  }
  return { tops, lists };
}

/**
 * Everything that moved since `before` plays from where it was (FLIP). A
 * group's list is moved by its offset *within* the group, since the group's
 * own slide already carries it the rest of the way.
 */
export function settleLayout(split: HTMLElement | null, before: Layout, duration = 320): void {
  if (split === null || motionOff()) return;
  const now = layoutOf(split);
  const play = (el: Element, dy: number) => {
    if (Math.abs(dy) < 1) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], {
      duration,
      easing: EASE_OUT,
    });
  };
  for (const el of split.querySelectorAll<HTMLElement>("[data-row]")) {
    const id = el.dataset.row ?? "";
    const was = before.tops.get(id);
    const is = now.tops.get(id);
    if (was !== undefined && is !== undefined) play(el, was - is);
  }
  for (const el of split.querySelectorAll<HTMLElement>("[data-list]")) {
    const id = el.dataset.list ?? "";
    const was = before.lists.get(id);
    const is = now.lists.get(id);
    if (was !== undefined && is !== undefined) play(el, was - is);
  }
}

/**
 * C290: the launch row that is going away leaves a picture where it stood,
 * which fades and lifts a little. Call it *before* React drops the row.
 */
export function fadeOutPicture(el: HTMLElement | null, duration = 140): void {
  if (el === null || motionOff()) return;
  const r = el.getBoundingClientRect();
  if (r.width === 0) return;
  const pic = pictureOf(el);
  Object.assign(pic.style, {
    position: "fixed",
    left: `${r.left}px`,
    top: `${r.top}px`,
    height: `${r.height}px`,
    margin: "0",
    zIndex: "3",
    pointerEvents: "none",
  });
  document.body.appendChild(pic);
  pic
    .animate(
      [
        { opacity: 1, transform: "none" },
        { opacity: 0, transform: "translateY(-4px)" },
      ],
      { duration, easing: "ease-in", fill: "forwards" },
    )
    .finished.then(
      () => pic.remove(),
      () => pic.remove(),
    );
}

/** What a launch's light needs from the hub. */
export interface HubTarget {
  orb: () => HTMLElement | null;
  chip: (id: string) => HTMLElement | null;
  pulse: (you?: boolean) => void;
  flash: (id: string, you?: boolean) => void;
}

/**
 * C293 / C224: light runs from the button that was pressed into the hub, the
 * hub's ring spreads once, and the light is thrown out to where the new
 * session's chip now circles; the chip shows (`reveal`) as the light lands.
 * The ring is violet in both — amber means "waiting on you" (spec 40 asks for
 * this over the prototype's amber in C224).
 *
 * `reveal` always runs, motion or not: it is what un-hides the chip.
 */
export function launchLight(from: Point | null, hub: HubTarget | null, id: string, reveal: () => void) {
  if (motionOff() || hub === null) {
    reveal();
    return;
  }
  const orb = centreOf(hub.orb());
  fx.beam(from, orb, { dur: 480, bend: -0.2, width: 2.6 });
  window.setTimeout(() => {
    hub.pulse(false);
    const chip = hub.chip(id);
    fx.beam(centreOf(hub.orb()), centreOf(chip), { dur: 420, bend: 0.3, width: 2.4 });
  }, 440);
  window.setTimeout(() => {
    reveal();
    // Once React has shown it, the chip fades in (320) and lights its edge.
    // WAAPI, because the orbit loop writes the chip's inline opacity every
    // frame and an animation is what outranks an inline style.
    requestAnimationFrame(() => {
      hub.chip(id)?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out" });
      hub.flash(id);
    });
  }, 820);
}
