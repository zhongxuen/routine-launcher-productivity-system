import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { actionLabel } from "@/lib/routine-utils";
import { ROUTINE_TEMPLATES, type RoutineTemplate } from "@/lib/routine-templates";
import { useRoutineStore } from "@/stores/routineStore";

import RoutineIcon from "./RoutineIcon";

/**
 * The Templates tab (development-plan.md section 64): four starter routines
 * that turn an empty My Routines into a working one in a single press. The
 * fourth, Start My Day, is also what the Start My Day dialog offers when no
 * start-of-day routine is set (section 21).
 *
 * Adding a template creates a real routine through the same store action the
 * builder uses, then opens it in the builder — the paths a template guesses
 * at (`code`, `slack`) are right on many machines and wrong on some, and the
 * moment to notice that is before the first launch, not during it.
 */
function RoutineTemplates() {
  const routines = useRoutineStore((state) => state.routines);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  // The list is read here so "Added" can be shown on templates already in
  // use, and because this tab is reachable directly from the sub-nav.
  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines]);

  const existingNames = new Set(routines.map((routine) => routine.name.toLowerCase()));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-0.5">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">TEMPLATES</p>
        <p className="text-sm text-muted-foreground">
          Starting points, not fixed recipes. Adding one creates an ordinary routine you can
          rename, reorder and re-target — check the apps point at where they live on this
          machine before the first launch.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {ROUTINE_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            alreadyAdded={existingNames.has(template.routine.name.toLowerCase())}
          />
        ))}
      </div>
    </div>
  );
}

interface TemplateCardProps {
  template: RoutineTemplate;
  /** True when a routine of the same name already exists. */
  alreadyAdded: boolean;
}

/** One template: what it opens, and the button that turns it into a routine. */
function TemplateCard({ template, alreadyAdded }: TemplateCardProps) {
  const navigate = useNavigate();
  const createRoutine = useRoutineStore((state) => state.createRoutine);
  const [isAdding, setIsAdding] = useState(false);

  const { name, icon, actions = [] } = template.routine;

  async function handleUse() {
    setIsAdding(true);
    try {
      const created = await createRoutine(template.routine);
      toast.success(`${name} added`, {
        description: "Check the targets match your setup, then save.",
      });
      navigate(`/routines/create?routine=${created.id}`);
    } catch (cause) {
      setIsAdding(false);
      toast.error("Could not add template", { description: String(cause) });
    }
  }

  return (
    <Card className="h-full gap-4 py-5">
      <div className="flex items-start gap-3 px-5">
        <RoutineIcon icon={icon ?? null} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-medium">{name}</h3>
          <p className="truncate text-xs text-muted-foreground">{template.summary}</p>
        </div>
      </div>

      <ul className="flex flex-col gap-1 px-5">
        {actions.map((action, index) => (
          <li key={index} className="flex items-center gap-2 text-sm">
            <Check className="size-3.5 shrink-0 text-status-completed" />
            <span className="truncate">{actionLabel(action)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-auto flex items-center justify-between gap-3 px-5 pt-1">
        <p className="text-xs text-muted-foreground">
          {actions.length} action{actions.length === 1 ? "" : "s"}
        </p>
        <Button size="sm" variant="outline" disabled={isAdding} onClick={() => void handleUse()}>
          <Plus className="size-4" />
          {isAdding ? "Adding…" : alreadyAdded ? "Add again" : "Use template"}
        </Button>
      </div>
    </Card>
  );
}

export default RoutineTemplates;
