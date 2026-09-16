import { useEffect, useState } from "react";
import { CalendarDays, MapPin } from "lucide-react";

import { formatDueTime } from "@/lib/task-utils";
import { listCalendarEvents } from "@/services/tier5Service";
import type { CalendarEvent } from "@/types/tier5";

interface CalendarEventsSectionProps {
  /** The local date on screen, `YYYY-MM-DD`. */
  dayKey: string;
}

/** "9:30 AM – 10:15 AM", "9:30 AM", or "All day". */
function eventTime(event: CalendarEvent): string {
  if (event.allDay) return "All day";
  const start = formatDueTime(event.startTime);
  const end = formatDueTime(event.endTime);
  return end ? `${start} – ${end}` : (start ?? "");
}

/**
 * The day's calendar events on Tasks > Today (development-plan.md sections
 * 53 and 92's calendar integration).
 *
 * Read-only, and kept apart from the tasks under its own heading with a
 * calendar glyph where a checkbox would be: an event is something the day
 * already holds, not something to tick off, and section 54 keeps this app
 * from turning into the calendar itself. It exists so the time a meeting
 * takes is visible while the tasks are being planned around it.
 *
 * Draws nothing at all when there are no events, which is also what someone
 * who never connected a calendar sees.
 */
function CalendarEventsSection({ dayKey }: CalendarEventsSectionProps) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      listCalendarEvents(dayKey)
        .then((next) => {
          if (!cancelled) setEvents(next);
        })
        // The tasks are the page; a calendar that could not be read is not
        // worth an error in the middle of them.
        .catch((cause: unknown) => console.warn("Could not read calendar events", cause));

    void load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [dayKey]);

  if (events.length === 0) return null;

  return (
    <section aria-labelledby="calendar-events-heading" className="flex flex-col gap-1">
      <h3
        id="calendar-events-heading"
        className="px-2 text-xs font-medium tracking-wide text-muted-foreground"
      >
        CALENDAR
      </h3>

      <ul className="flex flex-col">
        {events.map((event) => (
          <li key={event.id} className="flex items-start gap-3 rounded-md px-2 py-1.5">
            <CalendarDays aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="min-w-0 text-sm leading-6 text-foreground/80">{event.title}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {eventTime(event)}
                </span>
              </div>
              {event.location && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <MapPin className="size-3" aria-hidden />
                  {event.location}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default CalendarEventsSection;
