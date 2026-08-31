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
import { formatBytes, totalBytes } from "@/lib/desktop-utils";
import { useDesktopStore } from "@/stores/desktopStore";
import type { DesktopItem } from "@/types/desktop";

/** How many names the dialog lists before it starts counting instead. */
const NAMES_SHOWN = 6;

/**
 * Step four of development-plan.md section 67 — Confirm.
 *
 * The dialog exists to make sure the user is told three things before anything
 * happens: how many items, which items, and whether it can be undone. It names
 * them rather than only counting them, because "delete 7 items" and "delete
 * these 7 items" are different amounts of information, and the difference is
 * the whole point of a confirmation.
 *
 * The two actions are deliberately worded and coloured differently:
 *
 * * **Move** is recoverable — the items exist afterwards, somewhere the user
 *   picked — so it reads as an ordinary action and the destination is asked
 *   for after this dialog, by the OS folder picker.
 * * **Delete** is not. It says so, in the description, and its button is
 *   destructive. There is no "don't ask again": section 67 wants the confirm
 *   step every time, and a checkbox that removes it would remove the step.
 *
 * One sentence here exists only on a desktop: a selection that includes
 * shortcuts says what deleting a shortcut does and does not do. "Will this
 * uninstall the program?" is the question somebody hesitates over at exactly
 * this moment, and the answer is no.
 */
function DesktopConfirmDialog({ items }: { items: DesktopItem[] }) {
  const pendingAction = useDesktopStore((state) => state.pendingAction);
  const isActing = useDesktopStore((state) => state.isActing);
  const cancelAction = useDesktopStore((state) => state.cancelAction);
  const confirmMove = useDesktopStore((state) => state.confirmMove);
  const confirmDelete = useDesktopStore((state) => state.confirmDelete);

  const isDelete = pendingAction === "delete";
  const bytes = totalBytes(items);
  const count = items.length;
  const noun = count === 1 ? "item" : "items";
  const shortcuts = items.filter((item) => item.kind === "shortcut").length;

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
              : `Move ${count} ${noun} off your desktop?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isDelete
              ? `${formatBytes(bytes)} will be removed from your desktop. This cannot be undone — nothing goes to the Recycle Bin.`
              : `${formatBytes(bytes)} in total. You will pick the destination folder next, and nothing is moved until you do.`}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {shortcuts > 0 && (
          <p className="text-xs text-muted-foreground">
            {shortcuts === 1 ? "One of these is a shortcut" : `${shortcuts} of these are shortcuts`}
            {isDelete
              ? ". Deleting a shortcut removes the shortcut only — the program or file it points at stays exactly where it is."
              : ". Moving a shortcut moves the shortcut only — it will still point at the same place."}
          </p>
        )}

        <ItemNames items={items} />

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isActing}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={isDelete ? "destructive" : "default"}
            disabled={isActing}
            onClick={(event) => {
              // The dialog stays up while the work runs — closing it the
              // instant the button is pressed would show the list again with
              // the items still in it, which reads as "nothing happened".
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
 * The names themselves, capped so a 200-item selection does not turn the
 * dialog into a scroll bar. The cap is on display only — the action still
 * covers every selected item, and the title says how many that is.
 */
function ItemNames({ items }: { items: DesktopItem[] }) {
  if (items.length === 0) return null;

  const shown = items.slice(0, NAMES_SHOWN);
  const remaining = items.length - shown.length;

  return (
    <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-md bg-muted/50 p-3 text-xs">
      {shown.map((item) => (
        <li key={item.path} className="flex justify-between gap-3">
          <span className="truncate" title={item.path}>
            {item.name}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {formatBytes(item.size_bytes)}
          </span>
        </li>
      ))}
      {remaining > 0 && (
        <li className="pt-1 text-muted-foreground">
          and {remaining} more {remaining === 1 ? "item" : "items"}
        </li>
      )}
    </ul>
  );
}

export default DesktopConfirmDialog;
