import { useEffect, useState } from "react";

/**
 * How often the clock is re-read. This is a desktop window that stays open for
 * hours, so anything read from the clock once at mount goes stale: the
 * dashboard's "Good afternoon" would still say afternoon at midnight, and
 * PLAN TODAY's time left would stop counting down. A minute is finer than any
 * of them needs and costs one render a minute.
 */
const CLOCK_TICK_MS = 60_000;

/** The current time, re-read every minute. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return now;
}
