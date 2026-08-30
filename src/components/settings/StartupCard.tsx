import { useEffect, useState } from "react";
import { toast } from "sonner";

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
import { getLaunchAtStartup, setLaunchAtStartup } from "@/services/appService";

/**
 * The launch-at-startup option from development-plan.md section 85.
 *
 * An app built around routines and reminders is only useful while it is
 * running — a reminder that arrives when you happen to have opened the app is
 * a reminder for someone who did not need one. So starting with Windows is
 * the setting that makes the tray, the global shortcut and the reminder
 * scheduler worth having, and it sits next to the tray card for that reason.
 *
 * Two things are worth knowing about the switch itself.
 *
 * It is **read from the registry**, not from this app's settings table, so it
 * shows what Windows will actually do. A user who turned the app off in Task
 * Manager's Startup tab sees it off here the next time they look, rather than
 * seeing a stale "on" and wondering which one is lying.
 *
 * And it **trusts the answer over the request**. The backend re-reads the
 * registry after writing it, so a machine that refused the change — a managed
 * `Run` key, a locked-down profile — leaves the switch where it really is
 * instead of where it was clicked.
 */
function StartupCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [readFailed, setReadFailed] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getLaunchAtStartup()
      .then((value) => {
        if (!isCurrent) return;
        setEnabled(value);
        setReadFailed(false);
      })
      .catch((cause) => {
        if (!isCurrent) return;
        // Unlike the other switches on this page there is no sensible default
        // to fall back on: whether Windows starts the app is a fact about the
        // machine, and guessing at it would be the one answer that cannot be
        // checked. So the switch is shown off and disabled, and says why.
        setEnabled(false);
        setReadFailed(true);
        toast.error("Could not read the Windows startup setting", {
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
      const stored = await setLaunchAtStartup(next);
      setEnabled(stored);

      if (stored === next) {
        toast.success(
          next
            ? "Routine Launcher will start with Windows"
            : "Routine Launcher will no longer start with Windows",
        );
      } else {
        // The write was accepted and changed nothing — almost always a `Run`
        // key someone else owns. Worth saying plainly, because the switch
        // snapping back on its own looks like a bug otherwise.
        toast.error("Windows did not accept the change", {
          description: "The startup entry is managed elsewhere on this machine.",
        });
      }
    } catch (cause) {
      toast.error("Could not change the startup setting", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Start-up</CardTitle>
        <CardDescription>
          Start Routine Launcher when you sign in to Windows. It opens straight into the tray
          rather than onto your screen, so reminders, the quick launcher shortcut and today&apos;s
          progress are there from the moment you sit down.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="launch-at-startup">Launch at Windows start-up</Label>
          {enabled === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="launch-at-startup"
              checked={enabled}
              disabled={isSaving || readFailed}
              onCheckedChange={(next) => void apply(next)}
            />
          )}
        </div>
        {readFailed ? (
          <p className="text-sm text-muted-foreground">
            Windows would not say whether the start-up entry exists, so this cannot be changed
            from here. You can add or remove it yourself in Task Manager &rsaquo; Start-up apps.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export default StartupCard;
