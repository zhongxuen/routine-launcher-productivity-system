import { useCallback, useEffect, useState } from "react";
import { CalendarPlus, Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { parseTimestamp } from "@/lib/task-utils";
import {
  clearCalendarFeed,
  clearCalendarFile,
  exportTasksCalendar,
  getCalendarStatus,
  importCalendarFile,
  pickCalendarFile,
  pickTasksCalendarDestination,
  refreshCalendarFeed,
  setCalendarFeed,
} from "@/services/tier5Service";
import type { CalendarStatus } from "@/types/tier5";

function when(timestamp: string | null): string {
  const date = parseTimestamp(timestamp);
  return date ? date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
}

const events = (count: number) => `${count.toLocaleString()} event${count === 1 ? "" : "s"}`;

/**
 * Settings › Calendar — development-plan.md sections 53 and 92's calendar
 * integration. Read-only in, file out:
 *
 * - **Feed.** Paste the private iCal (`.ics`) address a calendar service
 *   gives out; it is read now, at start-up and every six hours, and its events
 *   appear on Tasks › Today. It is the only address this card ever fetches.
 * - **File.** Import an `.ics` file once, for a calendar with no feed.
 * - **Export.** Open tasks with a due date, as an `.ics` any calendar imports.
 *
 * Nothing here writes to a calendar or turns an event into a task.
 */
function CalendarCard() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [feedUrl, setFeedUrl] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await getCalendarStatus();
      setStatus(next);
      setFeedUrl(next.feedUrl ?? "");
    } catch (cause) {
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<CalendarStatus>, success?: string) {
    setIsBusy(true);
    try {
      const next = await action();
      setStatus(next);
      setFeedUrl(next.feedUrl ?? "");
      setError(null);
      if (success) toast.success(success);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsBusy(false);
    }
  }

  async function importFile() {
    const path = await pickCalendarFile();
    if (path) await run(() => importCalendarFile(path), "Calendar imported");
  }

  async function exportTasks() {
    setIsBusy(true);
    try {
      const path = await pickTasksCalendarDestination();
      if (!path) return;
      const count = await exportTasksCalendar(path);
      toast.success("Tasks exported", {
        description: `${count} task${count === 1 ? "" : "s"} with a due date written to ${path}`,
      });
    } catch (cause) {
      toast.error("Could not export tasks", { description: String(cause) });
    } finally {
      setIsBusy(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Calendar</CardTitle>
        <CardDescription>
          Show your calendar's events beside the day's tasks on Tasks › Today. Routine Launcher only
          reads the calendar; it never changes it. Times with a time zone are shown as written, in
          this computer's time. Set up on each computer you use: the calendar is not part of Sync.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="calendar-feed">Calendar feed address (iCal / .ics)</Label>
          <div className="flex gap-2">
            <Input
              id="calendar-feed"
              type="url"
              placeholder="https://calendar.example.com/private/basic.ics"
              value={feedUrl}
              onChange={(event) => setFeedUrl(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={isBusy || !feedUrl.trim() || feedUrl.trim() === status?.feedUrl}
              onClick={() => void run(() => setCalendarFeed(feedUrl), "Calendar feed saved")}
            >
              Save
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            In Google Calendar: Settings › your calendar › "Secret address in iCal format". In
            Outlook: Settings › Calendar › Shared calendars › Publish a calendar (ICS link). Keep it
            private — anyone with the address can read the calendar.
          </p>
          {status?.feedUrl && (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <span>
                {events(status.feedEvents)}
                {status.feedRefreshedAt ? ` · updated ${when(status.feedRefreshedAt)}` : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                onClick={() => void run(() => refreshCalendarFeed(), "Calendar refreshed")}
              >
                <RefreshCw aria-hidden />
                Refresh
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={isBusy}
                onClick={() => void run(() => clearCalendarFeed(), "Calendar feed removed")}
              >
                Remove
              </Button>
            </div>
          )}
          {status?.feedError && <InlineError message={status.feedError} />}
        </div>

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">Calendar file</p>
            <p className="text-sm text-muted-foreground">
              {status?.fileName
                ? `${status.fileName} · ${events(status.fileEvents)} · imported ${when(status.fileImportedAt)}`
                : "Import an .ics file exported from any calendar. Importing again replaces it."}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" disabled={isBusy} onClick={() => void importFile()}>
              <CalendarPlus aria-hidden />
              Import
            </Button>
            {status?.fileName && (
              <Button
                variant="ghost"
                disabled={isBusy}
                onClick={() => void run(() => clearCalendarFile(), "Calendar file removed")}
              >
                Remove
              </Button>
            )}
          </div>
        </div>

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Export tasks</p>
            <p className="text-sm text-muted-foreground">
              Open tasks with a due date, as a calendar file you can import into any calendar.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={isBusy}
            onClick={() => void exportTasks()}
            className="shrink-0"
          >
            <Download aria-hidden />
            Export
          </Button>
        </div>

        {error && <InlineError message={error} onDismiss={() => setError(null)} />}
      </CardContent>
    </Card>
  );
}

export default CalendarCard;
