import { useEffect } from "react";
import { CircleCheckBig, Circle } from "lucide-react";
import { Link } from "react-router-dom";

import AsyncBody from "@/components/common/states/AsyncBody";
import StaleNotice from "@/components/common/states/StaleNotice";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { clampQuestCount } from "@/lib/quests";
import { cn } from "@/lib/utils";
import { useFocusStore } from "@/stores/focusStore";
import { useQuestStore } from "@/stores/questStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTaskStore } from "@/stores/taskStore";
import type { QuestStatus } from "@/types/quest";

/**
 * TODAY'S OBJECTIVES — development-plan.md section 44.
 *
 * ```text
 * TODAY'S OBJECTIVES
 *
 * □ Complete 25-minute focus session
 *   +25 XP
 *
 * □ Complete 3 tasks
 *   +50 XP
 * ```
 *
 * Two or three lines — section 52's daily quest count — generated from the
 * date and counted by Rust (`services/quests.rs`), and ticked by work the user
 * was going to do anyway. Rust re-counts before it pays, so a tick here is
 * the same decision as the XP behind it (section 88).
 * Section 44 is mostly a warning — *only 2-3 quests per day*, *do not
 * overwhelm the user* — so the list is short by construction and there is
 * nothing here to configure, dismiss or scroll; the count is set in Settings.
 *
 * **The boxes are not buttons.** A quest is finished by finishing tasks,
 * sessions and routines, or by a cleanup the user confirmed; there is no way
 * to tick one by hand, so it is drawn with an icon rather than a `Checkbox`
 * that would invite a click it cannot honour. This block is a readout of the
 * productivity system, not a second to-do list competing with the one above
 * it — section 50, in the smallest possible form. A cleanup quest's title is
 * a link to its utility, and opening the page is all the link does
 * (section 67).
 *
 * The re-read is the interesting part. The day is counted from tasks, focus
 * sessions and routines, so the list has to re-read whenever any of those
 * change; the effect depends on the three stores' collections, which
 * change identity on every reload and every mutation. That is what lets a
 * task ticked in the widget directly above move the "Complete 3 tasks" line
 * without either component knowing about the other. Cleanup happens on
 * another page, so coming back to the dashboard mounts this block again, and
 * the mount re-counts the day.
 *
 * Self-contained: it owns its data and its own failure state, so the page
 * only has to position it.
 */
function DailyQuests({ className }: { className?: string }) {
  const quests = useQuestStore((state) => state.quests);
  const isLoading = useQuestStore((state) => state.isLoading);
  const error = useQuestStore((state) => state.error);
  const loadQuests = useQuestStore((state) => state.loadQuests);

  // The three things a quest can be measured against, watched where they
  // already live. Cheap: the dashboard's other widgets have loaded all three
  // for their own reasons, so this adds a re-count rather than a page's worth
  // of queries.
  const tasks = useTaskStore((state) => state.tasks);
  const focusHistory = useFocusStore((state) => state.history);
  const routines = useRoutineStore((state) => state.routines);
  // Section 52's count: saving 2 in Settings takes the last line off here.
  const questCount = useSettingsStore((state) => state.daily.dailyQuestCount);

  useEffect(() => {
    void loadQuests();
  }, [loadQuests, tasks, focusHistory, routines, questCount]);

  const done = quests.filter((status) => status.isComplete).length;

  return (
    <Card className={cn("gap-3 py-5", className)}>
      <header className="flex items-baseline justify-between gap-3 px-5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">
          TODAY&apos;S OBJECTIVES
        </p>
        {quests.length > 0 && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {done} / {quests.length}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-2.5 px-5">
        {/* The error is passed only when there is nothing to show. A failed
            read produces no quests, so without that the widget would say
            "No objectives today" — telling the user the day is empty when
            in fact it is unreadable. */}
        <AsyncBody
          isLoading={isLoading && quests.length === 0}
          error={quests.length === 0 ? error : null}
          onRetry={() => void loadQuests()}
          loading={<QuestSkeleton rows={clampQuestCount(questCount)} />}
          loadingLabel="Loading today's objectives"
          errorTitle="Could not load today's objectives."
          errorClassName="py-4"
          isEmpty={quests.length === 0}
          emptyTitle="No objectives today."
          emptyClassName="py-2"
        >
          <ul className="flex flex-col gap-2.5">
            {quests.map((status) => (
              <QuestRow key={status.quest.id} status={status} />
            ))}
          </ul>
        </AsyncBody>
      </div>

      {/* Stated under the list rather than instead of it, the way the Focus
          and Progress widgets state theirs: yesterday's reckoning of today is
          still worth reading, and this is not the block to be loud about. */}
      {error && quests.length > 0 && (
        <StaleNotice
          className="px-5"
          message="Objectives may be out of date."
          onRetry={() => void loadQuests()}
        />
      )}
    </Card>
  );
}

/**
 * One line: a box, what it asks for, and what it pays.
 *
 * A finished quest keeps its full weight rather than being struck through and
 * greyed out. Section 44 draws a checklist, and the point of a checklist at
 * the end of the day is the ticks on it — fading them would make a finished
 * list look like an empty one.
 *
 * The XP is muted and last on the line on purpose. It is the reward for the
 * work, not the reason for it (section 45: "do not make users grind XP"), so
 * it reads as a footnote to the objective rather than as the objective.
 */
function QuestRow({ status }: { status: QuestStatus }) {
  const { quest, isComplete, progressLabel } = status;
  const Icon = isComplete ? CircleCheckBig : Circle;

  return (
    <li className="flex items-start gap-2.5 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          isComplete ? "text-status-completed" : "text-muted-foreground/50",
        )}
        aria-hidden
      />

      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        {quest.href ? (
          <Link
            to={quest.href}
            className={cn(
              "min-w-0 underline-offset-2 hover:underline",
              isComplete && "font-medium",
            )}
          >
            {quest.title}
          </Link>
        ) : (
          <span className={cn("min-w-0", isComplete && "font-medium")}>{quest.title}</span>
        )}
        {progressLabel && (
          <span className="text-xs tabular-nums text-muted-foreground">{progressLabel}</span>
        )}
      </div>

      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        +{quest.xpReward} XP
      </span>
      <span className="sr-only">{isComplete ? "Complete" : "Not complete"}</span>
    </li>
  );
}

/** The same short list, at the same heights, while the day is counted. */
function QuestSkeleton({ rows }: { rows: number }) {
  return (
    <div role="status" aria-busy className="flex flex-col gap-2.5">
      <span className="sr-only">Loading today&apos;s objectives</span>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-2.5" aria-hidden>
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-3 w-12 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export default DailyQuests;
export { DailyQuests };
