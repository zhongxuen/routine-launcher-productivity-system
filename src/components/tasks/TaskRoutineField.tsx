import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import RoutineIcon from "@/components/routines/RoutineIcon";
import { cn } from "@/lib/utils";
import { useRoutineStore } from "@/stores/routineStore";

/** The select's value for "no routine" — Select cannot hold "". */
export const NO_ROUTINE = "none";

/** A stored `routine_id` as the select's value. */
export const routineFieldValue = (routineId: number | null): string =>
  routineId === null ? NO_ROUTINE : String(routineId);

/** The select's value back as a `routine_id` for the wire. */
export const routineIdFromField = (value: string): number | null =>
  value === NO_ROUTINE ? null : Number(value);

interface TaskRoutineFieldProps {
  /** Prefixed onto the control's id so two forms can be open at once. */
  idPrefix: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}

/**
 * The optional "Routine" field on the task forms (section 18): which
 * workspace this task is done in.
 *
 * Optional in the strong sense — most tasks never get one, and a task with no
 * routine behaves exactly as it did before — so "None" leads the list and is
 * what every task starts as.
 *
 * Routines are read from the store rather than fetched here; whichever page
 * hosts the form loads them (see `src/pages/Tasks.tsx`), and quick-add, which
 * the shell hosts on every page, loads them when it opens. An empty list is
 * therefore either "no routines yet" or "not read yet", and both want the
 * same thing: the field stays usable, and says why there is nothing in it.
 */
function TaskRoutineField({ idPrefix, value, onChange, className }: TaskRoutineFieldProps) {
  const routines = useRoutineStore((state) => state.routines);
  const id = `${idPrefix}-routine`;

  // A value with no matching item would leave the trigger blank, which reads
  // as "no routine" when the truth is "a routine the list has not caught up
  // with" — the routines are still loading, most likely. Naming it keeps the
  // field honest and keeps the current value selectable.
  const isUnknown =
    value !== NO_ROUTINE && !routines.some((routine) => String(routine.id) === value);

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        Routine
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_ROUTINE}>None</SelectItem>
          {isUnknown && (
            <SelectItem value={value} className="text-muted-foreground">
              Assigned routine
            </SelectItem>
          )}
          {routines.map((routine) => (
            <SelectItem key={routine.id} value={String(routine.id)}>
              <RoutineIcon icon={routine.icon} className="size-6 text-sm" />
              {routine.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {routines.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Build a routine first and it can be started from this task.
        </p>
      )}
    </div>
  );
}

export default TaskRoutineField;
