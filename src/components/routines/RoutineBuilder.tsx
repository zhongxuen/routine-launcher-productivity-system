import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { actionError, moveItem } from "@/lib/routine-utils";
import { useRoutineStore } from "@/stores/routineStore";
import type { NewRoutineAction, RoutineWithActions } from "@/types/routine";

import RoutineActionRow, { type ActionDraft } from "./RoutineActionRow";
import RoutineIconPicker from "./RoutineIconPicker";

/** List identity for unsaved rows. Module-scoped so keys never collide. */
let nextDraftKey = 0;
const draftKey = () => `draft-${nextDraftKey++}`;

/** A new row starts as an application, the commonest thing a routine opens. */
const emptyAction = (): ActionDraft => ({
  key: draftKey(),
  type: "application",
  target: "",
  arguments: null,
  enabled: true,
});

function draftsFrom(routine: RoutineWithActions | null): ActionDraft[] {
  if (!routine || routine.actions.length === 0) return [emptyAction()];

  return routine.actions.map((action) => ({
    key: draftKey(),
    type: action.type,
    target: action.target,
    arguments: action.arguments,
    enabled: action.enabled,
  }));
}

interface RoutineBuilderProps {
  /** The routine being edited, or null when creating a new one. */
  routine: RoutineWithActions | null;
}

/**
 * The routine builder from development-plan.md section 31: name, icon, an
 * ordered list of actions, "+ Add Action", and Save.
 *
 * The form is one document. Editing an existing routine loads its actions as
 * drafts and saving writes the whole list back in the order shown, so the
 * order on screen is the order stored — there is no separate "save this
 * action" step that could leave the two disagreeing.
 *
 * Mount this with a `key` tied to the routine id: switching between creating
 * and editing should start a fresh form, not patch the old one.
 */
function RoutineBuilder({ routine }: RoutineBuilderProps) {
  const navigate = useNavigate();
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const updateRoutine = useRoutineStore((state) => state.updateRoutine);

  const [name, setName] = useState(routine?.name ?? "");
  const [description, setDescription] = useState(routine?.description ?? "");
  const [icon, setIcon] = useState<string | null>(routine?.icon ?? null);
  const [actions, setActions] = useState<ActionDraft[]>(() => draftsFrom(routine));

  // Field errors stay hidden until the first save attempt: an action is
  // incomplete for as long as it is being typed, and saying so the whole time
  // is noise rather than help.
  const [hasAttemptedSave, setHasAttemptedSave] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const isEditing = routine !== null;
  const trimmedName = name.trim();

  // A single untouched row means "no actions yet", not an incomplete one, so
  // it is the one incomplete action that does not block saving.
  const isEmptyList = isOnlyEmptyRow(actions);
  const hasIncompleteAction = actions.some((action) => actionError(action) !== null);
  const canSave = trimmedName.length > 0 && (isEmptyList || !hasIncompleteAction);

  function patchAction(index: number, patch: Partial<NewRoutineAction>) {
    setActions((current) =>
      current.map((action, position) =>
        position === index ? { ...action, ...patch } : action,
      ),
    );
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setHasAttemptedSave(true);
    if (isSaving) return;

    if (!trimmedName) {
      setSaveError("Give the routine a name.");
      return;
    }

    const payload: NewRoutineAction[] = isEmptyList
      ? []
      : actions.map(({ key: _key, ...action }) => ({
          ...action,
          target: action.target.trim(),
          arguments: action.arguments?.trim() || null,
        }));

    if (payload.some((action) => actionError(action) !== null)) {
      setSaveError("Finish the highlighted actions first.");
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    try {
      if (routine) {
        await updateRoutine(routine.id, {
          name: trimmedName,
          description: description.trim() || null,
          icon,
          actions: payload,
        });
        toast.success("Routine saved", { description: trimmedName });
      } else {
        await createRoutine({
          name: trimmedName,
          description: description.trim() || null,
          icon,
          actions: payload,
        });
        toast.success("Routine created", { description: trimmedName });
      }
      navigate("/routines/my-routines");
    } catch (cause) {
      setIsSaving(false);
      // Shown in the form as well as in a toast: the message usually names
      // the field to fix, and the form is where the fixing happens.
      setSaveError(String(cause));
      toast.error(routine ? "Could not save routine" : "Could not create routine", {
        description: String(cause),
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="routine-name" className="text-xs text-muted-foreground">
            Name
          </Label>
          <Input
            id="routine-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Coding Mode"
            aria-invalid={hasAttemptedSave && !trimmedName}
          />
        </div>

        <RoutineIconPicker idPrefix="routine" value={icon} onChange={setIcon} />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="routine-description" className="text-xs text-muted-foreground">
          Description (optional)
        </Label>
        <Input
          id="routine-description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Everything needed to start on the current project."
        />
      </div>

      <Separator />

      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-medium">Actions</h2>
          <p className="text-xs text-muted-foreground">Run top to bottom on launch</p>
        </div>

        <ul className="flex flex-col gap-2">
          {actions.map((action, index) => (
            <RoutineActionRow
              key={action.key}
              action={action}
              index={index}
              count={actions.length}
              error={hasAttemptedSave ? actionError(action) : null}
              onChange={(patch) => patchAction(index, patch)}
              onMove={(direction) =>
                setActions((current) => moveItem(current, index, index + direction))
              }
              onRemove={() =>
                setActions((current) => {
                  const next = current.filter((_, position) => position !== index);
                  // The list is never empty — an empty one gives the user
                  // nothing to type into and no way back.
                  return next.length > 0 ? next : [emptyAction()];
                })
              }
            />
          ))}
        </ul>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => setActions((current) => [...current, emptyAction()])}
        >
          <Plus className="size-4" />
          Add Action
        </Button>
      </div>

      {saveError && <InlineError message={saveError} />}

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={isSaving || !canSave}>
          {isSaving ? "Saving…" : isEditing ? "Save changes" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={isSaving}
          onClick={() => navigate("/routines/my-routines")}
        >
          Cancel
        </Button>
        {!isEmptyList && (
          <p className="ml-auto text-xs text-muted-foreground">
            {actions.length} action{actions.length === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </form>
  );
}

/** True when the form is still showing only its untouched starting row. */
function isOnlyEmptyRow(actions: ActionDraft[]): boolean {
  return actions.length === 1 && actions[0].target.trim().length === 0;
}

export default RoutineBuilder;
