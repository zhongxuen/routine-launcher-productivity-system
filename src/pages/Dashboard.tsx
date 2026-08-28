import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppStore } from "@/stores/appStore";
import { checkDbHealth } from "@/services/healthService";

function Dashboard() {
  const bootCount = useAppStore((state) => state.bootCount);
  const incrementBootCount = useAppStore((state) => state.incrementBootCount);

  // Temporary proof that the SQLite round trip works end-to-end. Remove
  // once a real feature reads/writes the database from the UI instead.
  useEffect(() => {
    checkDbHealth()
      .then((value) => console.log("[db_health_check] round trip ok:", value))
      .catch((error) => console.error("[db_health_check] round trip failed:", error));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Foundation check</CardTitle>
          <CardDescription>
            Temporary scaffolding. Replaced by the real dashboard in a later phase.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">bootCount: {bootCount}</span>
          <Button size="sm" variant="secondary" onClick={incrementBootCount}>
            Increment
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default Dashboard;
