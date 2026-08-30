import { useEffect, useState } from "react";
import { Archive, FolderInput, Trash2 } from "lucide-react";

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
import { pickFolder } from "@/services/largeFileService";
import { formatBytes, type DestructiveAction, type LargeFile } from "@/types/large-files";

/**
 * The confirmation step of development-plan.md section 67 — the fourth box in
 * "scan -> show results -> user selects -> confirm -> perform action".
 *
 * One dialog for Move, Archive and Delete rather than three, because the
 * thing being confirmed is the same in all three cases and the user should be
 * reading the same four facts each time: which file, how big it is, where it
 * is now, and where it is going.
 *
 * # What makes this a confirmation rather than a formality
 *
 * * **The destination is always named in full,** not described. "Moved to
 *   your archive" tells nobody anything; `C:\Users\me\Documents\Routine
 *   Launcher Archive\2024-03` tells them exactly what will have happened.
 * * **Move cannot be confirmed until a folder has been chosen.** The
 *   confirming button is disabled while the destination is empty, so there is
 *   no click that means "move it somewhere, you decide".
 * * **Delete says where the file goes.** It goes to the Recycle Bin — the
 *   backend uses the platform trash rather than unlinking — so the dialog
 *   says so and the user can weigh a recoverable decision as a recoverable
 *   one.
 *
 * Nothing here performs anything: `onConfirm` is what the store's single-file
 * action hangs off, and the dialog is the only thing in the feature that
 * calls it.
 */
function LargeFileConfirmDialog({
  file,
  action,
  archiveDestination,
  isWorking,
  onCancel,
  onConfirm,
}: {
  /** The file being confirmed, or `null` when nothing is pending. */
  file: LargeFile | null;
  /** Which of the three destructive actions. */
  action: DestructiveAction | null;
  /**
   * The exact folder Archive would file this file into, `YYYY-MM` bucket
   * included. Computed by the caller from the same `modifiedMs` the backend
   * will use, so what is shown is what happens.
   */
  archiveDestination: string;
  isWorking: boolean;
  onCancel: () => void;
  /** `destination` is set for a move and undefined otherwise. */
  onConfirm: (destination?: string) => void;
}) {
  const [destination, setDestination] = useState<string | null>(null);

  // Cleared whenever the dialog is opened on a different file or a different
  // action, so a folder chosen for one move can never be carried into the
  // next one — which is the sort of stickiness that gets a file put somewhere
  // nobody asked for.
  useEffect(() => {
    setDestination(null);
  }, [file?.path, action]);

  const isOpen = file !== null && action !== null;
  if (!isOpen) return null;

  const detail = DETAILS[action];
  const target = action === "move" ? destination : archiveDestination;
  const canConfirm = action !== "move" || destination !== null;

  return (
    <AlertDialog open onOpenChange={(next) => !next && !isWorking && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <detail.Icon className="size-4" />
            {detail.title(file.name)}
          </AlertDialogTitle>
          <AlertDialogDescription>{detail.description}</AlertDialogDescription>
        </AlertDialogHeader>

        <dl className="flex flex-col gap-2 rounded-md border bg-muted/40 p-3 text-xs">
          <Fact label="File">
            {file.name} · {formatBytes(file.sizeBytes)}
          </Fact>
          <Fact label="From">{file.parent}</Fact>

          {action !== "delete" && (
            <Fact label="To">
              {target ?? (
                <span className="text-muted-foreground">No folder chosen yet</span>
              )}
            </Fact>
          )}
        </dl>

        {action === "move" && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={isWorking}
            onClick={() => {
              void pickFolder(`Move ${file.name} to…`, file.parent).then((chosen) => {
                if (chosen !== null) setDestination(chosen);
              });
            }}
          >
            <FolderInput />
            {destination === null ? "Choose a folder…" : "Choose a different folder…"}
          </Button>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isWorking}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isWorking || !canConfirm}
            className={
              action === "delete"
                ? "bg-destructive text-white hover:bg-destructive/90"
                : undefined
            }
            onClick={(event) => {
              // The action is async and the row it belongs to has to survive
              // long enough to report on it, so the dialog closes when the
              // store says it is done rather than on the click that started
              // it.
              event.preventDefault();
              onConfirm(action === "move" ? (destination ?? undefined) : undefined);
            }}
          >
            {isWorking ? detail.working : detail.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One `label: value` line of the summary, with the value never truncated. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-10 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-all font-mono">{children}</dd>
    </div>
  );
}

/**
 * The wording for each action, in one table so the three dialogs read as one
 * dialog with three subjects.
 *
 * Every description says what becomes of the file rather than asking "are you
 * sure?" — a question nobody has ever answered by thinking about it.
 */
const DETAILS: Record<
  DestructiveAction,
  {
    Icon: typeof FolderInput;
    title: (name: string) => string;
    description: string;
    confirm: string;
    working: string;
  }
> = {
  move: {
    Icon: FolderInput,
    title: (name) => `Move ${name}?`,
    description:
      "The file is moved, not copied. If the destination already has a file of this name, yours is kept under a numbered name — nothing there is overwritten.",
    confirm: "Move file",
    working: "Moving…",
  },
  archive: {
    Icon: Archive,
    title: (name) => `Archive ${name}?`,
    description:
      "The file is moved into your archive folder, under the month it was last changed. It stays exactly as it is and you can open it from there at any time.",
    confirm: "Archive file",
    working: "Archiving…",
  },
  delete: {
    Icon: Trash2,
    title: (name) => `Delete ${name}?`,
    description:
      "The file is sent to the Recycle Bin, so you can restore it from there if you change your mind. It is not removed permanently until you empty the Recycle Bin.",
    confirm: "Delete file",
    working: "Deleting…",
  },
};

export default LargeFileConfirmDialog;
