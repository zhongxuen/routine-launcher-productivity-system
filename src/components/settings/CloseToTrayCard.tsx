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
import { getMinimizeToTray, setMinimizeToTray } from "@/services/trayService";

/**
 * The close-to-tray opt-out from development-plan.md section 27.
 *
 * The tray is meant to be "the fastest access point", which it can only be if
 * the app is still running to be accessed — so closing the main window hides
 * it by default and Exit on the tray menu is the way out. That is a real
 * change to what the ✕ button means, and not everybody wants it, so it is a
 * switch rather than a rule.
 *
 * Turning it off does not remove the tray: the icon and its menu are there
 * for as long as the app is, and Exit still quits. It only makes closing the
 * window quit too, the way an app without a tray behaves.
 *
 * Unlike the command-action switch next to it, neither direction asks for
 * confirmation. Nothing here widens what the app may do — it changes where a
 * window goes — and both settings are one click from being changed back.
 */
function CloseToTrayCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getMinimizeToTray()
      .then((value) => {
        if (isCurrent) setEnabled(value);
      })
      .catch((cause) => {
        if (!isCurrent) return;
        // The backend's own default, so the switch shows what the app is
        // actually doing even when the read failed.
        setEnabled(true);
        toast.error("Could not read the tray setting", { description: String(cause) });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function apply(next: boolean) {
    setIsSaving(true);
    try {
      setEnabled(await setMinimizeToTray(next));
      toast.success(
        next ? "Closing the window keeps the app in the tray" : "Closing the window quits the app",
      );
    } catch (cause) {
      toast.error("Could not change the setting", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>System tray</CardTitle>
        <CardDescription>
          The tray icon shows today&apos;s progress, your most-used routines and quick actions.
          Left-click it for the compact popup, right-click for the menu, and use Exit there to
          quit.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="close-to-tray">Keep running in the tray when the window is closed</Label>
          {enabled === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="close-to-tray"
              checked={enabled}
              disabled={isSaving}
              onCheckedChange={(next) => void apply(next)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default CloseToTrayCard;
