/**
 * Quest store — today's objectives (development-plan.md section 44), and the
 * XP they pay out when they are finished.
 *
 * Two halves, and only one of them is gamification:
 *
 * 1. **What the user did today.** `getDailyQuests` answers with the day's
 *    quests and, inside each, the day's counts: completed tasks, finished
 *    focus sessions, launched routines and confirmed cleanup actions, read
 *    by Rust from the tables that record them. No XP table is involved, so a
 *    tick beside "Complete 3 tasks" means three tasks are actually done.
 * 2. **The reward.** `xpService.completeQuest` asks Rust to pay for a quest
 *    that is done. Rust re-counts the requirement before it pays, and the
 *    call is idempotent per quest per day, which matters more here than
 *    anywhere else in the app — see {@link loadQuests}.
 *
 * Nothing here decides which quests the day has or whether one is finished:
 * both are Rust's (`services/quests.rs`, section 88). This store holds a day
 * and its quests, put through `evaluateQuest` for drawing.
 */

import { toast } from "sonner";
import { create } from "zustand";

import { evaluateQuest } from "@/lib/quests";
import { todayKey } from "@/lib/task-utils";
import { completeQuest, getDailyQuests, listQuestCompletions } from "@/services/xpService";
import { useProgressStore } from "@/stores/progressStore";
import type { QuestStatus } from "@/types/quest";

/* -------------------------------------------------------------------------- */
/* Store                                                                      */
/* -------------------------------------------------------------------------- */

interface QuestState {
  /** The day the quests below belong to, `YYYY-MM-DD`. */
  dateKey: string;
  /** Today's quests with today's numbers put through them. */
  quests: QuestStatus[];

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

    let quests: QuestStatus[];
    try {
      // One read for the list and its counts, so a quest cannot tick over on
      // one number while another is still stale. Rust applies section 52's
      // daily quest count itself, so a two-quest day never flashes a third
      // line.
      quests = (await getDailyQuests(dateKey)).map(evaluateQuest);
    } catch (cause) {
      // The previous counts stay on screen. A checklist one read out of date
      // is more use than an error where the checklist was.
      set({ isLoading: false, error: String(cause) });
      return;
    }

    const hadQuests = get().quests.length > 0 && !isNewDay;
    set({ quests, isLoading: false, error: null });

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

  let fresh: QuestStatus[];
  try {
    const recorded = await listQuestCompletions(dateKey);
    const alreadyPaid = new Set(recorded.map((completion) => completion.questId));
    fresh = finished.filter((status) => !alreadyPaid.has(status.quest.id));
  } catch (cause) {
    console.error("Could not read today's finished objectives:", cause);
    return;
  }
  if (fresh.length === 0) return;

  let paid = false;
  for (const status of fresh) {
    try {
      const completion = await completeQuest(status.quest.id, dateKey);
      paid = true;

      if (announce) {
        // A toast and nothing else. Section 50 puts gamification below the
        // productivity system, so finishing an objective must not interrupt
        // what the user is doing — no dialog, no overlay, nothing to dismiss
        // before the next task can be ticked.
        toast.success("Objective complete", {
          description: `${status.quest.title} · +${completion.xpAwarded} XP`,
        });
      }
    } catch (cause) {
      // A failed grant is not a failed checklist, and it does not stop the
      // next quest being paid. Rust re-counts before it pays, so the one
      // expected refusal is a day that changed between the read and this
      // call — a task un-ticked in another window — and the next load
      // re-counts from scratch. Logged rather than toasted for that reason.
      console.error(`Could not record "${status.quest.title}":`, cause);
    }
  }

  // The level bar and the streak have just moved. Whoever is showing them is
  // not necessarily this store's caller, so they are re-read here rather than
  // left to the next mount.
  if (paid) void useProgressStore.getState().loadProgress();
}
