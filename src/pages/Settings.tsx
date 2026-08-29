import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import CommandActionsCard from "@/components/settings/CommandActionsCard";
import { useThemeStore, type ThemePreference } from "@/stores/themeStore";

function Settings() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Choose how the app looks. "System" follows your Windows theme.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="theme">Theme</Label>
            <Select
              value={preference}
              onValueChange={(value) => setPreference(value as ThemePreference)}
            >
              <SelectTrigger id="theme" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <CommandActionsCard />

      <p className="text-sm text-muted-foreground">
        The remaining settings groups (daily start time, default focus length, notifications,
        start-up behaviour) arrive with their features.
      </p>
    </div>
  );
}

export default Settings;
