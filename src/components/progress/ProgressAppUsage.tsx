import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { AppWindow } from "lucide-react";

import ErrorState from "@/components/common/states/ErrorState";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { shortDate, weekdayInitial, weekdayName } from "@/lib/analytics-utils";
import { actionLabel, formatFocusTime } from "@/lib/routine-utils";
import { cn } from "@/lib/utils";
import { getAppUsage } from "@/services/tier5Service";
import type { AppUsageSummary } from "@/types/tier5";

const RANGES = [
  { days: 1, label: "Today" },
  { days: 7, label: "7 days" },
  { days: 30, label: "30 days" },
] as const;

/** `Code.exe` as "VS Code", the same name a routine action would show. */
function appName(name: string, path: string | null): string {
  return actionLabel({ type: "application", target: path ?? name });
}

/**
 * Progress › App usage — development-plan.md section 37's list:
 *
 * ```text
 * APPLICATION USAGE
 *
 * VS Code       3h 42m
 * Chrome        2h 10m
 * ```
 *
 * with the section's warning as the first line under the heading, because it
 * is the one thing this page must not be mistaken for: this is how long a
 * program was in front of you, not how productive that time was. Nothing
 * here feeds the XP, the streak or the Statistics tab.
 *
 * Off until switched on in Settings. Before that the page says so and links
 * there, rather than drawing an empty chart that looks like a day of nothing.
 */
function ProgressAppUsage() {
  const [days, setDays] = useState<number>(7);
  const [summary, setSummary] = useState<AppUsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getAppUsage(days)
      .then((next) => !cancelled && setSummary(next))
      .catch((cause) => !cancelled && setError(String(cause)));
    return () => {
      cancelled = true;
    };
  }, [days, attempt]);

  const busiest = summary ? Math.max(1, ...summary.days.map((day) => day.seconds)) : 1;
  const topSeconds = summary?.apps[0]?.seconds ?? 1;

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            APPLICATION USAGE
          </p>
          <p className="text-sm text-muted-foreground">
            How long each program was in front of you while you were active. Usage time is not
            productivity time.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Range">
          {RANGES.map((range) => (
            <Button
              key={range.days}
              size="sm"
              variant={days === range.days ? "default" : "outline"}
              aria-pressed={days === range.days}
              onClick={() => setDays(range.days)}
            >
              {range.label}
            </Button>
          ))}
        </div>
      </header>

      {error ? (
        <ErrorState title="Usage could not be read" message={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : !summary ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {!summary.trackingEnabled && (
            <Card className="flex flex-row flex-wrap items-center justify-between gap-3 px-5 py-4">
              <p className="text-sm">
                Recording is off.{" "}
                {summary.apps.length > 0 ? "What is below was recorded earlier." : "Nothing has been recorded."}
              </p>
              <Button size="sm" variant="outline" asChild>
                <Link to="/settings">Turn on in Settings</Link>
              </Button>
            </Card>
          )}

          <Card className="gap-4 px-5 py-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-muted-foreground">
                {days === 1 ? "Today" : `${shortDate(summary.from)} – ${shortDate(summary.to)}`}
              </p>
              <p className="text-lg font-semibold tabular-nums">
                {summary.totalSeconds > 0 ? formatFocusTime(summary.totalSeconds) : "—"}
              </p>
            </div>

            {days > 1 && (
              <div className="flex h-24 items-end gap-1" aria-hidden>
                {summary.days.map((day) => (
                  <div key={day.date} className="flex flex-1 flex-col items-center gap-1">
                    <div
                      className={cn(
                        "w-full rounded-sm bg-primary/70",
                        day.seconds === 0 && "bg-muted",
                      )}
                      style={{ height: `${Math.max(2, (day.seconds / busiest) * 80)}px` }}
                      title={`${weekdayName(day.date)} ${shortDate(day.date)}: ${
                        day.seconds > 0 ? formatFocusTime(day.seconds) : "nothing recorded"
                      }`}
                    />
                    {days <= 7 && (
                      <span className="text-[10px] text-muted-foreground">{weekdayInitial(day.date)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {summary.apps.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No application usage recorded for this range.
              </p>
            ) : (
              <ul className="flex flex-col gap-3">
                {summary.apps.map((app) => (
                  <li key={app.appName} className="flex flex-col gap-1">
                    <div className="flex items-center gap-2 text-sm">
                      <AppWindow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate" title={app.exePath ?? app.appName}>
                        {appName(app.appName, app.exePath)}
                      </span>
                      <span className="tabular-nums">{formatFocusTime(app.seconds)}</span>
                    </div>
                    <div className="ml-6 h-1.5 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/60"
                        style={{ width: `${(app.seconds / topSeconds) * 100}%` }}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

export default ProgressAppUsage;
