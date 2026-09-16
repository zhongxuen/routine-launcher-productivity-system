import { useEffect, useState } from "react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import RoutineIcon from "@/components/routines/RoutineIcon";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { formatLeadTime } from "@/services/notificationService";
import { useRoutineStore } from "@/stores/routineStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  MAX_DEFAULT_FOCUS_MINUTES,
  MIN_DEFAULT_FOCUS_MINUTES,
  QUEST_COUNTS,
  REMINDER_LEAD_TIMES,
  WEEK_STARTS,
  WEEK_START_LABELS,
  type DailySettings,
  type WeekStart,
} from "@/types/settings";
import { TASK_PRIORITIES, TASK_PRIORITY_LABELS, type TaskPriority } from "@/types/task";

/** The selects' value for "no reminder" and "no routine" — Select cannot hold "". */
const NONE = "none";

/**
 * The form's copy of the settings. Everything is as it is sent except the
 * focus length, which is the text in its box: a length being retyped is
 * briefly not a number, and the box has to be allowed to say so.
 */
type Draft = Omit<DailySettings, "defaultFocusMinutes"> & { defaultFocusMinutes: string };

const toDraft = (settings: DailySettings): Draft => ({
  ...settings,
  defaultFocusMinutes: String(settings.defaultFocusMinutes),
});

const sameDraft = (a: Draft, b: Draft): boolean => JSON.stringify(a) === JSON.stringify(b);

const optionalId = (value: string): number | null => (value === NONE ? null : Number(value));
const optionalValue = (id: number | null): string => (id === null ? NONE : String(id));

/**
 * Daily — development-plan.md section 52's Daily Settings.
 *
 * ```text
 * Daily Settings
 *
 * Start of day:          09:00
 * Default focus:         50 minutes
 * Task reminder:         10 minutes before
 * Start-of-day routine:  ☀️ Start My Day
 * End-of-day routine:    🌙 End My Day
 * ```
 *
 * The one card on this page with a Save button. The others each hold a single
 * switch that stands on its own; these ten are checked together — the day
 * has to end after it starts — so they are edited as a form and stored in one
 * write, and a refusal is the backend's own sentence under the fields.
 *
 * Saved values reach their consumers through the settings store: Custom's
 * length in the focus timer, the quick-add form's priority, the reminder the
 * edit dialog suggests, the quests on the dashboard and the week on the
 * Statistics tab, the start-of-day routine to Start My Day (section 21), the
 * day's hours to Plan Today's time left (section 20), and the day's end and
 * the end-of-day routine to the end-of-day review (section 22), along with
 * the switch for its one notification.
 */
function DailySettingsCard() {
  const daily = useSettingsStore((state) => state.daily);
  const hasLoaded = useSettingsStore((state) => state.hasLoaded);
  const loadError = useSettingsStore((state) => state.loadError);
  const loadDaily = useSettingsStore((state) => state.loadDaily);
  const saveDaily = useSettingsStore((state) => state.saveDaily);

  const routines = useRoutineStore((state) => state.routines);
  const loadRoutines = useRoutineStore((state) => state.loadRoutines);

  const [isReading, setIsReading] = useState(true);
  /** What the form was last filled from — the stored settings it is an edit of. */
  const [baseline, setBaseline] = useState<DailySettings>(daily);
  const [draft, setDraft] = useState<Draft>(() => toDraft(daily));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isDirty = !sameDraft(draft, toDraft(baseline));

  // A read that lands — this card's own, or another window's save — refills
  // the form, unless the user is partway through changing it.
  if (daily !== baseline && !isDirty) {
    setBaseline(daily);
    setDraft(toDraft(daily));
  }

  useEffect(() => {
    // Fresh on every visit: the card is an edit of what is stored now.
    void loadDaily().finally(() => setIsReading(false));
    // The routine selects need the routines, and Settings may be the first
    // page this window has opened.
    if (useRoutineStore.getState().routines.length === 0) void loadRoutines();
  }, [loadDaily, loadRoutines]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!isDirty || isSaving) return;

    // Only the one thing the backend cannot be sent: a box that holds no
    // number. Whether the number is allowed is the backend's to say.
    const focusMinutes = Number(draft.defaultFocusMinutes.trim());
    if (draft.defaultFocusMinutes.trim() === "" || !Number.isInteger(focusMinutes)) {
      setError("Default focus length must be a whole number of minutes.");
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      const saved = await saveDaily({ ...draft, defaultFocusMinutes: focusMinutes });
      setBaseline(saved);
      setDraft(toDraft(saved));
      toast.success("Daily settings saved");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Daily</CardTitle>
        <CardDescription>
          How your day is set up: when it starts and ends, and what new tasks, focus sessions and
          the week start with.
        </CardDescription>
      </CardHeader>

      {!hasLoaded && isReading ? (
        <CardContent className="flex flex-col gap-3">
          {Array.from({ length: 5 }, (_, row) => (
            <Skeleton key={row} className="h-8 w-full" />
          ))}
        </CardContent>
      ) : (
        <form onSubmit={(event) => void handleSave(event)} className="flex flex-col gap-6">
          <CardContent className="flex flex-col gap-4">
            {loadError && !hasLoaded && (
              <p className="text-xs text-muted-foreground">
                Your saved settings could not be read, so these are the defaults. Saving will
                replace them.
              </p>
            )}

            <Group heading="Your day">
              <Row id="daily-start" label="Start of day">
                <Input
                  id="daily-start"
                  type="time"
                  className="w-32"
                  value={draft.dayStartTime}
                  onChange={(event) => update("dayStartTime", event.target.value)}
                />
              </Row>
              <Row id="daily-end" label="End of day">
                <Input
                  id="daily-end"
                  type="time"
                  className="w-32"
                  value={draft.dayEndTime}
                  onChange={(event) => update("dayEndTime", event.target.value)}
                />
              </Row>
              <Row id="daily-start-routine" label="Start-of-day routine">
                <RoutineSelect
                  id="daily-start-routine"
                  value={draft.startOfDayRoutineId}
                  routines={routines}
                  onChange={(id) => update("startOfDayRoutineId", id)}
                />
              </Row>
              <Row id="daily-end-routine" label="End-of-day routine">
                <RoutineSelect
                  id="daily-end-routine"
                  value={draft.endOfDayRoutineId}
                  routines={routines}
                  onChange={(id) => update("endOfDayRoutineId", id)}
                />
              </Row>
              <Row
                id="daily-end-notification"
                label="End-of-day notification"
                hint="One notification at the end of the day, offering the review."
              >
                <Switch
                  id="daily-end-notification"
                  checked={draft.endOfDayNotification}
                  onCheckedChange={(checked) => update("endOfDayNotification", checked)}
                />
              </Row>
              <p className="text-xs text-muted-foreground">
                Start My Day opens the start-of-day routine, then a 10-minute planning session.
                Plan Today, on Tasks &rsaquo; Today, sets your estimated work against the hours
                left in the day. From the end of the day, the dashboard offers Review My Day: the
                day's figures, the tasks still open, and End My Day to open the end-of-day routine.
                It never opens by itself.
              </p>
            </Group>

            <Separator />

            <Group heading="Defaults">
              <Row
                id="daily-focus"
                label="Default focus"
                hint="What the Custom timer starts at."
              >
                <div className="flex items-center gap-2">
                  <Input
                    id="daily-focus"
                    type="number"
                    inputMode="numeric"
                    min={MIN_DEFAULT_FOCUS_MINUTES}
                    max={MAX_DEFAULT_FOCUS_MINUTES}
                    className="w-20"
                    value={draft.defaultFocusMinutes}
                    onChange={(event) => update("defaultFocusMinutes", event.target.value)}
                  />
                  <span className="text-sm text-muted-foreground">minutes</span>
                </div>
              </Row>
              <Row id="daily-priority" label="Task priority" hint="What + Add Task starts on.">
                <Select
                  value={draft.defaultTaskPriority}
                  onValueChange={(value) => update("defaultTaskPriority", value as TaskPriority)}
                >
                  <SelectTrigger id="daily-priority" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TASK_PRIORITIES.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {TASK_PRIORITY_LABELS[priority]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row
                id="daily-reminder"
                label="Task reminder"
                hint="Suggested when you give a task its first due time."
              >
                <Select
                  value={optionalValue(draft.defaultReminderMinutes)}
                  onValueChange={(value) => update("defaultReminderMinutes", optionalId(value))}
                >
                  <SelectTrigger id="daily-reminder" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>None</SelectItem>
                    {REMINDER_LEAD_TIMES.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {formatLeadTime(minutes)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            </Group>

            <Separator />

            <Group heading="Progress">
              <Row id="daily-quests" label="Daily quests" hint="How many objectives a day shows.">
                <Select
                  value={String(draft.dailyQuestCount)}
                  onValueChange={(value) => update("dailyQuestCount", Number(value))}
                >
                  <SelectTrigger id="daily-quests" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {QUEST_COUNTS.map((count) => (
                      <SelectItem key={count} value={String(count)}>
                        {count} a day
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
              <Row
                id="daily-week-start"
                label="Week starts on"
                hint="Where This Week begins in Statistics."
              >
                <Select
                  value={draft.weekStart}
                  onValueChange={(value) => update("weekStart", value as WeekStart)}
                >
                  <SelectTrigger id="daily-week-start" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEK_STARTS.map((day) => (
                      <SelectItem key={day} value={day}>
                        {WEEK_START_LABELS[day]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Row>
            </Group>

            {error && <InlineError message={error} onDismiss={() => setError(null)} />}
          </CardContent>

          <CardFooter className="justify-end gap-2">
            {isDirty && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={() => {
                  setDraft(toDraft(baseline));
                  setError(null);
                }}
              >
                Discard changes
              </Button>
            )}
            <Button type="submit" size="sm" disabled={!isDirty || isSaving}>
              {isSaving ? "Saving…" : "Save"}
            </Button>
          </CardFooter>
        </form>
      )}
    </Card>
  );
}

/** A titled run of rows. */
function Group({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-3 text-xs font-medium tracking-widest text-muted-foreground uppercase">
        {heading}
      </legend>
      {children}
    </fieldset>
  );
}

/** One setting: its label (and a line on what it does) on the left, its control on the right. */
function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

/**
 * A routine, or none. A routine the list has not caught up with — a stored id
 * read before the routines were — is still named rather than drawn as a blank
 * trigger that reads as "none".
 */
function RoutineSelect({
  id,
  value,
  routines,
  onChange,
}: {
  id: string;
  value: number | null;
  routines: { id: number; name: string; icon: string | null }[];
  onChange: (id: number | null) => void;
}) {
  const isListed = value === null || routines.some((routine) => routine.id === value);

  return (
    <Select value={optionalValue(value)} onValueChange={(next) => onChange(optionalId(next))}>
      <SelectTrigger id={id} className="w-48">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>None</SelectItem>
        {routines.map((routine) => (
          <SelectItem key={routine.id} value={String(routine.id)}>
            <span className="flex min-w-0 items-center gap-2">
              <RoutineIcon icon={routine.icon} className="size-5 text-xs" />
              <span className="truncate">{routine.name}</span>
            </span>
          </SelectItem>
        ))}
        {!isListed && value !== null && (
          <SelectItem value={String(value)}>Routine #{value}</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

export default DailySettingsCard;
