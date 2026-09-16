import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { RoutineTemplate } from "@/lib/routine-templates";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { DailySettings } from "@/types/settings";
import type { RoutineWithActions } from "@/types/routine";

/** Which of section 52's two routines a template becomes. */
export type DailyRoutineField = Extract<
  keyof DailySettings,
  "startOfDayRoutineId" | "endOfDayRoutineId"
>;

const ROLE_NAMES: Record<DailyRoutineField, string> = {
  startOfDayRoutineId: "start-of-day",
  endOfDayRoutineId: "end-of-day",
};

/**
 * Creates a routine from `template`, makes it the day's start- or end-of-day
 * routine, and opens it in the builder — the same hand-off the Templates tab
 * makes, for the same reason: its targets are guesses, and the moment to
 * check them is before the first launch.
 *
 * Setting it as the day's routine is the point of pressing this in Start My
 * Day or the end-of-day review rather than on the Templates tab. It is only
 * done when the stored settings were actually read, since saving writes all
 * of them and a failed read would otherwise overwrite them with defaults.
 */
function CreateDailyRoutineButton({
  template,
  field,
  onClose,
}: {
  template: RoutineTemplate;
  field: DailyRoutineField;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const [isCreating, setIsCreating] = useState(false);

  async function handleCreate() {
    setIsCreating(true);

    let created: RoutineWithActions;
    try {
      created = await createRoutine(template.routine);
    } catch (cause) {
      setIsCreating(false);
      toast.error(`Could not add the ${template.routine.name} routine`, {
        description: String(cause),
      });
      return;
    }

    const linked = await makeDailyRoutine(field, created.id);
    const role = ROLE_NAMES[field];

    toast.success(`${created.name} added`, {
      description: linked
        ? `It is your ${role} routine now. Check the targets match your setup, then save.`
        : "Check the targets match your setup, then choose it in Settings > Daily.",
    });
    onClose();
    navigate(`/routines/create?routine=${created.id}`);
  }

  return (
    <Button disabled={isCreating} onClick={() => void handleCreate()}>
      <Plus />
      {isCreating ? "Adding…" : "Create from template"}
    </Button>
  );
}

/** Saves `routineId` as the day's `field` routine, answering whether it was. */
async function makeDailyRoutine(field: DailyRoutineField, routineId: number): Promise<boolean> {
  const settings = useSettingsStore.getState();
  const daily = await settings.ensureDaily();
  if (!useSettingsStore.getState().hasLoaded) return false;

  try {
    await settings.saveDaily({ ...daily, [field]: routineId });
    return true;
  } catch (cause) {
    console.error(`Could not set the ${ROLE_NAMES[field]} routine:`, cause);
    return false;
  }
}

export default CreateDailyRoutineButton;
