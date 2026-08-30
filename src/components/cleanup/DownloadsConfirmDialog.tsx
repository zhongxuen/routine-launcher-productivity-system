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
import { formatBytes } from "@/lib/downloads-utils";
import { useDownloadsStore } from "@/stores/downloadsStore";
import type { ScannedFile } from "@/types/downloads";

/** How many filenames the dialog lists before it starts counting instead. */
const NAMES_SHOWN = 6;

/**
 * Step four of development-plan.md section 67 — Confirm.
 *
 * The dialog exists to make sure the user is told three things before
 * anything happens: how many files, which files, and whether it can be
 * undone. It names them rather than only counting them, because "delete 7
 * files" and "delete these 7 files" are different amounts of information, and
 * the difference is the whole point of a confirmation.
 *
 * The two actions are deliberately worded and coloured differently:
 *
 * * **Move** is recoverable — the files exist afterwards, somewhere the user
 *   picked — so it reads as an ordinary action and the destination is asked
 *   for after this dialog, by the OS folder picker.
 * * **Delete** is not. It says so, in the description, and its button is
 *   destructive. There is no "don't ask again": section 67 wants the confirm
 *   step every time, and a checkbox that removes it would remove the step.
 */
function DownloadsConfirmDialog({ files }: { files: ScannedFile[] }) {
  const pendingAction = useDownloadsStore((state) => state.pendingAction);
  const isActing = useDownloadsStore((state) => state.isActing);
  const cancelAction = useDownloadsStore((state) => state.cancelAction);
  const confirmMove = useDownloadsStore((state) => state.confirmMove);
  const confirmDelete = useDownloadsStore((state) => state.confirmDelete);

  const isDelete = pendingAction === "delete";
  const bytes = files.reduce((total, file) => total + file.size_bytes, 0);
  const count = files.length;
  const noun = count === 1 ? "file" : "files";

  return (
    <AlertDialog
      open={pendingAction !== null}
      onOpenChange={(open) => {
        if (!open && !isActing) cancelAction();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isDelete
              ? `Delete ${count} ${noun} permanently?`
              : `Move ${count} ${noun} out of Downloads?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isDelete
              ? `${formatBytes(bytes)} will be removed from your Downloads folder. This cannot be undone — nothing goes to the Recycle Bin.`
              : `${formatBytes(bytes)} in total. You will pick the destination folder next, and nothing is moved until you do.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <FileNames files={files} />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isActing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={isDelete ? "destructive" : "default"}
            disabled={isActing}
            onClick={(event) => {
              // The dialog stays up while the work runs — closing it the
              // instant the button is pressed would show the list again with
              // the files still in it, which reads as "nothing happened".
              event.preventDefault();
              void (isDelete ? confirmDelete() : confirmMove());
            }}
          >
            {isActing
              ? isDelete
                ? "Deleting…"
                : "Moving…"
              : isDelete
                ? `Delete ${count} ${noun}`
                : "Choose folder…"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The names themselves, capped so a 200-file selection does not turn the
 * dialog into a scroll bar. The cap is on display only — the action still
 * covers every selected file, and the title says how many that is.
 */
function FileNames({ files }: { files: ScannedFile[] }) {
  if (files.length === 0) return null;

  const shown = files.slice(0, NAMES_SHOWN);
  const remaining = files.length - shown.length;

  return (
    <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs">
      {shown.map((file) => (
        <li key={file.path} className="flex justify-between gap-3">
          <span className="truncate" title={file.path}>
            {file.name}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatBytes(file.size_bytes)}
          </span>
        </li>
      ))}
      {remaining > 0 && (
        <li className="pt-1 text-muted-foreground">
          and {remaining} more {remaining === 1 ? "file" : "files"}
        </li>
      )}
    </ul>
  );
}

export default DownloadsConfirmDialog;
