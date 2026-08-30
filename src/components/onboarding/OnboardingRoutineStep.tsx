import { useState } from "react";
import { Check, Link2 } from "lucide-react";

import RoutineIcon from "@/components/routines/RoutineIcon";
import { Button } from "@/components/ui/button";
import { actionLabel } from "@/lib/routine-utils";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "@/lib/routine-templates";
import { cn } from "@/lib/utils";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";

/**
 * The walkthrough's second working step: one routine, from a template.
 *
 * A template rather than the builder, because the builder is a page with an
 * action list and a target field per row, and a user who has not yet seen a
 * routine run has no way to decide what belongs in one. The three starters
 * are already written (`lib/routine-templates.ts`), already only use the
 * action types that need no permission, and turn into an ordinary routine the
 * moment they are added — so this step is one press, and the press produces
 * something real.
 *
 * What it does *not* do is what the Templates tab does: open the new routine
 * in the builder. That tab's job is to get the guessed targets checked before
 * the first launch; this step's job is to finish a sentence about the loop,
 * and navigating out of the tour to a form would end the tour instead. The
 * same warning is given here as text, and the last screen points at Routines.
 *
 * If the previous step made a task, the new routine is attached to it. That
 * link is the whole product (section 90): a task that knows its routine is
 * what makes Start task open the workspace instead of only starting a clock.
 * A tour that made both and left them unconnected would have demonstrated a
 * to-do list and a launcher — the two things section 90 says this is not.
 */
function OnboardingRoutineStep() {
  const createdTask = useOnboardingStore((state) => state.createdTask);
  const createdRoutine = useOnboardingStore((state) => state.createdRoutine);
  const recordRoutine = useOnboardingStore((state) => state.recordRoutine);
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const updateTask = useTaskStore((state) => state.updateTask);

  /** The template being added, so only its own row says "Adding…". */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True once the routine exists but attaching it to the task failed. */
  const [linkFailed, setLinkFailed] = useState(false);

  async function handleUse(template: RoutineTemplate) {
    if (pendingId) return;

    setPendingId(template.id);
    setError(null);
    try {
      const created = await createRoutine(template.routine);
      recordRoutine({ id: created.id, name: created.name });

      if (createdTask) {
        // Separately caught: the routine exists by this point, and losing it
        // over a link the user can add later from the task itself would be
        // the worse trade. The step says so rather than staying quiet.
        try {
          await updateTask(createdTask.id, { routine_id: created.id });
        } catch (cause) {
          console.error("could not attach the routine to the first task", cause);
          setLinkFailed(true);
        }
      }
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        A routine is the workspace behind a task: the apps, folders and sites you need open, in
        order, ending with a timer. One press instead of ten.
      </p>

      {createdRoutine ? (
        <div className="flex flex-col gap-2 rounded-md border border-status-completed/30 bg-status-completed/5 px-3 py-2.5">
          <div className="flex items-center gap-2.5">
            <Check className="size-4 shrink-0 text-status-completed" />
            <p className="min-w-0 flex-1 text-sm">
              <span className="font-medium">{createdRoutine.name}</span>
              <span className="text-muted-foreground"> — added to your routines</span>
            </p>
          </div>

          {createdTask && !linkFailed && (
            <p className="flex items-start gap-2.5 text-xs text-muted-foreground">
              <Link2 className="mt-px size-3.5 shrink-0" />
              <span>
                Attached to <span className="font-medium text-foreground">{createdTask.title}</span>
                . Starting that task now launches this routine.
              </span>
            </p>
          )}

          {linkFailed && (
            <p className="text-xs text-priority-urgent">
              The routine was created, but it could not be attached to your task. You can pick it
              on the task itself in Tasks.
            </p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {ROUTINE_TEMPLATES.map((template) => (
            <li key={template.id}>
              <button
                type="button"
                disabled={pendingId !== null}
                onClick={() => void handleUse(template)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                  "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                  "disabled:pointer-events-none disabled:opacity-60",
                )}
              >
                <RoutineIcon icon={template.routine.icon ?? null} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {template.routine.name}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {(template.routine.actions ?? []).map(actionLabel).join(" · ")}
                  </span>
                </span>
                <Button asChild size="sm" variant="outline" tabIndex={-1}>
                  <span>{pendingId === template.id ? "Adding…" : "Use"}</span>
                </Button>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="text-xs text-priority-urgent">{error}</p>}

      <p className="text-xs text-muted-foreground">
        {createdRoutine
          ? "Templates guess where your apps live. Open Routines → Create to check the targets before the first launch, or build one of your own from scratch."
          : "Skip this if none of them fit — Routines → Create builds one from scratch, with your own apps, folders, sites and timer."}
      </p>
    </div>
  );
}

export default OnboardingRoutineStep;
