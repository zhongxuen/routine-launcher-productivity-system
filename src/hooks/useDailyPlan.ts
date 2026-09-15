/**
 * One day's top priorities (PLAN TODAY, sections 20 and 51), read into the
 * component that asks for them.
 *
 * Local state rather than a store: the priorities are drawn in one place,
 * Tasks > Today, by the panel and by the list under it, and that page is the
 * only thing that changes them. No other window shows them, so a save
 * announces nothing (`window-sync.ts`).
 *
 * Saves are optimistic. Moving a task up twice in quick succession has to
 * move it two places, so the second click has to see the first one's result
 * before the backend has answered. A refused save puts back the list the
 * backend last confirmed.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { getDailyPlan, setDailyPlan } from "@/services/dailyPlanService";

export interface DailyPlanState {
  /** The picked task ids, rank 1 first. Empty until the read lands. */
  taskIds: number[];
  /** Whether `taskIds` has come from the backend for this day yet. */
  hasLoaded: boolean;
  /** A failed read, in user-presentable form. */
  error: string | null;
  reload: () => void;
  /**
   * Stores `ids` as the day's priorities, showing them at once. A refusal is
   * toasted and the last stored list comes back. Resolves to whether it was
   * saved.
   */
  save: (ids: number[]) => Promise<boolean>;
}

/** @param date The `YYYY-MM-DD` to read, or null to read nothing. */
export function useDailyPlan(date: string | null): DailyPlanState {
  const [taskIds, setTaskIds] = useState<number[]>([]);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // The day on screen, for answers that land after it has changed.
  const current = useRef(date);
  current.current = date;
  // What the backend last said the day holds: what a refused save goes back to.
  const confirmed = useRef<number[]>([]);
  // Only the newest save's answer is written back, so an earlier one landing
  // late cannot undo a later click.
  const latestSave = useRef(0);

  useEffect(() => {
    if (date === null) return;
    let cancelled = false;

    getDailyPlan(date)
      .then((plan) => {
        if (cancelled) return;
        confirmed.current = plan.taskIds;
        setTaskIds(plan.taskIds);
        setLoadedFor(date);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause));
      });

    return () => {
      cancelled = true;
    };
  }, [date, attempt]);

  const save = useCallback(
    async (ids: number[]) => {
      if (date === null) return false;

      const ticket = ++latestSave.current;
      const isNewest = () => ticket === latestSave.current && current.current === date;
      setTaskIds(ids);

      try {
        const plan = await setDailyPlan(date, ids);
        confirmed.current = plan.taskIds;
        if (isNewest()) setTaskIds(plan.taskIds);
        return true;
      } catch (cause) {
        if (isNewest()) setTaskIds(confirmed.current);
        toast.error("Could not save today's priorities", { description: String(cause) });
        return false;
      }
    },
    [date],
  );

  const hasLoaded = date !== null && loadedFor === date;

  return {
    // Another day's picks are not this day's, even for the frame before the
    // new read lands.
    taskIds: hasLoaded ? taskIds : [],
    hasLoaded,
    error,
    reload: () => setAttempt((count) => count + 1),
    save,
  };
}
