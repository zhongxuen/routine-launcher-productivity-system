/**
 * How many rows of a list actually fit, and how many are left over.
 *
 * The rule prompt 12.2 works to is that the widget truncates rather than
 * grows: a window the user parked in the corner of their screen must not
 * decide for itself that today needs nine lines. Every other list in the app
 * scrolls; this one cannot, because a scrollbar in a 300px window is a
 * control you have to aim at on a surface meant to be read at a glance.
 *
 * Measuring rather than picking a number is what keeps that honest at both
 * ends. The widget is resizable between 220x140 and 560x720 (see
 * `services/widget.rs`), so a constant would either overflow the smallest
 * window or waste most of the tallest one. A `ResizeObserver` on the list's
 * own box asks the layout the question instead — which also answers it for
 * free when the *content* around the list changes height, as the combined
 * mode's focus section does when a session starts.
 *
 * The rows have to be a fixed height for this to be arithmetic rather than
 * guesswork, which is why the callers give one and their rows are sized to
 * match it.
 */

import { useEffect, useRef, useState } from "react";

interface FittedRows<T extends HTMLElement> {
  /** Put this on the box the rows live in. It must be the one that is clipped. */
  ref: React.RefObject<T | null>;
  /** How many rows to draw. */
  visible: number;
  /** How many were left out — zero when the whole list fits. */
  hidden: number;
}

/**
 * @param total      How many rows there are to draw.
 * @param rowHeight  The height of one row, in CSS pixels.
 * @param minimum    Rows to draw even if they do not fit. One, normally: a
 *                   list showing nothing at all reads as an empty day rather
 *                   than as a window too short to say.
 */
export function useFittedRows<T extends HTMLElement = HTMLDivElement>(
  total: number,
  rowHeight: number,
  minimum = 1,
): FittedRows<T> {
  const ref = useRef<T | null>(null);

  /**
   * Null until the box has been measured. The first render draws the whole
   * list and lets the box clip it, which is wrong for one frame — but it is
   * wrong by showing too much rather than by showing nothing, and a list that
   * flashed empty on every mount would be the more noticeable of the two.
   */
  const [capacity, setCapacity] = useState<number | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => setCapacity(Math.floor(element.clientHeight / rowHeight));
    measure();

    // Guarded because the modes are rendered outside a browser in the
    // verification pass; a widget that could not observe its own size still
    // draws, it just stops adapting to a resize.
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [rowHeight]);

  const visible = rowsThatFit(total, capacity, minimum);
  return { ref, visible, hidden: Math.max(0, total - visible) };
}

/**
 * How many of `total` rows to draw in a box that holds `capacity` of them.
 *
 * Split out from the hook because it is the whole of the truncation rule and
 * the only part of it that can be checked without a layout engine.
 *
 * @param capacity How many rows the box measured out at, or null before it
 *                 has been measured — in which case the whole list is drawn
 *                 and the box clips it for a frame.
 */
export function rowsThatFit(
  total: number,
  capacity: number | null,
  minimum: number,
): number {
  const fits = Math.max(minimum, capacity ?? total);

  // One row is given up to say what is missing, but only when something is:
  // a list that fits exactly should not lose its last line to a "+0 more".
  return fits >= total ? total : Math.max(minimum, fits - 1);
}
