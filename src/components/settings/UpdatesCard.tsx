import { useEffect, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  getCheckUpdatesOnLaunch,
  setCheckUpdatesOnLaunch,
} from "@/services/updateService";
import { useUpdateStore } from "@/stores/updateStore";

/**
 * Section 85's update strategy, as the user meets it.
 *
 * The card is one subject seen three ways — is there a newer build, would you
 * like it, and should we keep looking — and the order they are in is the
 * order somebody arriving here needs them.
 *
 * Two things about it are deliberate and worth not undoing.
 *
 * **Installing is always a press.** The launch check can find a release; it
 * can never apply one. So there is no "install automatically" switch, because
 * there is no such mode to switch off — the one setting here decides whether
 * the app *looks*, and nothing else. See `src-tauri/src/services/updates.rs`.
 *
 * **"Up to date" is only ever said after a check that worked.** A failed
 * check is its own state, in the destructive colour, saying we could not find
 * out. An app that answered a dead network with "you are on the newest
 * version" would be wrong in the one direction that costs the user something.
 */
function UpdatesCard() {
  const status = useUpdateStore((state) => state.status);
  const update = useUpdateStore((state) => state.update);
  const progress = useUpdateStore((state) => state.progress);
  const error = useUpdateStore((state) => state.error);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);
  const dismissError = useUpdateStore((state) => state.dismissError);

  const [checkOnLaunch, setCheckOnLaunch] = useState<boolean | null>(null);
  const [isSavingSetting, setIsSavingSetting] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getCheckUpdatesOnLaunch()
      .then((value) => {
        if (isCurrent) setCheckOnLaunch(value);
      })
      .catch((cause) => {
        // The switch is left out rather than guessed at: showing it in a
        // position that may not be the stored one would make the next click
        // a toggle to somewhere neither of us intended.
        if (isCurrent) setCheckOnLaunch(null);
        console.error("Could not read the update-check setting:", cause);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  async function applySetting(next: boolean) {
    setIsSavingSetting(true);
    try {
      setCheckOnLaunch(await setCheckUpdatesOnLaunch(next));
    } catch (cause) {
      toast.error("Could not change the update setting", { description: String(cause) });
    } finally {
      setIsSavingSetting(false);
    }
  }

  const isBusy = status === "checking" || status === "downloading";

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Updates</CardTitle>
        <CardDescription>
          Routine Launcher can look for a newer release and install it over itself, keeping your
          tasks, routines and history where they are. The check asks one address for a signed
          list of releases and sends nothing about you or your data.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3">
          {status === "available" || status === "downloading" ? (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="font-mono">{update?.version}</Badge>
                <span className="text-sm text-muted-foreground">
                  is available. You are on {update?.currentVersion}.
                </span>
              </div>

              {update?.date ? (
                <p className="text-xs text-muted-subtle">Released {update.date}</p>
              ) : null}

              {/* The manifest's notes, kept as the plain text they are
                  written as. Scrolled rather than truncated: a release note
                  the user cannot finish reading is worse than a short box. */}
              {update?.notes ? (
                <p className="max-h-32 select-text overflow-y-auto whitespace-pre-line rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {update.notes}
                </p>
              ) : null}
            </div>
          ) : status === "current" ? (
            <p className="text-sm text-muted-foreground">
              This is the newest release.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {status === "checking"
                ? "Looking for a newer release…"
                : "Nothing has been checked yet this session."}
            </p>
          )}

          {status === "downloading" ? (
            <div className="flex flex-col gap-1.5">
              {/* No bar at all when the server did not send a
                  `Content-Length` — see `DownloadProgress.total`. This
                  component has no indeterminate mode, and a bar drawn from a
                  guessed total is a bar that finishes early and then sits
                  there; the running byte count below is the honest version of
                  the same information. */}
              {progress?.total ? (
                <Progress value={Math.round((progress.downloaded / progress.total) * 100)} />
              ) : null}
              <p className="text-xs text-muted-subtle">
                {progress?.total
                  ? `Downloading — ${formatSize(progress.downloaded)} of ${formatSize(progress.total)}`
                  : `Downloading — ${formatSize(progress?.downloaded ?? 0)} so far`}
              </p>
              <p className="text-xs text-muted-subtle">
                Routine Launcher will close itself when the installer starts, and open again when
                it finishes.
              </p>
            </div>
          ) : null}

          {status === "error" && error ? (
            <InlineError
              message={error}
              onRetry={() => void check()}
              retryLabel="Check again"
              onDismiss={dismissError}
            />
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={isBusy}
              onClick={() => void check()}
            >
              <RefreshCw className={status === "checking" ? "animate-spin" : undefined} aria-hidden />
              {status === "checking" ? "Checking…" : "Check for updates"}
            </Button>

            {status === "available" || status === "downloading" ? (
              <Button size="sm" disabled={isBusy} onClick={() => void install()}>
                <Download aria-hidden />
                {status === "downloading" ? "Installing…" : `Install ${update?.version}`}
              </Button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <Label htmlFor="check-updates-on-launch">Check for updates when the app starts</Label>
          {checkOnLaunch === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="check-updates-on-launch"
              checked={checkOnLaunch}
              disabled={isSavingSetting}
              onCheckedChange={(next) => void applySetting(next)}
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Bytes as something a person can read off a progress line.
 *
 * Local to this card rather than shared: the cleanup tools have their own
 * formatter with its own rules about what a "large file" deserves to be
 * called, and one download does not need those.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${Math.round(bytes / 1024)} KB`;
  return `${mb.toFixed(1)} MB`;
}

export default UpdatesCard;
