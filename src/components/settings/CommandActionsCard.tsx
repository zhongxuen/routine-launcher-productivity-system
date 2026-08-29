import { useEffect, useState } from "react";
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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  getCommandActionsEnabled,
  setCommandActionsEnabled,
} from "@/services/routineService";

/**
 * The command-action opt-in from development-plan.md section 66.
 *
 * A routine can contain a `command` action from the day it is built, but the
 * backend reports it as `skipped` until this switch is on — which is why the
 * builder's command rows point here. Without this card the setting would be
 * unreachable and those actions could never run at all.
 *
 * Turning it *on* asks first, because it is the one setting in the app that
 * widens what a routine is allowed to do. Turning it off does not: a kill
 * switch that argues with you is not a kill switch. Nothing is deleted
 * either way — the actions stay saved and simply stop running.
 */
function CommandActionsCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isConfirming, setIsConfirming] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getCommandActionsEnabled()
      .then((value) => {
        if (isCurrent) setEnabled(value);
      })
      .catch((cause) => {
        if (!isCurrent) return;
        // Failing closed is the safe reading: if we cannot tell whether
        // commands are allowed, show them as not allowed.
        setEnabled(false);
        toast.error("Could not read the command-action setting", {
          description: String(cause),
        });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function apply(next: boolean) {
    setIsSaving(true);
    try {
      setEnabled(await setCommandActionsEnabled(next));
      setIsConfirming(false);
      toast.success(next ? "Command actions enabled" : "Command actions turned off");
    } catch (cause) {
      toast.error("Could not change the setting", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Command actions</CardTitle>
        <CardDescription>
          Lets routines run shell commands. Off by default. The exact command is always shown on
          the launch panel, whether it ran or not, and commands that would format a drive, delete
          a tree or shut the machine down are refused outright.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="command-actions">Allow routines to run commands</Label>
          {enabled === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="command-actions"
              checked={enabled}
              disabled={isSaving}
              onCheckedChange={(next) => {
                if (next) setIsConfirming(true);
                else void apply(false);
              }}
            />
          )}
        </div>
      </CardContent>

      <AlertDialog open={isConfirming} onOpenChange={setIsConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Let routines run shell commands?</AlertDialogTitle>
            <AlertDialogDescription>
              Every command action in every routine will run when its routine launches, in a
              console window, exactly as typed. Turn this back off at any time to stop them
              without editing a single routine.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving}
              onClick={(event) => {
                // Saving is async, so the dialog closes when it succeeds
                // rather than on the click that started it.
                event.preventDefault();
                void apply(true);
              }}
            >
              {isSaving ? "Enabling…" : "Enable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default CommandActionsCard;
