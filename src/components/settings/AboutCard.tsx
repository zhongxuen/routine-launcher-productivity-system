import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getAppVersion } from "@/services/appService";

/**
 * Which build this is (development-plan.md section 85).
 *
 * Small, and load-bearing for the release checklist: "upgrade over a previous
 * version" and "database migration on upgrade" are both tests whose first
 * step is looking at a number, and a number read out of the bundle is the one
 * that cannot disagree with the installer. See `scripts/set-version.mjs` for
 * what keeps that number in step across the four files that carry it.
 *
 * A version that could not be read is left blank rather than guessed at —
 * there is no default that would be true.
 */
function AboutCard() {
  const [version, setVersion] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getAppVersion()
      .then((value) => {
        if (isCurrent) setVersion(value);
      })
      .catch(() => {
        // No toast. Nobody came to Settings to be told the version could not
        // be read, and nothing else on the page depends on it.
        if (isCurrent) setFailed(true);
      });

    return () => {
      isCurrent = false;
    };
  }, []);

  return (
    <Card className="max-w-xl">
      <CardHeader>
        <CardTitle>About</CardTitle>
        <CardDescription>
          Routine Launcher keeps everything on this machine &mdash; there is no account and no
          sync, and nothing about you or your work leaves it. The one thing the app ever asks
          the network is whether a newer release exists, which you can turn off under Updates.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-medium">Version</span>
          {failed ? (
            <span className="text-sm text-muted-foreground">Unavailable</span>
          ) : version === null ? (
            <Skeleton className="h-5 w-16" />
          ) : (
            <Badge variant="secondary" className="font-mono">
              {version}
            </Badge>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export default AboutCard;
