import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3, Check, MoreHorizontal, Pencil, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { actionLabel, actionSummary, formatFocusTime, formatLastUsed } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { RoutineWithActions } from "@/types/routine";

import RoutineIcon from "./RoutineIcon";

interface RoutineCardProps {
  routine: RoutineWithActions;
}

/**
 * One routine as section 29 draws it: the icon and name, the checklist of
 * what launching it opens, and the button that does the launching.
 *
 * The checklist is the point of the card — a routine is "a reusable
 * workspace", and what is in the workspace is the thing worth showing — so it
 * lists every action rather than a count, with disabled ones struck through
 * so a routine never quietly does less than the card says.
 *
 * The footer is section 33's long-term feedback in two lines: how often and
 * how recently the routine was started, and — once there is any — the focus
 * time and finished tasks it has produced. The second line is omitted while
 * both are zero rather than shown as "0m focused · 0 tasks done", which would
 * read as a verdict on a routine the user has only just built. Both lines are
 * one button: the whole footer opens the full panel.
 */
function RoutineCard({ routine }: RoutineCardProps) {
  const navigate = useNavigate();
  const launchRoutine = useRoutineStore((state) => state.launchRoutine);
  const deleteRoutine = useRoutineStore((state) => state.deleteRoutine);
  const openStatistics = useRoutineStore((state) => state.openStatistics);
  // Section 33's figures for this card's footer. Undefined until the second
  // half of `loadRoutines` lands (or if it failed), in which case the footer
  // is just the launch line it has always been — a card that quietly loses a
  // line is better than one that claims zero hours it never measured.
  const statistics = useRoutineStore((state) => state.statistics[routine.id]);
  const isRunning = useRoutineStore((state) => state.run?.status === "running");

  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const hasActions = routine.actions.some((action) => action.enabled);

  async function handleDelete() {
    setIsDeleting(true);
    try {
      await deleteRoutine(routine.id);
      toast.success("Routine deleted", { description: routine.name });
      setIsConfirmingDelete(false);
    } catch (cause) {
      toast.error("Could not delete routine", { description: String(cause) });
    } finally {
      setIsDeleting(false);
    }
  }

  return (
    <Card className="h-full gap-4 py-5">
      <div className="flex items-start gap-3 px-5">
        <RoutineIcon icon={routine.icon} />

        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium">{routine.name}</h3>
          <p className="truncate text-xs text-muted-foreground">
            {routine.description ?? actionSummary(routine.actions)}
          </p>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`More actions for ${routine.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => navigate(`/routines/create?routine=${routine.id}`)}>
              <Pencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openStatistics(routine.id)}>
              <BarChart3 />
              Statistics
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setIsConfirmingDelete(true)}>
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ul className="flex flex-col gap-1 px-5">
        {routine.actions.map((action) => (
          <li
            key={action.id}
            className={cn(
              "flex items-center gap-2 text-sm",
              !action.enabled && "text-muted-foreground/60",
            )}
          >
            <Check
              className={cn(
                "size-3.5 shrink-0",
                action.enabled ? "text-status-completed" : "text-muted-foreground/40",
              )}
            />
            <span className={cn("truncate", !action.enabled && "line-through")}>
              {actionLabel(action)}
            </span>
          </li>
        ))}
        {routine.actions.length === 0 && (
          <li className="text-sm text-muted-foreground">No actions yet</li>
        )}
      </ul>

      <div className="mt-auto flex items-center justify-between gap-3 px-5 pt-1">
        <button
          type="button"
          onClick={() => openStatistics(routine.id)}
          className="min-w-0 cursor-pointer text-left text-xs text-muted-foreground hover:text-foreground hover:underline"
          title="See this routine's statistics"
        >
          <span className="block truncate">
            {routine.launch_count} launch{routine.launch_count === 1 ? "" : "es"} ·{" "}
            {formatLastUsed(routine.last_launched_at)}
          </span>
          {statistics && (statistics.focusSeconds > 0 || statistics.tasksCompleted > 0) && (
            <span className="block truncate">
              {formatFocusTime(statistics.focusSeconds)} focused · {statistics.tasksCompleted} task
              {statistics.tasksCompleted === 1 ? "" : "s"} done
            </span>
          )}
        </button>

        <Button
          size="sm"
          onClick={() => void launchRoutine(routine.id)}
          disabled={isRunning || !hasActions}
          title={hasActions ? undefined : "Add an action before launching this routine"}
        >
          <Play className="size-4" />
          START
        </Button>
      </div>

      <AlertDialog open={isConfirmingDelete} onOpenChange={setIsConfirmingDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {routine.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its {routine.actions.length} action
              {routine.actions.length === 1 ? "" : "s"} go with it. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isDeleting}
              onClick={(event) => {
                // Deleting is async, so the dialog is closed by the handler
                // rather than by the click that started it.
                event.preventDefault();
                void handleDelete();
              }}
            >
              {isDeleting ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default RoutineCard;
