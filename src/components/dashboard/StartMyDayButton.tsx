import { Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { launchedToday, PLANNING_SESSION, startOfDayRoutine } from "@/lib/start-my-day";
import { useAppStore } from "@/stores/appStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * Section 89's `[ START MY DAY ]`: the first thing on the dashboard in the
 * morning, opening `StartMyDayDialog`.
 *
 * Gone once today's start-of-day routine has been launched — from here, its
 * own card, the tray or anywhere else — read off the routine's own
 * `last_launched_at` rather than a flag of its own, so it cannot disagree
 * with what actually ran. `now` is the dashboard's clock, which re-reads the
 * time every minute, so the button comes back the morning after without a
 * reload.
 *
 * With no start-of-day routine set it stays, because the dialog is also how
 * one gets set. Nothing is drawn until both the settings and the routines
 * have been read, so it does not flash up and vanish on a day that has
 * already started.
 */
function StartMyDayButton({ now }: { now: Date }) {
  const routineId = useSettingsStore((state) => state.daily.startOfDayRoutineId);
  const settingsKnown = useSettingsStore((state) => state.hasLoaded || state.loadError !== null);
  const routines = useRoutineStore((state) => state.routines);
  const routinesLoading = useRoutineStore((state) => state.isLoading);
  const requestStartMyDay = useAppStore((state) => state.requestStartMyDay);

  // The routines only matter when one is set; waiting on them otherwise would
  // blink the button away on every re-read of an empty routine list.
  if (!settingsKnown || (routineId !== null && routinesLoading)) return null;

  const routine = startOfDayRoutine(routineId, routines);
  if (routine && launchedToday(routine, now)) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button size="lg" onClick={requestStartMyDay}>
        <Sun />
        START MY DAY
      </Button>
      <p className="text-xs text-muted-foreground">
        {routine
          ? `Opens ${routine.name}, then ${PLANNING_SESSION.minutes} minutes to plan.`
          : "Today at a glance, and a routine to open it with."}
      </p>
    </div>
  );
}

export default StartMyDayButton;
