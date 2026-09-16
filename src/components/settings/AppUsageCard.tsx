import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  clearAppUsage,
  getUsageTrackingEnabled,
  setUsageTrackingEnabled,
} from "@/services/tier5Service";

/**
 * Settings › Application usage (development-plan.md sections 37 and 68).
 *
 * The one setting on the page that makes the app watch something it was not
 * asked about directly, so it is off until switched on and the card says
 * exactly what is recorded: which program is in front, by hour, while you are
 * not idle. No window titles, no documents, no websites, and nothing leaves
 * the computer — not even through the sync folder, which leaves usage out.
 *
 * Section 37's warning is repeated where the numbers are shown (Progress ›
 * App usage): this is usage time, not productivity time.
 */
function AppUsageCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isConfirmingClear, setIsConfirmingClear] = useState(false);

  useEffect(() => {
    let current = true;
    getUsageTrackingEnabled()
      .then((value) => current && setEnabled(value))
      .catch((cause) => {
        if (!current) return;
        setEnabled(false);
        toast.error("Could not read the usage setting", { description: String(cause) });
      });
    return () => {
      current = false;
    };
  }, []);

  async function apply(next: boolean) {
    setIsSaving(true);
    try {
      setEnabled(await setUsageTrackingEnabled(next));
    } catch (cause) {
      toast.error("Could not change the usage setting", { description: String(cause) });
    } finally {
      setIsSaving(false);
    }
  }

  async function handleClear() {
    try {
      await clearAppUsage();
      toast.success("Usage history deleted");
    } catch (cause) {
      toast.error("Could not delete the usage history", { description: String(cause) });
    } finally {
      setIsConfirmingClear(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Application usage</CardTitle>
        <CardDescription>
          See which programs you spend time in, under Progress › App usage. When on, Routine
          Launcher notes the program in front of you each few seconds while you are active. It never
          reads window titles, documents or websites, keeps 90 days, and the history stays on this
          computer. Usage time is not productivity time, and nothing else in the app treats it as
          such.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="usage-tracking">Record application usage</Label>
          {enabled === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="usage-tracking"
              checked={enabled}
              disabled={isSaving}
              onCheckedChange={(next) => void apply(next)}
            />
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link to="/progress/app-usage">View usage</Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setIsConfirmingClear(true)}>
            Delete usage history
          </Button>
        </div>
      </CardContent>

      <AlertDialog open={isConfirmingClear} onOpenChange={setIsConfirmingClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all usage history?</AlertDialogTitle>
            <AlertDialogDescription>
              Every recorded minute is removed. Recording carries on if it is switched on. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleClear()}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default AppUsageCard;
