import { useEffect, useState } from "react";

import DailyQuests from "@/components/dashboard/DailyQuests";
import FocusWidget from "@/components/dashboard/FocusWidget";
import ProgressWidget from "@/components/dashboard/ProgressWidget";
import QuickStart from "@/components/dashboard/QuickStart";
import TodaysTasks from "@/components/dashboard/TodaysTasks";
import { Separator } from "@/components/ui/separator";
import { formatDayHeading } from "@/lib/task-utils";

/**
 * How often the greeting and the date under TODAY re-check the clock. This is
 * a desktop window that stays open for hours, so "Good afternoon" would still
 * say afternoon at midnight — and the date under it would still say yesterday
 * — if they were only read once at mount. A minute is finer than either
 * boundary needs and costs one render an hour of idle time.
 */
const CLOCK_TICK_MS = 60_000;

/** Section 7's greeting line. The mockup's own example is "Good afternoon". */
function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** The current time, re-read every minute so the greeting cannot go stale. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  return now;
}

/**
 * The dashboard (development-plan.md section 7) — the app's daily starting
 * point, and the one screen that is nothing but other screens' best parts.
 *
 * This file is composition only. Every block below owns its own data, its own
 * loading and error states, and the dialogs it can raise: `TodaysTasks`
 * mounts quick-add, `QuickStart` mounts the launch panel. That is why the
 * dashboard can read from the task, routine, focus and progress stores at
 * once without a single fetch of its own, and why a widget's Stage 9 rewrite
 * (the progress store) will not touch this page.
 *
 * The vertical order is section 7's stated priority, not the order the
 * mockup happens to draw: today's tasks, then quick routine launching, then
 * focus, then progress. Progress comes last and paired with section 44's
 * daily objectives — sections 7 and 50 both put gamification below the
 * productivity system, so the two gamified blocks are the foot of the page
 * and nothing above them refers to XP at all.
 */
function Dashboard() {
  const now = useNow();

  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <h1 className="text-2xl font-semibold tracking-tight">{greetingFor(now)}</h1>

      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Today
          </h2>
          <p className="text-xs text-muted-foreground">{formatDayHeading(now)}</p>
        </div>
        <Separator />
      </div>

      {/* 1. Today's tasks — the mockup's Tasks column and its inline progress
          meter, plus [ + Add Task ]. */}
      <TodaysTasks />

      <Separator />

      {/* 2. Quick routine launching — the QUICK START tile row. */}
      <QuickStart />

      <Separator />

      {/* 3. Focus, then 4. Progress. Both are self-contained cards, so they
          are separated by their own borders rather than another rule. */}
      <FocusWidget />

      {/* Progress and section 44's objectives, side by side on a wide window
          and stacked on a narrow one — one band of gamification at the foot
          of the page rather than two blocks the user meets separately.
          Section 50's hierarchy is a vertical one, so being last is most of
          what keeps this subordinate; the rest is that both cards are small,
          muted and unpressable. */}
      <div className="grid gap-4 md:grid-cols-2">
        <ProgressWidget />
        <DailyQuests />
      </div>
    </div>
  );
}

export default Dashboard;
