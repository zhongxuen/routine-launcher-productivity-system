import { ChevronDown, ChevronUp, ShieldAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ROUTINE_ACTION_ICONS,
  ROUTINE_ACTION_TARGET_HINTS,
  ROUTINE_ACTION_TARGET_LABELS,
} from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import {
  ROUTINE_ACTION_TYPES,
  ROUTINE_ACTION_TYPE_LABELS,
  type NewRoutineAction,
  type RoutineActionType,
} from "@/types/routine";

/**
 * One action while it is being edited.
 *
 * `key` is a client-side identity for the list — a stored action's id is no
 * use here, because an action that has not been saved yet does not have one
 * and a reorder must not make React reuse the wrong input.
 */
export interface ActionDraft extends NewRoutineAction {
  key: string;
  enabled: boolean;
}

/** Types that take extra arguments; the rest are launched with the target alone. */
const TAKES_ARGUMENTS: RoutineActionType[] = ["application", "command"];

interface RoutineActionRowProps {
  action: ActionDraft;
  /** Zero-based; shown to the user as `index + 1`, per section 31's list. */
  index: number;
  /** How many actions there are, so the ends know to disable a move. */
  count: number;
  /** What is wrong with this action, once it is worth telling the user. */
  error: string | null;
  onChange: (patch: Partial<NewRoutineAction>) => void;
  onMove: (direction: -1 | 1) => void;
  onRemove: () => void;
}

/**
 * A row of the builder's action list (section 31): position, type, target,
 * and the controls that move or remove it.
 *
 * Reordering is by move-up / move-down rather than dragging: the list is the
 * launch order, keyboard and pointer reach the buttons equally, and a routine
 * is half a dozen actions long — not a length where dragging pays for itself.
 */
function RoutineActionRow({
  action,
  index,
  count,
  error,
  onChange,
  onMove,
  onRemove,
}: RoutineActionRowProps) {
  const TypeIcon = ROUTINE_ACTION_ICONS[action.type];
  const targetId = `routine-action-${action.key}-target`;
  const argumentsId = `routine-action-${action.key}-arguments`;

  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-lg border bg-card p-3",
        !action.enabled && "opacity-60",
      )}
    >
      <span className="w-5 pt-2 text-right text-xs tabular-nums text-muted-foreground">
        {index + 1}.
      </span>

      <div className="flex flex-col gap-0.5 pt-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onMove(-1)}
          disabled={index === 0}
          aria-label={`Move action ${index + 1} up`}
        >
          <ChevronUp />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onMove(1)}
          disabled={index === count - 1}
          aria-label={`Move action ${index + 1} down`}
        >
          <ChevronDown />
        </Button>
      </div>

      {/* Stacked below `md`, where the row is already giving a column to
          the reorder buttons and another to the delete button: a 10rem type
          picker beside a path field leaves the path about 300px, and a path
          is the one value in this form that is routinely longer than the box
          it is typed into. Section 84's responsive layouts, at the shell's
          breakpoint. */}
      <div className="grid min-w-0 flex-1 gap-3 md:grid-cols-[10rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground">Type</Label>
          <Select
            value={action.type}
            onValueChange={(value) =>
              // The target means something different under a new type, so it
              // is cleared rather than carried over — a URL is not a folder.
              onChange({ type: value as RoutineActionType, target: "", arguments: null })
            }
          >
            <SelectTrigger className="w-full" aria-label={`Action ${index + 1} type`}>
              <TypeIcon className="size-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROUTINE_ACTION_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {ROUTINE_ACTION_TYPE_LABELS[type]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex min-w-0 flex-col gap-1.5">
          <Label htmlFor={targetId} className="text-xs text-muted-foreground">
            {ROUTINE_ACTION_TARGET_LABELS[action.type]}
          </Label>
          <Input
            id={targetId}
            value={action.target}
            onChange={(event) => onChange({ target: event.target.value })}
            placeholder={ROUTINE_ACTION_TARGET_HINTS[action.type]}
            inputMode={action.type === "timer" ? "numeric" : "text"}
            aria-invalid={error !== null}
          />
          {error && <p className="text-xs text-priority-urgent">{error}</p>}
        </div>

        {TAKES_ARGUMENTS.includes(action.type) && (
          <div className="flex min-w-0 flex-col gap-1.5 md:col-start-2">
            <Label htmlFor={argumentsId} className="text-xs text-muted-foreground">
              Arguments (optional)
            </Label>
            <Input
              id={argumentsId}
              value={action.arguments ?? ""}
              onChange={(event) => onChange({ arguments: event.target.value })}
              placeholder={action.type === "command" ? "--watch" : "--new-window"}
            />
          </div>
        )}

        {action.type === "command" && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground md:col-span-2">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-priority-high" />
            Command actions only run once you enable them in Settings, and the exact command is
            shown before it runs (development-plan.md section 66).
          </p>
        )}
      </div>

      <div className="flex items-center gap-1 pt-1.5">
        <Tooltip>
          {/* The switch is wrapped rather than being the trigger itself: as a
              trigger it would inherit the tooltip's own `data-state`, and the
              switch styles itself off `data-state=checked`. */}
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <Switch
                checked={action.enabled}
                onCheckedChange={(checked) => onChange({ enabled: checked })}
                aria-label={`Run action ${index + 1} when this routine launches`}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent>{action.enabled ? "Runs on launch" : "Skipped on launch"}</TooltipContent>
        </Tooltip>

        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label={`Remove action ${index + 1}`}
        >
          <X />
        </Button>
      </div>
    </li>
  );
}

export default RoutineActionRow;
