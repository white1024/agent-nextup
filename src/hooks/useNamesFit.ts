import { useLayoutEffect, useState, type RefObject } from "react";

let canvas: HTMLCanvasElement | null = null;

function textWidth(text: string, font: string): number {
  canvas ??= document.createElement("canvas");
  const g = canvas.getContext("2d");
  if (g === null) return 0;
  g.font = font;
  return g.measureText(text).width;
}

const px = (v: string) => parseFloat(v) || 0;

/**
 * Whether a phase band can show every phase's name whole (my-design review
 * F17; D158 ③ — a phase name is never cut). The band lays its cells out by
 * their names (`flex: 1 1 auto`), so the names fit exactly when their widths,
 * plus each cell's padding and the gaps, fit the band. When they do not, the
 * band shows sequence numbers instead and keeps the names in its label and
 * each cell's tooltip — a number is honest about being a number, where
 * "Implem" pretends to be a name.
 *
 * Measured with a canvas in the cell's own font (so it does not depend on
 * which mode is showing), on mount, whenever the band is resized, and once
 * the bundled fonts have loaded.
 *
 * `textSel` picks the element holding a cell's text; `cellSel` the cell.
 */
export function useNamesFit(
  band: RefObject<HTMLElement | null>,
  names: string[],
  cellSel: string,
  textSel: string,
): boolean {
  const [fits, setFits] = useState(true);
  const key = names.join("\u0000");

  useLayoutEffect(() => {
    const el = band.current;
    if (el === null || names.length === 0) return;
    const measure = () => {
      const cell = el.querySelector<HTMLElement>(cellSel);
      const text = el.querySelector<HTMLElement>(textSel) ?? cell;
      if (cell === null || text === null) return;
      const cs = getComputedStyle(cell);
      const ts = getComputedStyle(text);
      const font = `${ts.fontStyle} ${ts.fontWeight} ${ts.fontSize} ${ts.fontFamily}`;
      const pad = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
      const bs = getComputedStyle(el);
      const gap = px(bs.columnGap);
      const room = el.clientWidth - px(bs.paddingLeft) - px(bs.paddingRight);
      // +1 per name: canvas widths are fractional and the layout rounds.
      const need = names.reduce((sum, n) => sum + Math.ceil(textWidth(n, font)) + 1 + pad, 0) + gap * (names.length - 1);
      setFits(need <= room);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
    // `key` stands for `names`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, cellSel, textSel]);

  return fits;
}
