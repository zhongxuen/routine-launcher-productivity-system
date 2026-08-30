import { useEffect, useState } from "react";
import { Archive, HardDrive, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";

import IgnoredFilesPanel from "@/components/cleanup/large-files/IgnoredFilesPanel";
import LargeFileConfirmDialog from "@/components/cleanup/large-files/LargeFileConfirmDialog";
import LargeFileRow from "@/components/cleanup/large-files/LargeFileRow";
import LargeFileScanForm from "@/components/cleanup/large-files/LargeFileScanForm";
import EmptyState from "@/components/common/states/EmptyState";
import ErrorState from "@/components/common/states/ErrorState";
import InlineError from "@/components/common/states/InlineError";
import Spinner from "@/components/common/states/Spinner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useLargeFileStore } from "@/stores/largeFileStore";
import {
  archiveDestinationFor,
  describeScanStop,
  formatBytes,
  formatDuration,
  pluralize,
  type DestructiveAction,
  type LargeFile,
  type LargeFileScan,
} from "@/types/large-files";

/**
 * Cleanup > Large Files — development-plan.md sections 38, 41 and 67.
 *
 * Section 41's list, largest first, with Open / Move / Archive / Delete /
 * Ignore on every row.
 *
 * # The order this view is built in is the rule it implements
 *
 * Section 67 draws the whole feature as a sequence — scan, show results, user
 * selects, confirm, perform action — and every part of this screen belongs to
 * one step of it:
 *
 * 1. `LargeFileScanForm` is the scan, and it does not run until the Search
 *    button is pressed. There is no scan on mount and no default folder:
 *    reading someone's disk is something to be asked for.
 * 2. The list is the results. It is read-only; a row renders nothing that
 *    acts by being displayed.
 * 3. Selecting is picking a row's action, which is all `pendingAction` holds.
 * 4. `LargeFileConfirmDialog` is the confirmation, and it is the only route
 *    to step 5 for the three actions that move a file.
 * 5. The store performs it, one file per call.
 *
 * The two actions that skip the dialog are the two that cannot lose anything:
 * Open changes nothing, and Ignore is undone in one click from the panel at
 * the bottom. Everything else in the feature — including the backend — treats
 * "the user confirmed this exact file" as the only reason a file ever moves.
 */
function CleanupLargeFiles() {
  const preferences = useLargeFileStore((state) => state.preferences);
  const root = useLargeFileStore((state) => state.root);
  const thresholdMb = useLargeFileStore((state) => state.thresholdMb);
  const scan = useLargeFileStore((state) => state.scan);
  const isLoading = useLargeFileStore((state) => state.isLoading);
  const isScanning = useLargeFileStore((state) => state.isScanning);
  const busyPath = useLargeFileStore((state) => state.busyPath);
  const error = useLargeFileStore((state) => state.error);

  const loadPreferences = useLargeFileStore((state) => state.loadPreferences);
  const setThresholdMb = useLargeFileStore((state) => state.setThresholdMb);
  const chooseRoot = useLargeFileStore((state) => state.chooseRoot);
  const runScan = useLargeFileStore((state) => state.runScan);
  const openFile = useLargeFileStore((state) => state.openFile);
  const moveFile = useLargeFileStore((state) => state.moveFile);
  const archiveFile = useLargeFileStore((state) => state.archiveFile);
  const deleteFile = useLargeFileStore((state) => state.deleteFile);
  const ignoreFile = useLargeFileStore((state) => state.ignoreFile);
  const unignore = useLargeFileStore((state) => state.unignore);
  const clearIgnored = useLargeFileStore((state) => state.clearIgnored);
  const chooseArchiveRoot = useLargeFileStore((state) => state.chooseArchiveRoot);
  const resetArchiveRoot = useLargeFileStore((state) => state.resetArchiveRoot);

  /**
   * The file and action awaiting confirmation. Deliberately the *whole* state
   * of step 4: nothing has been started, nothing has been reserved, and
   * dropping it back to `null` is a complete cancel.
   */
  const [pending, setPending] = useState<{
    file: LargeFile;
    action: DestructiveAction;
  } | null>(null);

  // Only the stored settings, which say where the last scan ran and what is
  // ignored. The scan itself is never re-run from here — see the note above.
  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);

  const archiveRoot = preferences?.archiveRoot ?? "";
  const isPendingBusy = pending !== null && busyPath === pending.file.path;

  function confirmPending(destination?: string) {
    if (pending === null) return;

    const { file, action } = pending;
    const done = () => setPending(null);

    if (action === "move") {
      // Cannot happen — the dialog will not enable its button without a
      // destination — but the alternative to checking is a move to nowhere.
      if (destination === undefined) return;
      void moveFile(file, destination).then(done);
      return;
    }

    void (action === "archive" ? archiveFile(file) : deleteFile(file)).then(done);
  }

  return (
    <div className="flex flex-col gap-6 py-2">
      <header className="flex flex-col gap-0.5 px-2">
        <p className="text-xs font-medium tracking-widest text-muted-foreground">LARGE FILES</p>
        <p className="text-sm text-muted-foreground">
          Find what is taking up the most room in a folder, then decide file by file.
        </p>
      </header>

      {isLoading ? (
        <div role="status" aria-busy>
          <span className="sr-only">Loading your Large Files settings</span>
          <Skeleton className="h-40 w-full" aria-hidden />
        </div>
      ) : (
        <>
          <LargeFileScanForm
            root={root}
            thresholdMb={thresholdMb}
            isScanning={isScanning}
            onChooseRoot={() => void chooseRoot()}
            onThresholdChange={setThresholdMb}
            onScan={() => void runScan()}
          />

          <ArchiveFolderRow
            archiveRoot={archiveRoot}
            isDefault={preferences?.archiveRootIsDefault ?? true}
            onChange={() => void chooseArchiveRoot()}
            onReset={() => void resetArchiveRoot()}
          />

          <ScanResults
            scan={scan}
            isScanning={isScanning}
            error={error}
            busyPath={busyPath}
            onRetry={() => void runScan()}
            onOpen={(file) => void openFile(file)}
            onIgnore={(file) => void ignoreFile(file)}
            onRequestAction={(file, action) => setPending({ file, action })}
          />

          <IgnoredFilesPanel
            ignored={preferences?.ignored ?? []}
            hiddenFromThisScan={scan?.ignoredMatches ?? 0}
            onUnignore={(path) => void unignore(path)}
            onClear={() => void clearIgnored()}
          />
        </>
      )}

      <LargeFileConfirmDialog
        file={pending?.file ?? null}
        action={pending?.action ?? null}
        archiveDestination={
          pending ? archiveDestinationFor(archiveRoot, pending.file.modifiedMs) : ""
        }
        isWorking={isPendingBusy}
        onCancel={() => setPending(null)}
        onConfirm={confirmPending}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything below the scan controls: the summary, the list, and the four
 * things that can be there instead of a list.
 *
 * The empty state is a real answer, not a failure — "nothing in that folder
 * is over 500 MB" is often exactly what someone wanted to hear — so it is
 * worded as one and offers the correction that would change it.
 */
function ScanResults({
  scan,
  isScanning,
  error,
  busyPath,
  onRetry,
  onOpen,
  onIgnore,
  onRequestAction,
}: {
  scan: LargeFileScan | null;
  isScanning: boolean;
  error: string | null;
  busyPath: string | null;
  onRetry: () => void;
  onOpen: (file: LargeFile) => void;
  onIgnore: (file: LargeFile) => void;
  onRequestAction: (file: LargeFile, action: DestructiveAction) => void;
}) {
  // A spinner, not a skeleton: a folder walk can come back with two files or
  // two hundred, and rows drawn in advance would promise a list nobody can
  // promise yet.
  if (isScanning && scan === null) {
    return (
      <Spinner
        className="py-14"
        label="Searching the folder…"
        hint="Nothing is being changed. This only reads file sizes."
      />
    );
  }

  if (error !== null && scan === null) {
    return (
      <ErrorState title="Could not search that folder." message={error} onRetry={onRetry} />
    );
  }

  if (scan === null) {
    return (
      <EmptyState
        icon={HardDrive}
        title="Choose a folder and search it."
        hint="Searching only reads file sizes. Nothing is moved or deleted unless you pick a file and confirm it."
      />
    );
  }

  return (
    <section className="flex flex-col gap-3">
      <ScanSummary scan={scan} isScanning={isScanning} />

      {error !== null && (
        <InlineError
          message={`The last search failed: ${error} These results are from the one before it.`}
          onRetry={onRetry}
          retryLabel="Search again"
        />
      )}

      {scan.stopped !== null && (
        <Notice icon={TriangleAlert}>{describeScanStop(scan.stopped)}</Notice>
      )}

      {scan.truncated && (
        <Notice icon={TriangleAlert}>
          Only the {scan.files.length} biggest are shown. Raise the size threshold to narrow this
          down.
        </Notice>
      )}

      {scan.skippedFoldersTotal > 0 && (
        <Notice icon={ShieldCheck}>
          {pluralize(scan.skippedFoldersTotal, "folder")} could not be opened and{" "}
          {scan.skippedFoldersTotal === 1 ? "was" : "were"} skipped, usually because Windows does
          not allow it.{" "}
          {scan.skippedFolders.length > 0 && (
            <span className="text-muted-foreground/80">
              For example {scan.skippedFolders[0]}.
            </span>
          )}
        </Notice>
      )}

      {scan.files.length === 0 ? (
        // Not a failure. "Nothing in that folder is over 500 MB" is very
        // often the answer the user was hoping for, so it is worded as one
        // and followed by the correction that would change it.
        <EmptyState
          className="py-10"
          title={`Nothing in that folder is over ${formatBytes(scan.thresholdBytes)}.`}
          hint={
            scan.ignoredMatches > 0
              ? `${pluralize(scan.ignoredMatches, "file")} matched but ${scan.ignoredMatches === 1 ? "is" : "are"} on your ignore list.`
              : "Lower the size threshold to see more."
          }
        />
      ) : (
        <ul className="flex flex-col">
          {scan.files.map((file) => (
            <LargeFileRow
              key={file.path}
              file={file}
              isBusy={busyPath === file.path}
              isDisabled={busyPath !== null && busyPath !== file.path}
              onOpen={() => onOpen(file)}
              onIgnore={() => onIgnore(file)}
              onRequestAction={(action) => onRequestAction(file, action)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The line under the heading: what was found, in what, and how long it took.
 *
 * `shownBytes` rather than the total of everything matched, so the figure
 * always adds up to the rows underneath it — a "22 GB" that counted files the
 * list is not showing would be a number nobody could check.
 */
function ScanSummary({ scan, isScanning }: { scan: LargeFileScan; isScanning: boolean }) {
  const found =
    scan.files.length === 0
      ? "No files over that size"
      : `${pluralize(scan.files.length, "file")} · ${formatBytes(scan.shownBytes)}`;

  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2">
      <p className="text-sm font-medium">{found}</p>
      <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={scan.root}>
        over {formatBytes(scan.thresholdBytes)} in {scan.root} · searched{" "}
        {scan.filesSeen.toLocaleString()} files in {formatDuration(scan.durationMs)}
        {scan.ignoredMatches > 0 && ` · ${scan.ignoredMatches} ignored`}
      </p>
      {isScanning && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
    </div>
  );
}

/** A one-line caveat above the list — never an error, always a fact about the search. */
function Notice({
  icon: Icon,
  children,
}: {
  icon: typeof TriangleAlert;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <Icon className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* The archive folder                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Where Archive puts things, shown before anything is archived.
 *
 * On screen rather than buried in Settings because Archive is a one-click
 * action in the row menu, and a one-click action that moves a file somewhere
 * has to name that somewhere in advance. The confirmation dialog repeats it,
 * `YYYY-MM` bucket and all.
 */
function ArchiveFolderRow({
  archiveRoot,
  isDefault,
  onChange,
  onReset,
}: {
  archiveRoot: string;
  isDefault: boolean;
  onChange: () => void;
  onReset: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2">
      <Archive className="size-3.5 shrink-0 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">Archive to</p>
      <p
        className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
        title={archiveRoot}
      >
        {archiveRoot || "—"}
      </p>
      <Button size="xs" variant="ghost" onClick={onChange}>
        Change
      </Button>
      {!isDefault && (
        <Button size="xs" variant="ghost" onClick={onReset}>
          Reset
        </Button>
      )}
    </div>
  );
}

export default CleanupLargeFiles;
