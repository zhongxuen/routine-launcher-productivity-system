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
import { formatBytes, groupingSummary, totalBytes } from "@/lib/screenshot-utils";
import { useScreenshotStore } from "@/stores/screenshotStore";
import type { Screenshot } from "@/types/screenshot";

/** How many filenames the dialog lists before it starts counting instead. */
const NAMES_SHOWN = 6;

/**
 * Step four of development-plan.md section 67 — Confirm.
 *
 * The dialog exists so the user is told four things before a single file
 * moves: how many, which ones, where they are going, and what shape they will
 * be in when they get there. It names them rather than only counting them,
 * because "move 24 screenshots" and "move these 24 screenshots" are different
 * amounts of information, and that difference is the whole point of a
 * confirmation.
 *
 * It asks nothing. Both halves of the decision — the selection and the
 * destination — were made on the screen behind it, so this can state exactly
 * what is about to happen rather than collecting one last answer. A dialog
 * that still has a question in it is not a confirmation.
 *
 * The wording says the move is recoverable, because it is: nothing is
 * deleted, nothing is overwritten, and the files exist afterwards in a folder
 * the user picked. There is no "don't ask again" — section 67 wants the
 * confirm step every time, and a checkbox that removes it would remove the
 * step.
 */
function ScreenshotConfirmDialog({ screenshots }: { screenshots: Screenshot[] }) {
  const isConfirming = useScreenshotStore((state) => state.isConfirming);
  const isOrganizing = useScreenshotStore((state) => state.isOrganizing);
  const destination = useScreenshotStore((state) => state.destination);
  const grouping = useScreenshotStore((state) => state.grouping);
  const cancelOrganize = useScreenshotStore((state) => state.cancelOrganize);
  const confirmOrganize = useScreenshotStore((state) => state.confirmOrganize);

  const count = screenshots.length;
  const noun = count === 1 ? "screenshot" : "screenshots";
  const names = screenshots.slice(0, NAMES_SHOWN).map((screenshot) => screenshot.name);
  const rest = count - names.length;

  return (
    <AlertDialog
      open={isConfirming}
      onOpenChange={(open) => {
        if (!open && !isOrganizing) cancelOrganize();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Move {count} {noun}?
          </AlertDialogTitle>

          <AlertDialogDescription>
            {formatBytes(totalBytes(screenshots))} in total, into {destination}.{" "}
            {groupingSummary(grouping, screenshots)} Nothing is deleted and nothing already in
            that folder is overwritten — a name that is already taken gets a number added — so
            you can move them back afterwards.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs">
          {names.map((name) => (
            <li key={name} className="truncate" title={name}>
              {name}
            </li>
          ))}
          {rest > 0 && (
            <li className="pt-1 text-muted-foreground">
              and {rest} more {rest === 1 ? "screenshot" : "screenshots"}
            </li>
          )}
        </ul>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isOrganizing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isOrganizing}
            onClick={(event) => {
              // The dialog would otherwise close on its own and take the
              // "Moving…" state with it, leaving the user with no sign that
              // anything is happening while the files are still in flight.
              event.preventDefault();
              void confirmOrganize();
            }}
          >
            {isOrganizing ? "Moving…" : `Move ${count} ${noun}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default ScreenshotConfirmDialog;
