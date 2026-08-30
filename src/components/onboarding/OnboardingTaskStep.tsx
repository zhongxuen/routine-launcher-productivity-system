import { useState } from "react";
import { Check, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { todayKey } from "@/lib/task-utils";
import { useOnboardingStore } from "@/stores/onboardingStore";
import { useTaskStore } from "@/stores/taskStore";

/**
 * The walkthrough's first working step: one task, in Today.
 *
 * Cut down to a title and a button on purpose. The full quick-add of section
 * 16 also asks for a due date, a priority, a repeat and a routine, and every
 * one of those is a question the user has no basis to answer thirty seconds
 * into the app. So this fixes the two that matter for the tour to continue —
 * due today, so it is on the dashboard the tour ends on; normal priority,
 * because that is the default anyway — and leaves the rest to be discovered
 * on the real form, which does not hide them.
 *
 * The task it makes is an ordinary task: same store, same command, same row.
 * Nothing marks it as having come from the tour, and deleting it costs
 * nothing, which is the point of asking for a real one rather than seeding a
 * fake "Your first task" the user has to clean up.
 */
function OnboardingTaskStep() {
  const createdTask = useOnboardingStore((state) => state.createdTask);
  const recordTask = useOnboardingStore((state) => state.recordTask);
  const createTask = useTaskStore((state) => state.createTask);

  const [title, setTitle] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = title.trim();

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!trimmed || isSaving) return;

    setIsSaving(true);
    setError(null);
    try {
      const created = await createTask({
        title: trimmed,
        priority: "normal",
        due_date: todayKey(),
      });
      recordTask({ id: created.id, title: created.title });
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Everything else in the app hangs off this. A task is one thing you have to get done —
        &ldquo;Finish project report&rdquo;, &ldquo;Reply to emails&rdquo; — and Today is the
        list you open the app to.
      </p>

      {createdTask ? (
        // Shown instead of the form rather than beside it: the step asks for
        // one task, and a form still sitting there afterwards reads as an
        // invitation to keep going until the tour lets you leave.
        <div className="flex items-center gap-2.5 rounded-md border border-status-completed/30 bg-status-completed/5 px-3 py-2.5">
          <Check className="size-4 shrink-0 text-status-completed" />
          <p className="min-w-0 flex-1 text-sm">
            <span className="font-medium">{createdTask.title}</span>
            <span className="text-muted-foreground"> — added to Today</span>
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="What needs doing today?"
            aria-label="First task title"
            aria-invalid={error !== null}
          />
          <Button type="submit" disabled={!trimmed || isSaving}>
            <Plus />
            {isSaving ? "Adding…" : "Add"}
          </Button>
        </form>
      )}

      {error && <p className="text-xs text-priority-urgent">{error}</p>}

      <p className="text-xs text-muted-foreground">
        {createdTask
          ? "Tasks can also carry a due date, a priority, a repeat and a reminder — all of that is on the full Add task form."
          : "Nothing here is permanent, and you can skip this step. Ctrl+N opens the full form from anywhere in the app."}
      </p>
    </div>
  );
}

export default OnboardingTaskStep;
