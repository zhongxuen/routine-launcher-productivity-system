/**
 * The day Tasks > Today is showing, held in the URL as `?date=YYYY-MM-DD`
 * (development-plan.md section 53's Yesterday / Today / Tomorrow).
 *
 * The URL rather than the store, so a reload keeps the day and Back steps
 * through the days already visited. Every move pushes a history entry, and
 * that is what Back walks through.
 *
 * No param means today, and so does a param naming today: both come back as
 * `date: null`, the plain carry-over Today view, exactly as it was before
 * this existed. Moving back onto today drops the param rather than writing
 * today's key, so `/tasks/today` stays the one address for today. A param
 * that is not a real date is ignored rather than reported: it can only come
 * from a hand-edited address, and today is the right page for that.
 */

import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { addDays, format } from "date-fns";

import { parseDateKey, todayKey } from "@/lib/task-utils";

const DATE_PARAM = "date";
const DATE_KEY_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export interface DayParam {
  /** The day being shown, or null for today. */
  date: string | null;
  /** The day being shown, as a key. Today's key when `date` is null. */
  dayKey: string;
  /** Step by `days` (negative for earlier). */
  step: (days: number) => void;
  /** Back to today, dropping the param. */
  goToToday: () => void;
}

/** `raw` if it is a real `YYYY-MM-DD` date other than today, otherwise null. */
function readDate(raw: string | null, today: string): string | null {
  if (raw === null || raw === today || !DATE_KEY_SHAPE.test(raw)) return null;
  // `parseISO` refuses 2026-02-31, so a date that parses is a real one.
  return parseDateKey(raw) ? raw : null;
}

export function useDayParam(): DayParam {
  const [params, setParams] = useSearchParams();
  const today = todayKey();
  const date = readDate(params.get(DATE_PARAM), today);
  const dayKey = date ?? today;

  const goTo = useCallback(
    (key: string) => {
      setParams((current) => {
        const next = new URLSearchParams(current);
        if (key === todayKey()) next.delete(DATE_PARAM);
        else next.set(DATE_PARAM, key);
        return next;
      });
    },
    [setParams],
  );

  const step = useCallback(
    (days: number) => {
      const from = parseDateKey(dayKey);
      if (from) goTo(format(addDays(from, days), "yyyy-MM-dd"));
    },
    [dayKey, goTo],
  );

  const goToToday = useCallback(() => goTo(todayKey()), [goTo]);

  return { date, dayKey, step, goToToday };
}
