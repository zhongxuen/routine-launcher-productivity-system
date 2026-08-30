import { AlertTriangle } from "lucide-react";

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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  formatBytes,
  formatFileCount,
  fullySelectedGroups,
  selectedFiles,
  totalBytes,
} from "@/lib/duplicate-utils";
import { useDuplicateStore } from "@/stores/duplicateStore";

/**
 * The "Confirm" step of development-plan.md section 67, and the last thing
 * between a selection and a changed disk.
 *
 * It exists to make the action *specific*. A dialog that said "delete the
 * selected files?" would be asking about a number; this one lists every path
 * that is about to go, and says the two things that are easy to get wrong:
 *
 * 1. **Deleting is permanent.** There is no recycle bin behind it, so the
 *    dialog says so rather than letting the user find out. Moving is offered
 *    beside it precisely because it is the reversible answer.
 * 2. **Which groups would be emptied.** Selecting every copy in a group is
 *    allowed — sometimes a duplicate set is simply unwanted — but it is also
 *    the one selection that leaves nothing behind, and it is easy to reach by
 *    clicking "Select all" without meaning to. Each such group is named here.
 *
 * Nothing happens on mount, on open, or on cancel. The store's `confirmDelete`
 * and `confirmMove` are reachable from this dialog and nowhere else.
 */
function DuplicateConfirmDialog() {
  const scan = useDuplicateStore((state) => state.scan);
  const selected = useDuplicateStore((state) => state.selected);
  const pendingAction = useDuplicateStore((state) => state.pendingAction);
  const cancelAction = useDuplicateStore((state) => state.cancelAction);
  const confirmDelete = useDuplicateStore((state) => state.confirmDelete);
  const confirmMove = useDuplicateStore((state) => state.confirmMove);

  const groups = scan?.groups ?? [];
  const files = selectedFiles(groups, selected);
  const emptied = fullySelectedGroups(groups, selected);
  const isDelete = pendingAction === "delete";

  return (
    <AlertDialog
      open={pendingAction !== null}
      onOpenChange={(open) => {
        if (!open) cancelAction();
      }}
    >
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isDelete
              ? `Delete ${formatFileCount(files.length).toLowerCase()}?`
              : `Move ${formatFileCount(files.length).toLowerCase()}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isDelete
              ? `${formatBytes(totalBytes(files))} will be removed. This cannot be undone — nothing goes to the Recycle Bin.`
              : `${formatBytes(totalBytes(files))} in total. You will pick the destination folder next, and nothing is moved until you do.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {emptied.length > 0 && (
          <div className="flex gap-2 rounded-md border border-priority-urgent/40 bg-priority-urgent/5 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-priority-urgent" />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="text-sm">
                {emptied.length === 1
                  ? "Every copy in one group is selected."
                  : `Every copy in ${emptied.length} groups is selected.`}
              </p>
              <p className="text-xs text-muted-foreground">
                No copy of {emptied.map((group) => group.name).join(", ")} would be
                left {isDelete ? "on this computer" : "where it is now"}.
              </p>
            </div>
          </div>
        )}

        <ScrollArea className="max-h-56 rounded-md border">
          <ul className="flex flex-col p-2">
            {files.map((file) => (
              <li
                key={file.path}
                className="flex items-baseline justify-between gap-3 py-1"
                title={file.path}
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm">{file.name}</span>
                  <span className="truncate text-xs text-muted-subtle">
                    {file.folder}
                  </span>
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                </span>
              </li>
            ))}
          </ul>
        </ScrollArea>

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={isDelete ? "destructive" : "default"}
            onClick={() => {
              void (isDelete ? confirmDelete() : confirmMove());
            }}
          >
            {isDelete ? "Delete permanently" : "Choose a folder…"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DuplicateConfirmDialog;
