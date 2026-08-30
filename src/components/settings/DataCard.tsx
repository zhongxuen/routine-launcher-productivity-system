import { useState } from "react";
import { format } from "date-fns";
import { Download, RotateCcw, TriangleAlert, Upload } from "lucide-react";
import { toast } from "sonner";

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
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  exportBackup,
  importBackup,
  inspectBackup,
  pickBackupDestination,
  pickBackupFile,
  reloadAfterRestore,
  resetAppData,
} from "@/services/backupService";
import { parseTimestamp } from "@/lib/task-utils";
import {
  BACKUP_HEADLINE_TABLES,
  backupTableLabel,
  type BackupInfo,
} from "@/types/backup";

/**
 * Settings &rsaquo; Data — development-plan.md section 69.
 *
 * Section 68 promises that everything the app knows stays on this computer.
 * This card is what stops that promise from also meaning "and is lost with
 * it": one file, saved where the user says, that carries every task, routine,
 * focus session, XP transaction, achievement and setting, and that can be
 * read back on a reinstall.
 *
 * Three buttons, and the difference between them is how much is asked before
 * anything happens.
 *
 * **Export** asks nothing beyond where to put the file. It only reads.
 *
 * **Import** asks twice. The first dialog picks the file; the backend then
 * reads and validates it, and the confirmation is built from what was
 * actually in it — 812 tasks, exported on the 4th, by version 0.1.0. That is
 * section 67's scan / show / confirm / act, and it is the whole reason the
 * flow is two steps: "replace everything with this file" is a question nobody
 * can answer from a filename. A file that will be refused is refused at that
 * first read, before the user has been asked to agree to anything.
 *
 * **Reset** asks for the word. There is no file to describe and nothing to
 * check afterwards, so the only defence against an accidental click is that a
 * click is not enough — the button stays disabled until `RESET` is typed.
 * That is heavier than the confirmations elsewhere in the app on purpose:
 * everywhere else the user is confirming a list they are looking at, and here
 * they are confirming the absence of one.
 *
 * Import and Reset both reload the window when they finish. Every store in
 * the app was built from the database that has just been replaced, and a
 * reload is the one refresh that cannot miss one — see
 * `reloadAfterRestore` for why this is not an `announceDataChanged`.
 */
function DataCard() {
  const [isExporting, setIsExporting] = useState(false);
  const [isReading, setIsReading] = useState(false);

  /** The inspected backup awaiting confirmation, or null when none is. */
  const [pending, setPending] = useState<BackupInfo | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  const [isResetOpen, setIsResetOpen] = useState(false);
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [isResetting, setIsResetting] = useState(false);

  /** True while something is happening that the other buttons must not start. */
  const isBusy = isExporting || isReading || isImporting || isResetting;

  async function handleExport() {
    setIsExporting(true);
    try {
      const path = await pickBackupDestination();
      // Cancelling the save dialog is not a failure and says nothing.
      if (!path) return;

      const info = await exportBackup(path);
      toast.success("Backup saved", {
        description: `${info.totalRows.toLocaleString()} records written to ${info.path}`,
      });
    } catch (cause) {
      toast.error("Could not save the backup", { description: String(cause) });
    } finally {
      setIsExporting(false);
    }
  }

  async function handleChooseImport() {
    setIsReading(true);
    try {
      const path = await pickBackupFile();
      if (!path) return;

      // Reading it is what fills in the confirmation. Nothing has changed at
      // this point and nothing will unless the user goes on.
      setPending(await inspectBackup(path));
    } catch (cause) {
      toast.error("That backup could not be read", { description: String(cause) });
    } finally {
      setIsReading(false);
    }
  }

  async function handleImport() {
    if (!pending) return;

    setIsImporting(true);
    try {
      const info = await importBackup(pending.path);
      setPending(null);
      toast.success("Backup restored", {
        description: `${info.totalRows.toLocaleString()} records restored. Reloading…`,
      });
      reloadAfterRestore();
    } catch (cause) {
      // The restore is one transaction, so a failure here means the old data
      // is still there — which the message from Rust says, and which is the
      // most important half of it.
      toast.error("Could not restore the backup", { description: String(cause) });
      setIsImporting(false);
    }
  }

  async function handleReset() {
    setIsResetting(true);
    try {
      await resetAppData();
      setIsResetOpen(false);
      setResetConfirmation("");
      toast.success("All data erased", {
        description: "Routine Launcher is back to a fresh start. Reloading…",
      });
      reloadAfterRestore();
    } catch (cause) {
      toast.error("Could not erase your data", { description: String(cause) });
      setIsResetting(false);
    }
  }

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Data</CardTitle>
        <CardDescription>
          Everything Routine Launcher knows is stored on this computer and nowhere else. A backup
          is one file you keep wherever you like — save it before reinstalling Windows, moving to a
          new machine, or any time you would rather not start again.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Export data</p>
            <p className="text-sm text-muted-foreground">
              Writes every task, routine, focus session, achievement and setting to
              routine-launcher-backup.json.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={isBusy}
            onClick={() => void handleExport()}
            className="shrink-0"
          >
            <Download aria-hidden="true" />
            {isExporting ? "Exporting…" : "Export"}
          </Button>
        </div>

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Import data</p>
            <p className="text-sm text-muted-foreground">
              Restores a backup file. You will see what is in it before anything is replaced.
            </p>
          </div>
          <Button
            variant="outline"
            disabled={isBusy}
            onClick={() => void handleChooseImport()}
            className="shrink-0"
          >
            <Upload aria-hidden="true" />
            {isReading ? "Reading…" : "Import"}
          </Button>
        </div>

        <Separator />

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-medium">Reset</p>
            <p className="text-sm text-muted-foreground">
              Erases everything on this computer and starts over. Export first if there is anything
              you want to keep.
            </p>
          </div>
          <Button
            variant="destructive"
            disabled={isBusy}
            onClick={() => {
              setResetConfirmation("");
              setIsResetOpen(true);
            }}
            className="shrink-0"
          >
            <RotateCcw aria-hidden="true" />
            Reset
          </Button>
        </div>
      </CardContent>

      <ImportConfirmDialog
        backup={pending}
        isImporting={isImporting}
        onCancel={() => setPending(null)}
        onConfirm={() => void handleImport()}
      />

      <ResetConfirmDialog
        open={isResetOpen}
        confirmation={resetConfirmation}
        isResetting={isResetting}
        onConfirmationChange={setResetConfirmation}
        onOpenChange={(open) => {
          if (isResetting) return;
          setIsResetOpen(open);
          if (!open) setResetConfirmation("");
        }}
        onConfirm={() => void handleReset()}
      />
    </Card>
  );
}

/** The word Reset will not proceed without. Compared case-insensitively. */
const RESET_WORD = "RESET";

interface ImportConfirmDialogProps {
  backup: BackupInfo | null;
  isImporting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "This is what is in the file. Replace everything with it?"
 *
 * Everything on it comes from the backup that was just read, which is what
 * makes it a confirmation rather than a formality — a user who picked last
 * month's file instead of today's can see the difference in the date and in
 * the counts.
 */
function ImportConfirmDialog({
  backup,
  isImporting,
  onCancel,
  onConfirm,
}: ImportConfirmDialogProps) {
  const exportedAt = backup ? parseTimestamp(backup.exportedAt) : null;

  const headline = backup
    ? BACKUP_HEADLINE_TABLES.map((table) => {
        const count = backup.counts.find((entry) => entry.table === table);
        return count ? { ...count, label: backupTableLabel(table) } : null;
      }).filter((count) => count !== null)
    : [];

  return (
    <AlertDialog
      open={backup !== null}
      onOpenChange={(open) => {
        if (!open && !isImporting) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace everything with this backup?</AlertDialogTitle>
          <AlertDialogDescription>
            Every task, routine, focus session and setting on this computer is erased and replaced
            with what is in this file. Anything you have done since it was exported is lost. This
            cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>

        {backup ? (
          <div className="flex flex-col gap-3 rounded-md border p-3 text-sm">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium break-all">{backup.path}</span>
              <span className="text-muted-foreground">
                {exportedAt
                  ? `Exported ${format(exportedAt, "d MMM yyyy, h:mm a")}`
                  : "Export date unknown"}
                {" · "}
                version {backup.appVersion}
              </span>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
              {headline.map((count) => (
                <div key={count.table} className="flex items-baseline justify-between gap-2">
                  <dt className="text-muted-foreground">{count.label}</dt>
                  <dd className="font-medium tabular-nums">{count.rows.toLocaleString()}</dd>
                </div>
              ))}
            </dl>

            <p className="text-muted-foreground">
              {backup.totalRows.toLocaleString()} records in total.
            </p>

            {/* Section 66's switch is in this file like any other setting, and
                a backup is a route to turning it on that the switch's own
                confirmation does not cover. Said here rather than silently
                honoured. */}
            {backup.enablesCommandActions ? (
              <p className="flex gap-2 text-amber-600 dark:text-amber-500">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                <span>
                  This backup has command actions switched on, so routines in it will be allowed to
                  run shell commands. You can turn that off again in Settings.
                </span>
              </p>
            ) : null}
          </div>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isImporting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={isImporting}
            onClick={(event) => {
              // The dialog stays up while the restore runs; it closes when
              // the work is done rather than on the click that started it.
              event.preventDefault();
              onConfirm();
            }}
          >
            {isImporting ? "Restoring…" : "Replace my data"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface ResetConfirmDialogProps {
  open: boolean;
  confirmation: string;
  isResetting: boolean;
  onConfirmationChange: (value: string) => void;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/**
 * The typed confirmation in front of Reset.
 *
 * The only control in the app that asks the user to write something before it
 * will act. It is warranted here and nowhere else: every other destructive
 * confirmation describes what is about to go — these files, this routine —
 * and this one cannot, because the answer is "all of it".
 */
function ResetConfirmDialog({
  open,
  confirmation,
  isResetting,
  onConfirmationChange,
  onOpenChange,
  onConfirm,
}: ResetConfirmDialogProps) {
  const isConfirmed = confirmation.trim().toUpperCase() === RESET_WORD;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Erase everything on this computer?</AlertDialogTitle>
          <AlertDialogDescription>
            Every task, routine, focus session, XP transaction, achievement, streak and setting is
            deleted, and Routine Launcher goes back to how it was the day you installed it. There
            is no undo, and nothing is sent anywhere first. If you may want any of it back, cancel
            and export a backup.
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="flex flex-col gap-2">
          <Label htmlFor="reset-confirmation">
            Type <span className="font-mono font-semibold">{RESET_WORD}</span> to confirm
          </Label>
          <Input
            id="reset-confirmation"
            value={confirmation}
            autoComplete="off"
            spellCheck={false}
            disabled={isResetting}
            placeholder={RESET_WORD}
            onChange={(event) => onConfirmationChange(event.target.value)}
          />
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isResetting}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!isConfirmed || isResetting}
            onClick={(event) => {
              event.preventDefault();
              onConfirm();
            }}
          >
            {isResetting ? "Erasing…" : "Erase everything"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DataCard;
