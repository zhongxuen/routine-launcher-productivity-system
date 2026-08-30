import { PlayCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ONBOARDING_STEP_COUNT } from "@/lib/onboarding";
import { useOnboardingStore } from "@/stores/onboardingStore";

/**
 * The way back into section 84's walkthrough.
 *
 * A first-run flow is by definition spent after one launch, and there is
 * exactly one thing worse than a tour that keeps coming back: a tour the user
 * skipped in their first thirty seconds and then wanted, with the flag that
 * suppressed it sitting in a database table they cannot reach. So the flag
 * gets a switch, and this is it.
 *
 * It only re-opens the dialog; it does not clear the flag. Whether the replay
 * is finished or skipped, `finish` writes "seen" again, so nothing about
 * pressing this can put the tour in front of the *next* launch.
 */
function WalkthroughCard() {
  const restart = useOnboardingStore((state) => state.restart);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Getting started</CardTitle>
        <CardDescription>
          The walkthrough that runs on a first launch: how a task, a routine, a focus session and
          your progress fit together, in {ONBOARDING_STEP_COUNT} steps.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted-foreground">
            Nothing you have made is affected — the two steps that create things can be skipped.
          </p>
          <Button variant="outline" size="sm" onClick={restart}>
            <PlayCircle />
            Show it again
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default WalkthroughCard;
