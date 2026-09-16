import { useCallback, useEffect, useState } from "react";
import { Copy, KeyRound } from "lucide-react";
import { toast } from "sonner";

import InlineError from "@/components/common/states/InlineError";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  getCompanionStatus,
  rotateCompanionToken,
  setCompanionEnabled,
  setCompanionPort,
} from "@/services/tier5Service";
import type { CompanionStatus } from "@/types/tier5";

/**
 * Settings › Phone companion — development-plan.md section 92's mobile
 * companion, served by this app to phones on the same Wi-Fi rather than by a
 * server anywhere (sections 56, 68). See `src-tauri/src/services/companion.rs`
 * for what the page may do (today's tasks only) and how it is locked.
 *
 * The QR code is the pairing: it carries a secret token in the link. So the
 * card shows it only while the companion is on, and offers "Unpair all
 * phones", which issues a new token.
 */
function CompanionCard() {
  const [status, setStatus] = useState<CompanionStatus | null>(null);
  const [port, setPort] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConfirmingRotate, setIsConfirmingRotate] = useState(false);

  const apply = useCallback((next: CompanionStatus) => {
    setStatus(next);
    setPort(String(next.port));
  }, []);

  useEffect(() => {
    getCompanionStatus()
      .then(apply)
      .catch((cause) => setError(String(cause)));
  }, [apply]);

  async function run(action: () => Promise<CompanionStatus>, success?: string) {
    setIsBusy(true);
    try {
      apply(await action());
      setError(null);
      if (success) toast.success(success);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setIsBusy(false);
    }
  }

  const portNumber = Number(port);
  const portValid = Number.isInteger(portNumber) && portNumber >= 1024 && portNumber <= 65535;

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>Phone companion</CardTitle>
        <CardDescription>
          Check off and add today's tasks from your phone. Your phone opens a small page served by
          this computer over your own Wi-Fi — nothing goes through the internet, and the page can
          only see today's tasks. Routine Launcher has to be running, and Windows may ask whether to
          allow it on private networks.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <Label htmlFor="companion-enabled">Allow the phone companion</Label>
          {status === null ? (
            <Skeleton className="h-5 w-9 rounded-full" />
          ) : (
            <Switch
              id="companion-enabled"
              checked={status.enabled}
              disabled={isBusy}
              onCheckedChange={(next) => void run(() => setCompanionEnabled(next))}
            />
          )}
        </div>

        {status?.enabled && status.running && (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            {status.qrSvg ? (
              <img
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(status.qrSvg)}`}
                alt="QR code that opens the phone companion"
                className="size-44 shrink-0 rounded-md bg-white p-1"
              />
            ) : null}
            <div className="flex min-w-0 flex-col gap-2 text-sm">
              <p>
                Scan with your phone's camera, then add the page to your home screen. The code is a
                key to your task list: don't share it.
              </p>
              {status.links.length === 0 && (
                <p className="text-muted-foreground">
                  This computer does not seem to be on a local network, so there is no address to
                  show.
                </p>
              )}
              {status.links.map((link) => (
                <Button
                  key={link}
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(link)
                      .then(() => toast.success("Link copied"))
                      .catch((cause) => toast.error("Could not copy", { description: String(cause) }))
                  }
                >
                  <Copy aria-hidden />
                  Copy link ({new URL(link).host})
                </Button>
              ))}
              <Button
                variant="ghost"
                size="sm"
                className="w-fit"
                disabled={isBusy}
                onClick={() => setIsConfirmingRotate(true)}
              >
                <KeyRound aria-hidden />
                Unpair all phones
              </Button>
            </div>
          </div>
        )}

        {status?.enabled && (
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="companion-port">Port</Label>
              <Input
                id="companion-port"
                inputMode="numeric"
                className="w-28"
                value={port}
                aria-invalid={!portValid}
                onChange={(event) => setPort(event.target.value.replace(/\D/g, ""))}
              />
            </div>
            <Button
              variant="outline"
              disabled={isBusy || !portValid || portNumber === status.port}
              onClick={() => void run(() => setCompanionPort(portNumber), "Port changed")}
            >
              Save
            </Button>
          </div>
        )}

        {status?.error && <InlineError message={status.error} />}
        {error && <InlineError message={error} onDismiss={() => setError(null)} />}
      </CardContent>

      <AlertDialog open={isConfirmingRotate} onOpenChange={setIsConfirmingRotate}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unpair all phones?</AlertDialogTitle>
            <AlertDialogDescription>
              A new code is made, and every phone that scanned the old one stops working until it
              scans the new one.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void run(() => rotateCompanionToken(), "Phones unpaired")}
            >
              Unpair
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

export default CompanionCard;
