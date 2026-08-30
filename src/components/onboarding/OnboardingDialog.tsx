import { useEffect } from "react";
import { ArrowLeft, ArrowRight, Check, Play, Rocket, Sparkles, Timer } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ONBOARDING_STEPS, ONBOARDING_STEP_COUNT } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import { useOnboardingStore } from "@/stores/onboardingStore";

import OnboardingLoop from "./OnboardingLoop";
import OnboardingRoutineStep from "./OnboardingRoutineStep";
import OnboardingTaskStep from "./OnboardingTaskStep";

/**
 * The first-run walkthrough (development-plan.md section 84).
 *
 * Five steps over section 90's loop — TASK → ROUTINE → FOCUS → PROGRESS —
 * with the two middle ones asking the user to make the two things the loop
 * needs to be demonstrable at all. Section 89's "recommended core user
 * experience" is the script: a task, the routine that opens everything it
 * needs, the clock, the tick, the numbers going up.
 *
 * ## Skippable everywhere
 *
 * Three ways out, on every step, on purpose:
 *
 * * **Skip tour** in the footer, which ends it.
 * * **✕** and **Escape**, which do the same thing without the sentence.
 * * The primary button on either working step, which reads *Skip for now*
 *   until something has been made and *Next* afterwards — so pressing past a
 *   step you do not want is the same gesture as finishing one you do.
 *
 * All of them count as seen; see `src-tauri/src/services/onboarding.rs` for
 * why skipping is not recorded differently from finishing. A click on the
 * overlay is deliberately *not* one of the ways out — it is the only
 * dismissal a user can make by accident, and this is a dialog that does not
 * come back.
 *
 * ## Where it is mounted
 *
 * In the app shell, beside the other things that outlive the page being
 * looked at, and only there: the popup, the widget and the quick launcher are
 * separate windows with their own entry points, and a tour in a 300px widget
 * would be neither readable nor the place a first launch starts.
 */
function OnboardingDialog() {
  const isOpen = useOnboardingStore((state) => state.isOpen);
  const stepIndex = useOnboardingStore((state) => state.stepIndex);
  const createdTask = useOnboardingStore((state) => state.createdTask);
  const createdRoutine = useOnboardingStore((state) => state.createdRoutine);
  const checkFirstRun = useOnboardingStore((state) => state.checkFirstRun);
  const next = useOnboardingStore((state) => state.next);
  const back = useOnboardingStore((state) => state.back);
  const finish = useOnboardingStore((state) => state.finish);

  useEffect(() => {
    void checkFirstRun();
  }, [checkFirstRun]);

  const step = ONBOARDING_STEPS[stepIndex];
  const isLastStep = stepIndex === ONBOARDING_STEP_COUNT - 1;

  // Whether this step's own ask has been answered. Only the two working steps
  // have one; everywhere else the primary button is simply Next.
  const isStepDone =
    step.id === "task" ? createdTask !== null : step.id === "routine" ? createdRoutine !== null : true;

  async function end() {
    try {
      await finish();
    } catch (cause) {
      // The tour has already closed — `finish` sets that before writing — so
      // this is only about the flag, and the honest thing to say is that it
      // will be back rather than nothing at all.
      toast.error("The walkthrough could not be marked as seen", {
        description: `It may open again next launch. ${String(cause)}`,
      });
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) void end();
      }}
    >
      <DialogContent
        className="sm:max-w-lg"
        // See the module docs: Escape and ✕ are ways out, a stray click on
        // the overlay is not.
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="gap-1.5">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            STEP {stepIndex + 1} OF {ONBOARDING_STEP_COUNT}
          </p>
          <DialogTitle className="text-lg">{step.title}</DialogTitle>
          <DialogDescription>{step.summary}</DialogDescription>
        </DialogHeader>

        <OnboardingLoop activeId={step.id === "welcome" ? undefined : step.id} />

        <div className="min-h-[11rem]">
          {step.id === "welcome" && <WelcomeStep />}
          {step.id === "task" && <OnboardingTaskStep />}
          {step.id === "routine" && <OnboardingRoutineStep />}
          {step.id === "focus" && <FocusStep />}
          {step.id === "progress" && <ProgressStep />}
        </div>

        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => void end()}
          >
            {isLastStep ? "Close" : "Skip tour"}
          </Button>

          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <Button variant="outline" size="sm" onClick={back}>
                <ArrowLeft />
                Back
              </Button>
            )}

            {isLastStep ? (
              <Button size="sm" onClick={() => void end()}>
                <Check />
                Finish
              </Button>
            ) : (
              <Button size="sm" onClick={next}>
                {step.isDoingStep && !isStepDone ? "Skip for now" : "Next"}
                <ArrowRight />
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Section 89's worked example, as the five moments it is made of. */
const DAY = [
  { when: "9:00", what: "Open the app", then: "Today's tasks, waiting" },
  { when: "", what: "Pick one and press START TASK", then: "Its routine opens the workspace" },
  { when: "", what: "The focus clock starts itself", then: "50:00, on the task" },
  { when: "", what: "Tick it off", then: "+10 XP, and the day's count moves" },
  { when: "", what: "Look at the dashboard", then: "1 / 4 done · 50 minutes · 🔥 6 days" },
];

/**
 * Step one: section 89's day, compressed to five lines.
 *
 * The mockup narrative rather than a feature list, because the thing being
 * introduced is a sequence — and a sequence is much easier to recognise from
 * one worked example than from a description of its parts.
 */
function WelcomeStep() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Not a to-do list, not a timer, not an app launcher — the line between them. A normal day
        looks like this:
      </p>

      <ol className="flex flex-col rounded-md border bg-muted/30 px-3 py-2">
        {DAY.map((row, index) => (
          <li
            key={index}
            className={cn(
              "flex items-baseline gap-3 py-1.5 text-sm",
              index > 0 && "border-t border-border/50",
            )}
          >
            <span className="w-9 shrink-0 text-xs tabular-nums text-muted-foreground">
              {row.when}
            </span>
            <span className="min-w-0 flex-1">{row.what}</span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
              {row.then}
            </span>
          </li>
        ))}
      </ol>

      <p className="text-xs text-muted-foreground">
        Four short steps from here. Two of them ask you to make something; both can be skipped,
        and this walkthrough will not open again.
      </p>
    </div>
  );
}

/** Step four: what START TASK actually does, and what the clock is. */
function FocusStep() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        This is the press the rest of it is for. START TASK on a task that has a routine does
        both halves at once — no second decision, no second click.
      </p>

      <ul className="flex flex-col gap-2">
        <li className="flex items-start gap-2.5 text-sm">
          <Rocket className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            The routine runs: apps, folders and sites open in order, and anything that failed is
            reported rather than skipped quietly.
          </span>
        </li>
        <li className="flex items-start gap-2.5 text-sm">
          <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            The clock starts on the routine's own timer step — 25, 50 or 90 minutes, custom, or a
            stopwatch — attached to that task.
          </span>
        </li>
        <li className="flex items-start gap-2.5 text-sm">
          <Play className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            It keeps running wherever you go in the app, can be paused, and shows up in the tray
            and the desktop widget. When it ends, you get a notification.
          </span>
        </li>
      </ul>
    </div>
  );
}

/**
 * Step five: where the work goes afterwards — and, if the tour was actually
 * done rather than clicked through, what to press next.
 */
function ProgressStep() {
  const createdTask = useOnboardingStore((state) => state.createdTask);
  const createdRoutine = useOnboardingStore((state) => state.createdRoutine);
  const isReady = createdTask !== null && createdRoutine !== null;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Finished work is scored, quietly and in the background. Nothing here interrupts you.
      </p>

      <ul className="flex flex-col gap-2">
        <li className="flex items-start gap-2.5 text-sm">
          <Check className="mt-0.5 size-4 shrink-0 text-status-completed" />
          <span>
            A task ticked off is +10 XP, a focus session that runs to its target is +25, and the
            day's first routine launch is +10.
          </span>
        </li>
        <li className="flex items-start gap-2.5 text-sm">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            Those become levels, achievements, a daily streak, and the statistics in Progress —
            hours focused, tasks completed, your most-used routines.
          </span>
        </li>
      </ul>

      <div className="rounded-md border bg-muted/30 px-3 py-2.5 text-sm">
        {isReady ? (
          <>
            You have <span className="font-medium">{createdTask.title}</span> in Today and{" "}
            <span className="font-medium">{createdRoutine.name}</span> behind it. Press{" "}
            <span className="font-medium">START TASK</span> on the dashboard and the loop runs.
          </>
        ) : (
          <>
            Start on the dashboard: add a task with{" "}
            <span className="font-medium">+ Add Task</span>, build a routine in{" "}
            <span className="font-medium">Routines → Create</span>, and put the two together on
            the task. Settings can bring this walkthrough back at any time.
          </>
        )}
      </div>
    </div>
  );
}

export default OnboardingDialog;
