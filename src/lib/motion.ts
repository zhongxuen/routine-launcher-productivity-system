/**
 * The two things about motion that JavaScript has to know.
 *
 * Almost all of the animation in this app is CSS — `index.css` owns the
 * keyframes, the durations and the reduced-motion switch, and components ask
 * for them by class name. That is on purpose: an animation the compositor can
 * run on its own does not compete with a SQLite read or a routine launch for
 * the main thread.
 *
 * Two cases cannot be done that way, and they are the reason this file exists.
 *
 * The first is an *exit* animation. An element that has been removed from
 * React's tree is not on screen to be animated, so something has to keep it
 * mounted for exactly as long as its animation runs and then let it go. That
 * "exactly as long" is a number in a stylesheet, and this is where the two
 * copies are reconciled — see {@link ROW_LEAVE_MS}.
 *
 * The second is knowing whether motion is wanted at all. The CSS rule in
 * `index.css` shortens animations to nothing, but a timer set from JavaScript
 * is not an animation and does not hear about it; a list that held its rows
 * for 180ms regardless would feel broken to someone who turned animations
 * off. {@link reducedMotion} is how that timer finds out.
 */

/**
 * How long `--animate-row-leave` runs, in milliseconds.
 *
 * Must equal `--duration-base` in `index.css`. The pair is checked by
 * {@link assertMotionDurationsMatch} in development, because the failure when
 * they drift is quiet and unpleasant in both directions: too short and rows
 * disappear mid-fade, too long and a completed task sits in a list it has
 * already left.
 */
export const ROW_LEAVE_MS = 180;

/**
 * Whether the user has asked for less motion, from either of the two places
 * that can say so.
 *
 * The in-app setting wins when it has an opinion, which is what
 * `motionStore` writes to `<html>`; otherwise the OS is asked. Reading the
 * class rather than the store keeps this callable from modules that have no
 * business importing a store — and keeps it truthful in the popup, launcher
 * and widget windows, which apply the class at startup the same way.
 */
export function reducedMotion(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("reduce-motion");
}

/**
 * The duration to actually wait for `animation`, honouring the preference.
 *
 * Zero rather than the 1ms the stylesheet uses: nothing here is waiting on an
 * event that has to fire, only on time passing, and a caller that gets 0 can
 * skip scheduling a timer at all.
 */
export function motionDuration(ms: number): number {
  return reducedMotion() ? 0 : ms;
}

/**
 * Fails loudly in development if {@link ROW_LEAVE_MS} and `--duration-base`
 * have drifted apart.
 *
 * Called once from `initMotion`. There is no way to import a custom property
 * into TypeScript, so the duplication is unavoidable; what is avoidable is
 * finding out about it from a bug report about rows vanishing early.
 */
export function assertMotionDurationsMatch(): void {
  if (!import.meta.env.DEV || typeof window === "undefined") return;

  const declared = getComputedStyle(document.documentElement)
    .getPropertyValue("--duration-base")
    .trim();
  if (!declared) return;

  const ms = declared.endsWith("ms")
    ? Number.parseFloat(declared)
    : Number.parseFloat(declared) * 1000;

  if (Number.isFinite(ms) && ms !== ROW_LEAVE_MS) {
    console.error(
      `Motion durations have drifted: --duration-base is ${declared} but ` +
        `ROW_LEAVE_MS in lib/motion.ts is ${ROW_LEAVE_MS}ms. List rows will ` +
        `be unmounted at the wrong moment. Change both.`,
    );
  }
}
