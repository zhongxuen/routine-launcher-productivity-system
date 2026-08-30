/**
 * The last arrow of development-plan.md section 94: *daily progress updates*.
 *
 * ```text
 * Task is completed  ──progressChanged──▶  level, XP, streak, achievements
 * ```
 *
 * The backend awards XP as a side effect of the work itself — completing a
 * task, ending a focus session and launching the day's first routine each
 * write their own ledger row inside the service that did the thing (section
 * 50: the gamification is a footnote to the productivity, never a step the
 * caller has to remember). Which means the numbers on screen go stale without
 * anything having told the screen so.
 *
 * `progressStore` only re-read on mount, so the Progress widget picked up XP
 * when the user *arrived* at the dashboard and not when they earned it there.
 * Ticking off a task in Today's Tasks left the card beside it showing the old
 * level, the old streak and the old total until the user navigated away and
 * back — which is precisely the loop section 94 asks to close, failing to
 * close in the one place the whole loop is visible at once.
 *
 * This is the same shape as `focus-events.ts` and for the same reason: an
 * announcement rather than one store reaching into another. The three stores
 * that cause XP to be written say that something was earned; they do not know
 * or care that a progress store exists. `useProgressSync` is the subscriber.
 *
 * Nothing travels with the announcement. The award is the backend's — the
 * amount, the level curve, the streak rule and any achievement it unlocked
 * are all decided there (see `services/xp.rs`) — so the only correct response
 * is to ask again, never to add something up locally.
 */

type ProgressChangedHandler = () => void;

const handlers = new Set<ProgressChangedHandler>();

/**
 * Subscribes to work that may have earned XP. Returns the unsubscribe
 * function, so it can be returned straight out of a `useEffect`.
 */
export function onProgressChanged(handler: ProgressChangedHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

/**
 * Announces that something worth XP has been recorded.
 *
 * Emitted after the write has landed, never before: a subscriber's whole
 * response is to re-read, and a re-read that raced the write would report the
 * figures it was called to replace.
 *
 * Deliberately fired for *may have earned* rather than *did earn*. The caller
 * cannot know — the awards are capped (once per task, once per session, once
 * a day for launches, section 88), so most of these announcements find
 * nothing new. A re-read that changes nothing costs one query; a missed one
 * shows the user the wrong number until they navigate away, and there is no
 * event that would correct it.
 *
 * A throwing subscriber is logged and skipped rather than allowed to stop the
 * others, exactly as in `focus-events.ts`.
 */
export function emitProgressChanged(): void {
  for (const handler of handlers) {
    try {
      handler();
    } catch (cause) {
      console.error("A progress subscriber threw:", cause);
    }
  }
}
