import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Lightbulb, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { actionLabel } from "@/lib/routine-utils";
import { formatDuration } from "@/lib/task-utils";
import { dismissSuggestion, listSuggestions } from "@/services/suggestionService";
import { useRoutineStore } from "@/stores/routineStore";
import { useTaskStore } from "@/stores/taskStore";
import type {
  MakeRecurringSuggestion,
  OpenTogetherSuggestion,
  Suggestion,
} from "@/types/suggestion";
import type { NewTaskRecurrence, Task } from "@/types/task";

import RecurrencePicker from "./RecurrencePicker";

interface TaskSuggestionProps {
  /**
   * The Today view's tasks. Only read for when they change: every task save
   * re-reads the view, and a save is what makes a suggestion apply or stop
   * applying.
   */
  tasks: Task[];
}

/** The picker's draft for a suggested schedule. Weekly is the only one with days. */
function draftFor(suggestion: MakeRecurringSuggestion): NewTaskRecurrence {
  const { frequency, days_of_week } = suggestion.recurrence;
  return frequency === "weekly" ? { frequency, days_of_week } : { frequency };
}

/** "VS Code, Chrome and Terminal". */
function appList(suggestion: OpenTogetherSuggestion): string {
  const names = suggestion.apps.map((app) =>
    actionLabel({ type: "application", target: app.exe_path }),
  );
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Section 55's rule-based suggestions, as one quiet line on Tasks > Today.
 *
 * The rules are in Rust (`services/suggestions.rs`); this only shows the
 * first one that applies. Nothing changes without a click: Yes on "Make it
 * recurring?" opens the repeat picker on the schedule the completions imply,
 * and nothing is saved until that picker's own button; Update on an estimate
 * sets the median the line names; Create routine on "you often open these
 * together" makes a routine that opens them and hands it to the builder to
 * name and check. The cross declines the suggestion for good, and the next
 * one, if any, takes its place.
 *
 * Deliberately not a toast, a dialog or a notification. A suggestion is
 * something to notice while planning, not something to interrupt for.
 */
function TaskSuggestion({ tasks }: TaskSuggestionProps) {
  const createTask = useTaskStore((state) => state.createTask);
  const updateTask = useTaskStore((state) => state.updateTask);
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const navigate = useNavigate();

  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // Hidden at once, so a read that lands before the dismissal is stored
  // cannot put it back on screen.
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [schedule, setSchedule] = useState<NewTaskRecurrence | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listSuggestions()
      .then((next) => {
        if (!cancelled) setSuggestions(next);
      })
      // A suggestion is never worth an error on screen. The next read retries.
      .catch((cause: unknown) => console.warn("Could not read suggestions", cause));
    return () => {
      cancelled = true;
    };
  }, [tasks]);

  const suggestion = suggestions.find((candidate) => !dismissed.has(candidate.key));

  // A different suggestion on the line closes a picker opened for the last one.
  const suggestionKey = suggestion?.key;
  useEffect(() => setSchedule(null), [suggestionKey]);

  if (!suggestion) return null;

  async function handleDismiss(key: string) {
    setDismissed((current) => new Set(current).add(key));
    try {
      await dismissSuggestion(key);
    } catch (cause) {
      toast.error("Could not dismiss the suggestion", { description: String(cause) });
    }
  }

  async function run(action: () => Promise<unknown>, success: string, title: string) {
    setIsSaving(true);
    try {
      await action();
      toast.success(success, { description: title });
      setSchedule(null);
    } catch (cause) {
      toast.error("Could not apply the suggestion", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  function makeRecurring(target: MakeRecurringSuggestion, recurrence: NewTaskRecurrence) {
    const action = () =>
      target.task_id !== null
        ? updateTask(target.task_id, { recurrence })
        : createTask({ ...target.template, recurrence });
    void run(action, "Task now repeats", target.title);
  }

  function updateEstimate(minutes: number, taskIds: number[], title: string) {
    const action = () =>
      Promise.all(taskIds.map((id) => updateTask(id, { estimated_minutes: minutes })));
    void run(action, `Estimate set to ${formatDuration(minutes)}`, title);
  }

  function createWorkspace(target: OpenTogetherSuggestion) {
    const action = async () => {
      const created = await createRoutine({
        name: "Workspace",
        icon: "🧩",
        actions: target.apps.map((app) => ({ type: "application" as const, target: app.exe_path })),
      });
      navigate(`/routines/create?routine=${created.id}`);
    };
    void run(action, "Routine created", "Name it and check the apps, then save.");
  }

  return (
    <div className="flex flex-col gap-2 px-2" role="status">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Lightbulb className="size-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          {suggestion.kind === "open_together" ? (
            <>
              You often open <span className="font-medium text-foreground">{appList(suggestion)}</span>{" "}
              together. Create a routine?
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{suggestion.title}</span>
              {suggestion.kind === "make_recurring"
                ? " — You complete this often. Make it recurring?"
                : ` — Usually takes about ${formatDuration(suggestion.suggested_minutes)}, not ${formatDuration(
                    suggestion.current_minutes,
                  )}. Update the estimate?`}
            </>
          )}
        </p>

        {suggestion.kind === "open_together" ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={isSaving}
            onClick={() => createWorkspace(suggestion)}
          >
            Create routine
          </Button>
        ) : suggestion.kind === "make_recurring" ? (
          schedule === null && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={isSaving}
              onClick={() => setSchedule(draftFor(suggestion))}
            >
              Yes
            </Button>
          )
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            disabled={isSaving}
            onClick={() =>
              updateEstimate(suggestion.suggested_minutes, suggestion.task_ids, suggestion.title)
            }
          >
            Update
          </Button>
        )}

        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label="Dismiss suggestion"
          disabled={isSaving}
          onClick={() => void handleDismiss(suggestion.key)}
        >
          <X className="size-4" />
        </Button>
      </div>

      {suggestion.kind === "make_recurring" && schedule !== null && (
        <div className="flex flex-col gap-3 rounded-md border p-3 sm:max-w-sm">
          <RecurrencePicker idPrefix="suggestion" value={schedule} onChange={setSchedule} />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isSaving}
              onClick={() => setSchedule(null)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isSaving}
              onClick={() => schedule && makeRecurring(suggestion, schedule)}
            >
              {isSaving ? "Saving…" : "Make recurring"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export default TaskSuggestion;
