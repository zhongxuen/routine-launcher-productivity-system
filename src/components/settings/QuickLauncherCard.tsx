import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { formatAccelerator, recordShortcut } from "@/lib/shortcut-accelerator";
import { cn } from "@/lib/utils";
import {
  getQuickLauncherShortcut,
  openQuickLauncher,
  resetQuickLauncherShortcut,
  setQuickLauncherShortcut,
} from "@/services/quickLauncherService";

/** Section 28's own example, and what Reset puts back. */
const DEFAULT_SHORTCUT = "Ctrl+Alt+Space";

/**
 * The configurable shortcut of development-plan.md section 28.
 *
 * Section 28 asks for "a configurable shortcut", and the only sane way to
 * configure one is to press it — so Change turns the field into a recorder
 * and the next combination the user holds down becomes the binding. Typing an
 * accelerator into a text box would mean learning that the Windows key is
 * spelled `Super` and that the space bar is spelled `Space`, which is a thing
 * this card knows and the user should not have to.
 *
 * **Refusals are shown while the keys are still down.** `recordShortcut`
 * applies the same rule the backend does — a global hotkey needs Ctrl, Alt or
 * Win, or it would take an ordinary keystroke away from every program on the
 * machine — so pressing `Shift+P` says so immediately instead of being
 * accepted here and rejected a round trip later. The backend still checks;
 * this is the explanation, not the guard.
 *
 * **A binding that cannot be taken changes nothing.** The commonest failure
 * is another program already holding the combination, and the backend answers
 * that by leaving the previous shortcut registered and storing nothing. So
 * the card puts the old binding back on screen and says why, rather than
 * showing a shortcut that does not work.
 */
function QuickLauncherCard() {
  const [shortcut, setShortcut] = useState<string | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  /** Why the last keystroke or the last save was refused. */
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let isCurrent = true;

    void getQuickLauncherShortcut()
      .then((value) => {
        if (isCurrent) setShortcut(value);
      })
      .catch((cause) => {
        if (!isCurrent) return;
        // The binding is registered by the backend at startup whatever this
        // read does, so the shortcut still works; it is only unshowable.
        setShortcut(DEFAULT_SHORTCUT);
        toast.error("Could not read the current shortcut", { description: String(cause) });
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  const save = useCallback(
    async (next: () => Promise<string>, previous: string | null) => {
      setIsSaving(true);
      setProblem(null);
      try {
        const bound = await next();
        setShortcut(bound);
        toast.success("Quick launcher shortcut updated", {
          description: formatAccelerator(bound).join(" + "),
        });
      } catch (cause) {
        // Nothing changed on the backend, so nothing changes here either.
        setShortcut(previous);
        setProblem(String(cause));
      } finally {
        setIsSaving(false);
        setIsRecording(false);
      }
    },
    [],
  );

  function handleRecordingKey(event: React.KeyboardEvent<HTMLButtonElement>) {
    // Every key while recording belongs to the recording, including the ones
    // the button would otherwise treat as a click.
    event.preventDefault();
    event.stopPropagation();

    const recorded = recordShortcut(event.nativeEvent);

    switch (recorded.status) {
      case "pending":
        return;
      case "cancelled":
        setIsRecording(false);
        setProblem(null);
        return;
      case "rejected":
        setProblem(recorded.reason);
        return;
      case "recorded":
        void save(() => setQuickLauncherShortcut(recorded.accelerator), shortcut);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Quick launcher</CardTitle>
        <CardDescription>
          A shortcut that works anywhere in Windows, even with the app closed to the tray. It
          opens a search box over whatever you are doing: type to filter your routines, arrow keys
          and Enter to run one, Escape to dismiss it.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="quick-launcher-shortcut">Shortcut</Label>

          {shortcut === null ? (
            <Skeleton className="h-8 w-40" />
          ) : (
            <div className="flex items-center gap-2">
              <button
                id="quick-launcher-shortcut"
                type="button"
                disabled={isSaving}
                onClick={() => {
                  setProblem(null);
                  setIsRecording(true);
                }}
                onKeyDown={isRecording ? handleRecordingKey : undefined}
                // Recording ends when the field stops being the thing the
                // keyboard is pointed at; otherwise a user who clicked away
                // would rebind the shortcut with their next keystroke.
                onBlur={() => setIsRecording(false)}
                aria-describedby={problem ? "quick-launcher-problem" : undefined}
                className={cn(
                  "flex h-8 min-w-40 items-center justify-center gap-1 rounded-md border px-3 text-sm",
                  isRecording
                    ? "border-ring text-muted-foreground"
                    : "hover:bg-accent/50 disabled:opacity-50",
                )}
              >
                {isRecording ? (
                  "Press a combination…"
                ) : (
                  <ShortcutKeys accelerator={shortcut} />
                )}
              </button>

              <Button
                size="sm"
                variant="ghost"
                disabled={isSaving || shortcut === DEFAULT_SHORTCUT}
                onClick={() => void save(resetQuickLauncherShortcut, shortcut)}
              >
                Reset
              </Button>
            </div>
          )}
        </div>

        {problem && (
          <p id="quick-launcher-problem" className="text-sm text-priority-urgent">
            {problem}
          </p>
        )}

        {/* The launcher is otherwise only reachable by the shortcut, which is
            no help at all to someone whose shortcut has just been refused —
            and no help either to someone who wants to see what the thing they
            are binding actually looks like. */}
        <div>
          <Button size="sm" variant="outline" onClick={() => void openLauncher()}>
            Open quick launcher
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** The binding as key caps: `Ctrl+Alt+Space` becomes `Ctrl` `Alt` `Space`. */
function ShortcutKeys({ accelerator }: { accelerator: string }) {
  return (
    <>
      {formatAccelerator(accelerator).map((key, position) => (
        <span key={`${key}-${position}`} className="flex items-center gap-1">
          {position > 0 && <span className="text-muted-foreground">+</span>}
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-sans text-xs">{key}</kbd>
        </span>
      ))}
    </>
  );
}

async function openLauncher() {
  try {
    await openQuickLauncher();
  } catch (cause) {
    toast.error("Could not open the quick launcher", { description: String(cause) });
  }
}

export default QuickLauncherCard;
