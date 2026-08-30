/**
 * The two questions a window-level key handler has to be able to answer
 * (development-plan.md section 84).
 *
 * The app binds two shortcuts on `window`: `Ctrl+N` on the Tasks page
 * (section 16) and `Escape` in the compact popup (section 25). Both are bound
 * there deliberately — they should work whatever has focus — and both are
 * therefore capable of firing over the top of something the user is already
 * in the middle of. This file is what stops that.
 *
 * There is no `useHotkey` hook here on purpose. Two shortcuts do not need an
 * abstraction; what they need is one shared answer to "is something else
 * already listening?", so the two do not drift apart.
 */

/**
 * Anything Radix has portalled on top of the page: a dialog, an alert dialog,
 * a dropdown, a select, a popover, a tooltip.
 *
 * Poppers land in a `[data-radix-popper-content-wrapper]`; dialogs render with
 * a `role` instead. Matching on what Radix *renders* rather than on a state
 * flag it keeps internally is the part that will not rot: these are the
 * attributes assistive technology reads, so they are the ones Radix cannot
 * quietly change.
 *
 * Note the timing this relies on, which is a feature rather than an accident.
 * Radix dismisses a layer from a capture-phase listener on `document`, and
 * without marking the event as handled — so a window-level Escape runs
 * afterwards, on a DOM where React has not yet removed the layer. The layer is
 * therefore still findable, and the press is correctly spent closing it. The
 * next press finds nothing and reaches the window.
 */
const OVERLAY_SELECTOR = [
  "[data-radix-popper-content-wrapper]",
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
].join(", ");

/** Whether a dialog, menu or popover is currently on top of the page. */
export function hasOpenOverlay(): boolean {
  return document.querySelector(OVERLAY_SELECTOR) !== null;
}

/**
 * Whether the keystroke landed in something the user is typing into.
 *
 * For shortcuts that are a plain-ish chord — `Ctrl+N` is one — because the
 * browser's own text editing has first claim on the field. Not needed for
 * Escape, which means "back out" everywhere including inside a field.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}
