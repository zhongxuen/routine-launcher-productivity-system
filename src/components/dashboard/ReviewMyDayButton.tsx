import { Moon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { dayHasEnded } from "@/lib/end-of-day";
import { useAppStore } from "@/stores/appStore";
import { useSettingsStore } from "@/stores/settingsStore";

/**
 * The dashboard's way into section 22's end-of-day review, opening
 * `EndOfDayDialog`.
 *
 * Shown from the day's end in Settings > Daily until midnight, and never
 * before. `now` is the dashboard's clock, which re-reads the time every
 * minute, so the button arrives at the end time without a reload. It is a
 * button and nothing more: the review is optional, so it waits to be
 * pressed. The tray menu and the quick launcher open it at any hour.
 *
 * Nothing is drawn until the settings are known, so a day that ends at 4 PM
 * does not wait for the 6 PM default to find out.
 */
function ReviewMyDayButton({ now }: { now: Date }) {
  const dayStartTime = useSettingsStore((state) => state.daily.dayStartTime);
  const dayEndTime = useSettingsStore((state) => state.daily.dayEndTime);
  const settingsKnown = useSettingsStore((state) => state.hasLoaded || state.loadError !== null);
  const requestReviewMyDay = useAppStore((state) => state.requestReviewMyDay);

  if (!settingsKnown || !dayHasEnded({ dayStartTime, dayEndTime }, now)) return null;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <Button size="lg" variant="outline" onClick={requestReviewMyDay}>
        <Moon />
        Review my day
      </Button>
      <p className="text-xs text-muted-foreground">
        Today's figures, what is still open, and tomorrow.
      </p>
    </div>
  );
}

export default ReviewMyDayButton;
