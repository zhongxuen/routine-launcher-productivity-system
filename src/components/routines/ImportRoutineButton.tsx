import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, FileInput, TriangleAlert } from "lucide-react";
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
import { actionLabel } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { importRoutineFile, inspectRoutineFile, pickRoutineFile } from "@/services/tier5Service";
import { useRoutineStore } from "@/stores/routineStore";
import { ROUTINE_ACTION_TYPE_LABELS } from "@/types/routine";
import type { RoutinePreview } from "@/types/tier5";

import RoutineIcon from "./RoutineIcon";

/**
 * Import a shared routine file (development-plan.md section 92's shared
 * routine templates).
 *
 * Two steps, like Import in Settings › Data: the file is read and checked
 * first, and the dialog lists every action it would add — with commands
 * marked as arriving switched off (section 66) and paths that do not exist on
 * this computer flagged — before anything is created. Importing then opens
 * the builder, where the routine can be checked before its first launch.
 */
function ImportRoutineButton() {
  const navigate = useNavigate();
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);
  const [preview, setPreview] = useState<RoutinePreview | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  async function choose() {
    setIsBusy(true);
    try {
      const path = await pickRoutineFile();
      if (path) setPreview(await inspectRoutineFile(path));
    } catch (cause) {
      toast.error("That routine could not be read", { description: String(cause) });
    } finally {
      setIsBusy(false);
    }
  }

  async function confirm() {
    if (!preview) return;
    setIsBusy(true);
    try {
      const created = await importRoutineFile(preview.path);
      await loadRoutines();
      setPreview(null);
      toast.success(`${created.name} imported`, {
        description: "Check its actions point at the right places, then save.",
      });
      navigate(`/routines/create?routine=${created.id}`);
    } catch (cause) {
      toast.error("Could not import the routine", { description: String(cause) });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" disabled={isBusy} onClick={() => void choose()}>
        <FileInput className="size-4" />
        Import shared routine
      </Button>

      <AlertDialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <AlertDialogContent>
          {preview && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <RoutineIcon icon={preview.icon} />
                  Import {preview.name}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {preview.description ??
                    `A routine with ${preview.actions.length} action${preview.actions.length === 1 ? "" : "s"}.`}{" "}
                  Nothing runs until you launch it.
                </AlertDialogDescription>
              </AlertDialogHeader>

              <ul className="flex max-h-72 flex-col gap-2 overflow-y-auto text-sm">
                {preview.actions.map((action, index) => (
                  <li key={index} className="flex items-start gap-2">
                    {action.note ? (
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                    ) : (
                      <Check className="mt-0.5 size-3.5 shrink-0 text-status-completed" aria-hidden />
                    )}
                    <div className="min-w-0">
                      <p className={cn("break-words", !action.enabled && "text-muted-foreground")}>
                        <span className="text-muted-foreground">
                          {ROUTINE_ACTION_TYPE_LABELS[action.type]}:
                        </span>{" "}
                        {action.type === "command" ? (
                          <code className="rounded bg-muted px-1 text-xs">{action.target}</code>
                        ) : (
                          actionLabel(action)
                        )}
                        {!action.enabled && " (off)"}
                      </p>
                      {action.note && <p className="text-xs text-muted-foreground">{action.note}</p>}
                    </div>
                  </li>
                ))}
              </ul>

              <AlertDialogFooter>
                <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={isBusy}
                  onClick={(event) => {
                    event.preventDefault();
                    void confirm();
                  }}
                >
                  {isBusy ? "Importing…" : "Import"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default ImportRoutineButton;
