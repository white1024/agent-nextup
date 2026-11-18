/**
 * Whole-page transitions for the D153 design: the project-switch wipe (C221)
 * and the grow-from-source page change (C13 / C23 / C27).
 *
 * Both work on a **picture** of the old page, never on the old page itself.
 * The prototype moved the live DOM into an overlay; React owns that DOM, and a
 * node moved out from under it is a node React can no longer find. So the old
 * page is cloned into an inert overlay, React renders the new page underneath
 * exactly as it would without any transition, and the overlay animates away.
 * Nothing here changes *where* navigation lands (invariant 19) or waits for
 * data (invariant 10): the new page is whatever it is when the overlay leaves —
 * loading, empty or full.
 *
 * DOM and the Web Animations API only (D154 R1); no React (lib/ rule).
 */

import { motionOff } from "./fx";

/** Clones `el` into a fixed, inert overlay that covers its current box. */
function pictureOf(el: HTMLElement): { host: HTMLDivElement; clone: HTMLElement; rect: DOMRect } {
  const rect = el.getBoundingClientRect();
  const host = document.createElement("div");
  host.className = "pt-picture";
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  Object.assign(host.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const clone = el.cloneNode(true) as HTMLElement;
  clone.removeAttribute("id");
  clone.classList.add("pt-clone");
  Object.assign(clone.style, { width: `${rect.width}px`, height: `${rect.height}px` });
  host.appendChild(clone);
  document.body.appendChild(host);
  // Scroll offsets are live state, not attributes: carry them over or the
  // picture jumps back to the top for the length of the effect.
  clone.scrollTop = el.scrollTop;
  clone.scrollLeft = el.scrollLeft;
  return { host, clone, rect };
}

/** Waits for React to commit what `swap` set in motion. */
const afterCommit = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** Is `r` a box worth growing from or shrinking into (on screen, not empty)? */
function onScreen(r: DOMRect | undefined): r is DOMRect {
  return r !== undefined && r.width > 4 && r.height > 4 && r.bottom > 0 && r.top < window.innerHeight;
}

/** `r` clipped to the content area's visible part (a page taller than the window). */
function clipToMain(r: DOMRect): DOMRect {
  const m = document.querySelector("main.content")?.getBoundingClientRect();
  if (m === undefined) return r;
  const top = Math.max(r.top, m.top);
  const bottom = Math.min(r.bottom, m.bottom);
  return new DOMRect(r.left, top, r.width, Math.max(0, bottom - top));
}

export interface GrowSpec {
  /** The thing in the old page that opens (a project card, the task overview);
   *  unused when closing. */
  from: Element | null;
  /** Where it lands in the new page — the detail when opening, the card when
   *  closing — looked up after the new page has rendered. */
  to: () => Element | null;
  /** The frame's look: a card, a panel, or the terminal's dark (C27). */
  look?: "card" | "panel" | "term";
  /** How far the frame floats forward while it grows (C13 3%, others 1.2%). */
  lift?: number;
  /** Closing back into `from` instead of opening out of it. */
  back?: boolean;
}

/**
 * C13 / C23 / C27 (spec 10, page transitions): content opening into its own detail.
 *
 * Opening: the old page (sidebar included) is pictured under a dimming veil; a
 * frame grows from the source to its counterpart in the new page — clipped to
 * what is visible of it — floats forward a little and settles; then the veil
 * lifts and the new page's first blocks rise into place. Closing runs it
 * backwards: the old page fades where it stands and the frame shrinks into the
 * card it came from, which only shows once the frame arrives.
 *
 * Navigation itself is untouched: `swap` is the same state change as without
 * a transition, so where it lands is still `applyStatus`' decision
 * (invariant 19), and the frame lands on whatever the new page is showing at
 * that moment, loading state included (invariant 10). When either end is off
 * screen there is no frame — the old page fades and the new one rises.
 */
export async function growTo(spec: GrowSpec, swap: () => void) {
  const shell = document.querySelector<HTMLElement>(".shell");
  if (motionOff() || shell === null) {
    swap();
    return;
  }
  const back = spec.back === true;
  const D = back ? 420 : 440;
  const lift = spec.lift ?? 0.012;
  const fromBox = back ? undefined : spec.from?.getBoundingClientRect();
  const mainBox = document.querySelector("main.content")?.getBoundingClientRect();

  // The veil: picture of the old shell, a scrim, and (later) the frame.
  const veil = document.createElement("div");
  veil.className = `pt-veil${back ? " pt-veil--back" : ""}`;
  veil.setAttribute("aria-hidden", "true");
  veil.inert = true;
  const pic = shell.cloneNode(true) as HTMLElement;
  pic.classList.add("pt-old");
  const scrim = document.createElement("div");
  scrim.className = "pt-scrim";
  veil.append(back ? scrim : pic, back ? pic : scrim);
  document.body.appendChild(veil);
  for (const el of [...pic.querySelectorAll<HTMLElement>("main.content, .sidebar-scroll")]) {
    const live = shell.querySelector<HTMLElement>(
      el.matches("main.content") ? "main.content" : ".sidebar-scroll",
    );
    if (live !== null) el.scrollTop = live.scrollTop;
  }

  swap();
  await afterCommit();

  const toEl = spec.to();
  const target = toEl?.getBoundingClientRect();
  const start = back ? mainBox : fromBox;
  const end = back ? target : target === undefined ? undefined : clipToMain(target);
  const done = () => veil.remove();

  if (!onScreen(start) || !onScreen(end)) {
    // No frame: the old page fades, the new one rises in.
    pic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" });
    scrim.style.opacity = "0";
    riseIn(back ? null : toEl);
    window.setTimeout(done, 220);
    return;
  }

  const frame = document.createElement("div");
  frame.className = `pt-frame pt-frame--${spec.look ?? "card"}`;
  const box = (r: DOMRect) => ({
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  });
  Object.assign(frame.style, box(start));
  veil.appendChild(frame);

  if (!back) {
    // The source's own picture, fading at its own size inside the frame — the
    // words must not be stretched with the box.
    const src = spec.from?.cloneNode(true) as HTMLElement | undefined;
    if (src !== undefined) {
      src.classList.add("pt-frame-clone");
      Object.assign(src.style, { width: `${start.width}px`, height: `${start.height}px` });
      frame.appendChild(src);
      src.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 170, easing: "ease-out", fill: "forwards" });
    }
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, easing: "ease-out", fill: "forwards" });
    pic.animate([{ opacity: 1 }, { opacity: 0 }], {
      duration: 160,
      delay: D - 240,
      easing: "ease-in-out",
      fill: "forwards",
    });
    frame.animate([box(start), box(end)], {
      duration: D,
      easing: "cubic-bezier(.25,.8,.25,1)",
      fill: "forwards",
    });
    frame.animate(
      [
        { transform: "scale(1)", offset: 0 },
        { transform: "scale(1)", offset: 180 / D },
        { transform: `scale(${1 + lift})`, offset: 0.7 },
        { transform: "scale(1)", offset: 1 },
      ],
      { duration: D, fill: "forwards" },
    );
    window.setTimeout(() => {
      veil.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: "ease-out", fill: "forwards" })
        .finished.then(done, done);
      riseIn(toEl);
    }, D - 90);
    return;
  }

  // Back: the old page fades where it stands, the frame shrinks into the card,
  // and the card only shows once the frame is there.
  const card = toEl instanceof HTMLElement ? toEl : null;
  if (card !== null) card.style.visibility = "hidden";
  pic.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 150, easing: "ease-in", fill: "forwards" });
  frame.animate([box(start), box(end)], {
    duration: D,
    delay: 60,
    easing: "cubic-bezier(.4,0,.2,1)",
    fill: "both",
  });
  scrim.animate([{ opacity: 1 }, { opacity: 0 }], { duration: D + 60, delay: 40, fill: "forwards" });
  window.setTimeout(() => {
    if (card !== null) card.style.visibility = "";
    frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: "forwards" }).finished.then(done, done);
  }, D - 40);
}

/**
 * A project's card on the overview, by its root — where C13 lands when the way
 * out of a project is folded back (the sidebar's "All projects", closing the
 * workspace from its settings).
 */
export function projectCard(root: string | null | undefined): Element | null {
  if (root == null) return null;
  return document.querySelector(`.ws-card-open[data-root="${CSS.escape(root)}"]`)?.closest(".ws-card") ?? null;
}

/** The new page's first blocks float up into place, one after another. */
function riseIn(target: Element | null | undefined) {
  const page = target?.closest(".view") ?? document.querySelector("main.content .view");
  if (!page) return;
  [...page.children].slice(0, 6).forEach((el, i) =>
    (el as HTMLElement).animate(
      [
        { opacity: 0, transform: "translateY(8px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 280, delay: 20 + i * 40, easing: "cubic-bezier(.16,1,.3,1)", fill: "backwards" },
    ),
  );
}

/**
 * C221: switching projects. The old page is pictured over the content area,
 * the caller swaps the project in underneath, and the picture is wiped away
 * from the top edge downwards with a band of light following the edge.
 *
 * Call it right before the state change that swaps the page; `swap` runs
 * synchronously once the picture is in place, so the new page renders under
 * it. Reduced motion: just `swap`.
 */
export function switchVeil(main: HTMLElement | null, swap: () => void) {
  if (main === null || motionOff()) {
    swap();
    return;
  }
  const { host, clone, rect } = pictureOf(main);
  // The band of light rides the wipe's edge. It lives in its own clipped box
  // over the same area — inside the picture it would travel twice as far,
  // since the picture itself is moving.
  const band = document.createElement("div");
  band.className = "pt-picture pt-band-box";
  band.setAttribute("aria-hidden", "true");
  Object.assign(band.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
  const scan = document.createElement("span");
  scan.className = "pt-scan";
  band.appendChild(scan);
  document.body.appendChild(band);
  swap();

  const h = rect.height;
  const opts: KeyframeAnimationOptions = {
    duration: 860,
    delay: 120,
    easing: "cubic-bezier(.5,0,.3,1)",
    fill: "both",
  };
  // Outer down, inner up by the same amount: the old page stays put on screen
  // while its top edge slides down — it reads as being wiped off from above.
  const outer = host.animate([{ transform: "translateY(0)" }, { transform: `translateY(${h}px)` }], opts);
  clone.animate([{ transform: "translateY(0)" }, { transform: `translateY(${-h}px)` }], opts);
  scan.animate(
    [
      { transform: "translateY(-100%)", opacity: 0 },
      { opacity: 1, offset: 0.08 },
      { opacity: 1, offset: 0.85 },
      { transform: `translateY(${h - 120}px)`, opacity: 0 },
    ],
    opts,
  );
  const done = () => {
    host.remove();
    band.remove();
  };
  outer.finished.then(done, done);
}

// ── C173: the denial's amber mark outlives its toast ──────────────────────
//
// "Go authorize" closes the toast and changes page, but the amber circle that
// said "waiting on you" stays where it was, over the transition, until the
// tools page has its data and can fly it to the switch. It is parked here
// because the two ends never share a component; a mark nobody picks up goes
// away on its own.

let parked: { el: HTMLElement; t: number } | null = null;

/** Leaves an amber circle at `at` for the tools page to take (C173). */
export function parkMark(at: { x: number; y: number } | null) {
  parked?.el.remove();
  parked = null;
  if (at === null || motionOff()) return;
  const el = document.createElement("i");
  el.className = "tls-mkfly";
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { left: `${at.x - 7}px`, top: `${at.y - 7}px` });
  document.body.appendChild(el);
  const mine = { el, t: performance.now() };
  parked = mine;
  window.setTimeout(() => {
    if (parked !== mine) return;
    parked = null;
    el.remove();
  }, 6000);
}

/** Takes the parked circle, if there is one. Once. */
export function takeMark(): HTMLElement | null {
  const p = parked;
  parked = null;
  return p !== null && p.el.isConnected ? p.el : null;
}
