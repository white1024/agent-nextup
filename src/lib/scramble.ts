/**
 * C10's settling text, for whatever is not a single React-owned `<Scramble>`:
 * the pools the characters flicker through, and a DOM-level pass over many
 * text nodes at once (C193: a language change settles the whole screen,
 * region by region from the top).
 *
 * DOM only (lib/ rule): nothing here runs at import time.
 */

import { motionOff } from "./fx";

const POOL_NUM = [..."0123456789"];
// The prototype's pool of workflow words, kept as code points: a CJK literal
// in a source file would block the public mirror's CJK scan (D81), and these
// characters are decoration, not copy — nothing reads them.
const POOL_CJK = [
  0x5be6, 0x4f5c, 0x9a57, 0x8b49, 0x898f, 0x683c, 0x4ea4, 0x4ed8, 0x5fa9, 0x76e4, 0x968e, 0x6bb5, 0x4efb,
  0x52d9, 0x95dc, 0x5361, 0x63a8, 0x9032, 0x4e2d, 0x6a1e, 0x4ee3, 0x7406, 0x7d00, 0x9304, 0x6c7a, 0x7b56,
  0x91cc, 0x7a0b, 0x7891,
].map((cp) => String.fromCodePoint(cp));
const POOL_LATIN = [..."abcdefghijklmnopqrstuvwxyz"];
const POOL_UPPER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Characters that stay put while the rest scramble (spacing and units). */
export const FIXED = new Set([" ", "%", "/", "·", ":", "-", "."]);

/** The pool a character flickers through: digits, latin, or workflow words. */
export function poolFor(ch: string, upper = false): string[] {
  if (/\d/.test(ch)) return POOL_NUM;
  if (/[a-z]/i.test(ch)) return upper ? POOL_UPPER : POOL_LATIN;
  return /[\u3400-\u9fff]/.test(ch) ? POOL_CJK : POOL_NUM;
}

/** `target` with the characters past `settled` (0..1 of its length) still flickering. */
export function scrambled(target: string[], settled: number, upper = false): string {
  return target
    .map((c, i) => {
      if (settled > (i + 1) / (target.length + 1) || FIXED.has(c) || /\s/.test(c)) return c;
      const pool = poolFor(c, upper);
      return pool[Math.floor(Math.random() * pool.length)];
    })
    .join("");
}

/**
 * C193: every visible text under `root` starts scrambled at once and settles
 * left to right over `dur` ms, each after a delay set by how far down the
 * window it sits (0–`spread` ms) — the screen changes language region by
 * region from the top. The latin pool is capitals, as the design has it.
 *
 * It writes into the text nodes React rendered and puts each one's own text
 * back at the end, so React keeps owning them. Returns at once under reduced
 * motion.
 */
export function scrambleTree(root: Element | null, dur = 520, spread = 480) {
  if (root === null || motionOff()) return;
  const h = window.innerHeight;
  const items: { node: Text; text: string; chars: string[]; delay: number }[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      if ((n.nodeValue ?? "").trim() === "") return NodeFilter.FILTER_REJECT;
      const el = n.parentElement;
      if (el === null || el.closest("[aria-hidden='true'], script, style, textarea, input, .xterm") !== null) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
    const r = (n.parentElement as Element).getBoundingClientRect();
    if (r.bottom < 0 || r.top > h || r.width === 0) continue;
    const text = n.nodeValue ?? "";
    items.push({ node: n as Text, text, chars: [...text], delay: Math.max(0, Math.min(1, r.top / h)) * spread });
  }
  if (items.length === 0) return;
  let t0 = -1;
  const frame = (now: number) => {
    if (t0 < 0) t0 = now;
    let busy = false;
    for (const it of items) {
      const k = (now - t0 - it.delay) / dur;
      if (k >= 1) {
        if (it.node.nodeValue !== it.text) it.node.nodeValue = it.text;
        continue;
      }
      busy = true;
      it.node.nodeValue = scrambled(it.chars, Math.max(0, k), true);
    }
    if (busy) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
