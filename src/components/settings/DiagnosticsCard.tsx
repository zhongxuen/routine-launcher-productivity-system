import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getLogLocation, openLogFolder, type LogLocation } from "@/services/diagnosticsService";

/** `524288` as `512 KB`, for the sentence describing rotation. */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Where the crash log is, and the button that opens it
 * (development-plan.md section 85).
 *
 * It sits next to About because it answers the other half of the same
 * question: About says which build this is, and this says where to look when
 * that build misbehaved. Both are what you read out to somebody helping you.
 *
 * The description is as much of the point as the path. A log file is the one
 * feature in a local-only app that users reasonably assume is being uploaded
 * somewhere — every other program they have installed does exactly that — so
 * the card says plainly that it is not, and how much disk it will ever take.
 * Section 68's promise is only worth having if the user can tell it is being
 * kept.
 */
function DiagnosticsCard() {
  const [location, setLocation] = useState<LogLocation | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getLogLocation()
      .then((value) => {
        if (isCurrent) setLocation(value);
      })
      .catch(() => {
        // No toast, for the same reason as the About card: nobody opened
        // Settings to be told this, and nothing else on the page needs it.
        if (isCurrent) setFailed(true);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function reveal() {
    try {
      await openLogFolder();
    } catch (cause) {
      toast.error("Could not open the log folder", { description: String(cause) });
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Diagnostics</CardTitle>
        <CardDescription>
          When something goes wrong, Routine Launcher writes what happened to a file on this
          computer. It is never sent anywhere &mdash; there is nothing in the app that could
          send it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {failed ? (
          <p className="text-sm text-muted-foreground">
            Logging could not be started on this machine, so there is no log file to show.
          </p>
        ) : location === null ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Log file</span>
              <code className="select-text break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                {location.file}
              </code>
            </div>
            <p className="text-xs text-muted-foreground">
              The file is kept to {formatSize(location.maxFileBytes)}; older entries move into{" "}
              {location.keptFiles - 1} numbered copies beside it and the oldest is deleted, so
              the folder never grows past {formatSize(location.maxFileBytes * location.keptFiles)}
              .
            </p>
            <div>
              <Button size="sm" variant="outline" onClick={() => void reveal()}>
                Open log folder
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default DiagnosticsCard;
