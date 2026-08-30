import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { OPACITY_STOPS } from "@/components/widget/WidgetChrome";
import { cn } from "@/lib/utils";
import {
  dismissWidgetWindow,
  getWidgetSettings,
  onWidgetSettingsChanged,
  openWidgetWindow,
  setWidgetMode,
  setWidgetOpacity,
  setWidgetPinned,
  type WidgetMode,
  type WidgetSettings,
} from "@/services/widgetService";

/** Section 26's four layouts, in the order the plan lists them. */
const MODES: { value: WidgetMode; label: string; hint: string }[] = [
  { value: "task", label: "Tasks", hint: "Today's list and how much of it is done" },
  { value: "focus", label: "Focus", hint: "The running session's countdown and controls" },
  { value: "routine", label: "Routines", hint: "Your routines as one-click launches" },
  { value: "combined", label: "Combined", hint: "Today's tasks with the timer underneath" },
];

/**
 * The desktop widget's home in Settings (development-plan.md sections 26, 83).
 *
 * Section 83 asks for the widget to be "completely optional", and this is
 * where that is true rather than merely claimed: the switch is off on a fresh
 * install, nothing else in the app turns it on, and `services::widget::restore`
 * only ever puts the widget back because the switch was on when the app last
 * closed. A user who never opens this card never sees the widget.
 *
 * **The switch is the widget's visibility, not a second flag above it.** It
 * could have been a feature gate with show/hide underneath, but that buys a
 * state — enabled and invisible — that nothing on screen could explain, and
 * two switches the user has to get right instead of one. So the ✕ on the
 * widget, "Hide Widget" on the tray menu and this switch are three handles on
 * the same stored value, and all three agree the moment any of them is used:
 * every write announces itself and this card re-reads. That is the same
 * mirroring `onWidgetSettingsChanged` exists for, and why pin and opacity are
 * here at all when the widget already carries them.
 *
 * **Turning it off hides a window and nothing else.** The widget reads the
 * same stores as the main window and owns none of them, so what stops when it
 * goes away is the drawing: tasks stay as they are, a focus session keeps
 * running and keeps counting in the main window, and no routine is disturbed.
 * The widget is a second view of the app, never a part of it.
 *
 * The layout picker is the one control with no twin in the widget's own
 * chrome — a four-way choice does not fit in a 300px window, and it is not
 * something you change while working. It stays usable while the widget is
 * off, so the thing can be set up before it is ever put on screen.
 */
function DesktopWidgetCard() {
  const [settings, setSettings] = useState<WidgetSettings | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** False once unmounted, so a slow read cannot set state afterwards. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const stored = await getWidgetSettings();
      if (mounted.current) setSettings(stored);
    } catch (cause) {
      if (!mounted.current) return;
      // Nothing is known about the widget, so nothing is claimed about it:
      // the card stays in its loading state rather than showing an "off"
      // switch that might be a lie about a widget currently on screen.
      toast.error("Could not read the widget settings", { description: String(cause) });
    }
  }, []);

  useEffect(() => {
    void load();

    // The widget's own ✕, its pin and opacity buttons, and the tray's
    // Show/Hide entry all write the same values this card shows. This is how
    // it finds out — the announce-and-re-read of `src/lib/window-sync.ts`.
    const changed = onWidgetSettingsChanged(() => void load());
    return () => {
      void changed.then((unlisten) => unlisten());
    };
  }, [load]);

  /**
   * Runs one change, then re-reads.
   *
   * Every write is answered by Rust with what was actually stored — a clamped
   * opacity, the mode that was set — but the card shows seven values that can
   * all move at once (showing the widget for the first time places it), so it
   * asks for the lot rather than patching in the one it heard about.
   */
  async function apply(change: () => Promise<unknown>, failure: string) {
    setIsSaving(true);
    try {
      await change();
      await load();
    } catch (cause) {
      toast.error(failure, { description: String(cause) });
      // Whatever the failure was, the stored settings are the truth about it.
      await load();
    } finally {
      if (mounted.current) setIsSaving(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Desktop widget</CardTitle>
        <CardDescription>
          A small always-on-top window that stays visible while you work in other apps. It is
          off until you ask for it, and it comes back where you left it. Drag it anywhere, pull
          the bottom-right corner to resize, and close it with its own ✕ or from the tray menu —
          closing it never touches your tasks or a running focus session.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="widget-enabled">Enable desktop widget</Label>
          {settings === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="widget-enabled"
              checked={settings.visible}
              disabled={isSaving}
              onCheckedChange={(next) =>
                void apply(
                  () => (next ? openWidgetWindow() : dismissWidgetWindow()),
                  next ? "Could not open the widget" : "Could not hide the widget",
                )
              }
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="widget-mode">Layout</Label>
            <p className="text-xs text-muted-foreground">
              {MODES.find((mode) => mode.value === settings?.mode)?.hint ?? " "}
            </p>
          </div>
          {settings === null ? (
            <Skeleton className="h-9 w-40" />
          ) : (
            <Select
              value={settings.mode}
              disabled={isSaving}
              onValueChange={(value) =>
                void apply(
                  () => setWidgetMode(value as WidgetMode),
                  "Could not change the widget layout",
                )
              }
            >
              <SelectTrigger id="widget-mode" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((mode) => (
                  <SelectItem key={mode.value} value={mode.value}>
                    {mode.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="widget-pinned">Keep in front of other windows</Label>
          {settings === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="widget-pinned"
              checked={settings.pinned}
              disabled={isSaving}
              onCheckedChange={(next) =>
                void apply(() => setWidgetPinned(next), "Could not pin the widget")
              }
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <Label id="widget-opacity-label">Opacity</Label>
          {settings === null ? (
            <Skeleton className="h-8 w-52" />
          ) : (
            <OpacityStops
              opacity={settings.opacity}
              disabled={isSaving}
              onPick={(value) =>
                void apply(() => setWidgetOpacity(value), "Could not change the widget opacity")
              }
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

interface OpacityStopsProps {
  opacity: number;
  disabled: boolean;
  onPick: (opacity: number) => void;
}

/**
 * The same five stops the widget's own opacity button cycles through, laid
 * out as a row rather than as one button that steps.
 *
 * The stops are imported rather than repeated: a Settings control offering a
 * value the widget's own control would never land on is how the two would
 * drift apart. What differs is the gesture, and only because the room does —
 * there is space here to show all five and pick one directly, where in a
 * 300px window there was only ever space for one button.
 */
function OpacityStops({ opacity, disabled, onPick }: OpacityStopsProps) {
  return (
    <div
      role="group"
      aria-labelledby="widget-opacity-label"
      className="flex items-center gap-1 rounded-md border p-0.5"
    >
      {OPACITY_STOPS.map((stop) => {
        // The stored value is a number, not a member of this list — it may
        // have been clamped, or written by an older build — so the button
        // that is *nearest* is the one shown as chosen.
        const current = Math.abs(stop - opacity) < 0.075;

        return (
          <button
            key={stop}
            type="button"
            disabled={disabled}
            aria-pressed={current}
            onClick={() => onPick(stop)}
            className={cn(
              "rounded px-2 py-1 text-xs transition-colors",
              "disabled:opacity-50",
              current
                ? "bg-secondary font-medium text-secondary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {Math.round(stop * 100)}%
          </button>
        );
      })}
    </div>
  );
}

export default DesktopWidgetCard;
