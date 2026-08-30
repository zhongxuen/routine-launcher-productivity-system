import { CalendarCheck, ChevronRight, Rocket, Sparkles, Timer } from "lucide-react";

import { cn } from "@/lib/utils";
import type { OnboardingStepId } from "@/lib/onboarding";

/**
 * The four stages, in section 90's order, with the sidebar's own icons.
 *
 * Borrowing the icons is not decoration. The tour is teaching a loop whose
 * stages are also four of the seven things in the nav, and a user who has
 * seen this strip should recognise where each stage lives the first time they
 * look left. The two stages section 90 lists that are missing here —
 * WORKSPACE and COMPLETION — are not screens: one is what a routine opens and
 * the other is ticking a box, so both are described inside the stage they
 * belong to rather than given a box of their own.
 */
const STAGES: {
  id: OnboardingStepId;
  label: string;
  caption: string;
  icon: typeof Rocket;
}[] = [
  { id: "task", label: "Task", caption: "what to do", icon: CalendarCheck },
  { id: "routine", label: "Routine", caption: "what to open", icon: Rocket },
  { id: "focus", label: "Focus", caption: "time on it", icon: Timer },
  { id: "progress", label: "Progress", caption: "what it added up to", icon: Sparkles },
];

interface OnboardingLoopProps {
  /**
   * The stage to call out, if any. The welcome step passes nothing and gets
   * the whole loop at equal weight — that step is about the shape, not about
   * a place in it.
   */
  activeId?: OnboardingStepId;
  className?: string;
}

/**
 * TASK → ROUTINE → FOCUS → PROGRESS, drawn once and shown on every step of
 * the walkthrough with the current stage lit.
 *
 * It is the same strip throughout deliberately. Section 90 is that the
 * product is the *connection* between a to-do list, a launcher and a timer
 * rather than any of the three, and a tour that showed one feature per screen
 * with nothing joining them would be teaching exactly the reading section 90
 * says is wrong. Keeping the loop on screen while each stage is explained is
 * what makes the fifth screen land as the end of one thing rather than as the
 * fifth of five.
 */
function OnboardingLoop({ activeId, className }: OnboardingLoopProps) {
  return (
    <ol
      className={cn("flex items-stretch gap-1", className)}
      aria-label="The Task, Routine, Focus, Progress loop"
    >
      {STAGES.map(({ id, label, caption, icon: Icon }, index) => {
        const isActive = id === activeId;

        return (
          <li key={id} className="flex min-w-0 flex-1 items-center gap-1">
            <div
              aria-current={isActive ? "step" : undefined}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-md border px-2 py-2.5 text-center transition-colors",
                isActive
                  ? "border-primary/40 bg-accent text-accent-foreground"
                  : "border-transparent bg-muted/40 text-muted-foreground",
              )}
            >
              <Icon className={cn("size-4", isActive && "text-primary")} />
              <span className="text-xs font-medium leading-none">{label}</span>
              <span className="truncate text-[11px] leading-none opacity-70">{caption}</span>
            </div>

            {index < STAGES.length - 1 && (
              <ChevronRight
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/50"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

export default OnboardingLoop;
