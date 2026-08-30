/**
 * Quest store — today's objectives (development-plan.md section 44), and the
 * XP they pay out when they are finished.
 *
 * Two halves, and only one of them is gamification:
 *
 * 1. **What the user did today.** Counted from the systems that already
 *    record it — completed tasks (Stage 1), finished focus sessions (Stage 4),
 *    launched routines (Stage 2). No Stage 9 table is involved, which is why
 *    the checklist is honest before the XP backend exists: a tick beside
 *    "Complete 3 tasks" means three tasks are actually done.
 * 2. **The reward.** `xpService.completeQuest` records the completion and
 *    grants the XP. That call is idempotent per quest per day, which matters
 *    more here than anywhere else in the app — see {@link loadQuests}.
 *
 * The quests themselves are neither read nor stored: `lib/quests.ts` derives
 * them from the date. So this store holds a day, its counts, and the day's
 * quests measured against them.
 */

import { isToday } from "date-fns";
import { toast } from "sonner";
import { create } from "zustand";

import { dailyQuestStatuses } from "@/lib/quests";
import { parseTimestamp, todayKey } from "@/lib/task-utils";
import { listFocusSessionsSince } from "@/services/focusService";
import { listRoutines } from "@/services/routineService";
import { listCompletedTasks } from "@/services/taskService";
import { completeQuest, listQuestCompletions } from "@/services/xpService";
import { useProgressStore } from "@/stores/progressStore";
import {
  EMPTY_ACTIVITY,
  type DailyActivity,
  type QuestStatus,
} from "@/types/quest";

/**
 * How far back the completed-task read goes before today's are picked out of
 * it. The `completed` view is newest first and there is no "completed on"
 * filter in `TaskFilter`, so the day is found by looking at enough of the
 * history to be sure it is all there. 200 is the same ceiling the focus
 * history uses, and is a great many tasks for one day.
 */
const COMPLETED_TASK_LOOKBACK = 200;

/* -------------------------------------------------------------------------- */
/* Counting the day                                                           */
/* -------------------------------------------------------------------------- */

/**
 * What the user has done today, from the three systems that record it.
 *
 * Every timestamp involved is UTC as SQLite wrote it, so the day it belongs
 * to is decided after parsing back to local time — the same conversion the
 * task views and the focus widget make, so all three agree on where the day
 * ends.
 *
 * Read in parallel and as a single unit: three counts from three moments
 * would let a quest tick over on one number while another was still stale.
 */
async function readTodaysActivity(dateKey: string): Promise<DailyActivity> {
  const [completedTasks, sessions, routines] = await Promise.all([
    listCompletedTasks({ limit: COMPLETED_TASK_LOOKBACK }),
    listFocusSessionsSince(dateKey, { only_ended: true }),
    listRoutines(),
  ]);

  const tasksCompleted = completedTasks.filter((task) => {
    const at = parseTimestamp(task.completed_at);
    return at !== null && isToday(at);
  }).length;

  // `since` is a date filter the backend applies to `started_at`, and a
  // session belongs to the day it was *started* on — one that runs past
  // midnight belongs to the evening it began in, which is how the user
  // remembers it. Re-checking locally rather than trusting the filter alone
  // keeps that boundary the same one every other view uses.
  const todaysSessions = sessions.filter((session) => {
    const startedAt = parseTimestamp(session.started_at);
    return startedAt !== null && isToday(startedAt);
  });

  const focusSeconds = todaysSessions.reduce(
    (total, session) => total + (session.duration_seconds ?? session.elapsed_seconds),
    0,
  );

  return {
    tasksCompleted,
    // Only the sessions that ran to their target. Section 43 pays for a
    // *completed* focus session; an abandoned one still adds to the minutes
    // below, because those minutes were really focused.
    focusSessionsCompleted: todaysSessions.filter((session) => session.completed).length,
    focusMinutes: Math.floor(focusSeconds / 60),
    // Distinct routines, not launches: `last_launched_at` records the most
    // recent launch per routine, so pressing START ten times on the same
    // routine counts once. Section 88, for free.
    routinesLaunched: routines.filter((routine) => {
      const at = parseTimestamp(routine.last_launched_at);
      return at !== null && isToday(at);
    }).length,
  };
}

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

interface QuestState {
  /** The day the quests below belong to, `YYYY-MM-DD`. */
  dateKey: string;
  /** Today's quests with today's numbers put through them. */
  quests: QuestStatus[];
  /** The counts behind them, so a view can show a total without re-reading. */
  activity: DailyActivity;

  /** True only while the first read is in flight. */
  isLoading: boolean;
  /** A failed read, already in user-presentable form. */
  error: string | null;

  /**
   * Re-counts the day and pays out anything newly finished.
   *
   * Safe to call as often as anything changes — that is the design. See the
   * body for why calling it repeatedly cannot grant the same XP twice.
   */
  loadQuests: () => Promise<void>;
}

export const useQuestStore = create<QuestState>((set, get) => ({
  dateKey: todayKey(),
  quests: [],
  activity: EMPTY_ACTIVITY,
  // `true`, not `false`: nothing has been read yet, and "no numbers" before
  // the first read is a wait rather than a result. Every component that reads
  // this store calls its loader on mount, so the flag is honest from the
  // first frame — and without it the widgets flash their *error* state for
  // one render, because "no data and not loading" is otherwise
  // indistinguishable from "the read came back empty-handed".
  isLoading: true,
  error: null,

  async loadQuests() {
    // Read the day fresh rather than off the state: this window can be open
    // across midnight, and after that the quests, the counts and the
    // completions all belong to a different date.
    const dateKey = todayKey();
    const isNewDay = dateKey !== get().dateKey;

    set({
      dateKey,
      // A new day has no numbers yet, so its first read is a loading state
      // even though this is not the first read of the session.
      isLoading: isNewDay || get().quests.length === 0,
      error: null,
    });

    let activity: DailyActivity;
    try {
      activity = await readTodaysActivity(dateKey);
    } catch (cause) {
      // The previous counts stay on screen. A checklist one read out of date
      // is more use than an error where the checklist was.
      set({ isLoading: false, error: String(cause) });
      return;
    }

    const quests = dailyQuestStatuses(dateKey, activity);
    const hadQuests = get().quests.length > 0 && !isNewDay;
    set({ quests, activity, isLoading: false, error: null });

    await grantFinishedQuests(quests, dateKey, hadQuests);
  },
}));

/* -------------------------------------------------------------------------- */
/* Paying out                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Records the quests that are finished but not yet paid for, and says so.
 *
 * The subtlety worth spelling out: this store finds out a quest is finished
 * by *re-counting the day*, not by watching an event. So it will conclude
 * "Complete 3 tasks is done" on every single load for the rest of the day,
 * and every other window will conclude it too. Nothing here can therefore
 * decide whether to grant XP by remembering what it granted last time.
 *
 * What it does instead is ask what has already been recorded and grant only
 * the difference — and `completeQuest` is idempotent per quest per day behind
 * that, so even two windows arriving at the same conclusion at the same
 * moment pay out once. The guard is the `(quest, day)` key in the database,
 * which is the only place both windows can see.
 *
 * `announce` is separate from granting, and false on the first load of a
 * session: XP earned before the app was opened still has to be granted, but
 * being told about it at launch is noise. Section 50 — gamification stays
 * behind the productivity UI, and a toast the user did not just earn is the
 * smallest version of it getting in the way.
 */
async function grantFinishedQuests(
  quests: QuestStatus[],
  dateKey: string,
  announce: boolean,
): Promise<void> {
  const finished = quests.filter((status) => status.isComplete);
  if (finished.length === 0) return;

  try {
    const recorded = await listQuestCompletions(dateKey);
    const alreadyPaid = new Set(recorded.map((completion) => completion.questId));

    const fresh = finished.filter((status) => !alreadyPaid.has(status.quest.id));
    if (fresh.length === 0) return;

    for (const status of fresh) {
      const completion = await completeQuest(status.quest, dateKey);

      if (announce) {
        // A toast and nothing else. Section 50 puts gamification below the
        // productivity system, so finishing an objective must not interrupt
        // what the user is doing — no dialog, no overlay, nothing to dismiss
        // before the next task can be ticked.
        toast.success("Objective complete", {
          description: `${status.quest.title} · +${completion.xpAwarded} XP`,
        });
      }
    }

    // The level bar and the streak have just moved. Whoever is showing them
    // is not necessarily this store's caller, so they are re-read here rather
    // than left to the next mount.
    void useProgressStore.getState().loadProgress();
  } catch (cause) {
    // A failed grant is not a failed checklist: the quests are on screen and
    // correct, and the XP behind them is recoverable on the next load, since
    // the day is re-counted from scratch every time. Logged rather than
    // toasted for exactly that reason.
    console.error("Could not record a finished objective:", cause);
  }
}
