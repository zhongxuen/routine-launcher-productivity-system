import { useEffect } from "react";
import { Lock } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import AboutCard from "@/components/settings/AboutCard";
import AppUsageCard from "@/components/settings/AppUsageCard";
import CalendarCard from "@/components/settings/CalendarCard";
import CloseToTrayCard from "@/components/settings/CloseToTrayCard";
import CommandActionsCard from "@/components/settings/CommandActionsCard";
import CompanionCard from "@/components/settings/CompanionCard";
import DailySettingsCard from "@/components/settings/DailySettingsCard";
import DataCard from "@/components/settings/DataCard";
import DesktopWidgetCard from "@/components/settings/DesktopWidgetCard";
import DiagnosticsCard from "@/components/settings/DiagnosticsCard";
import MotionSoundCard from "@/components/settings/MotionSoundCard";
import QuickLauncherCard from "@/components/settings/QuickLauncherCard";
import StartupCard from "@/components/settings/StartupCard";
import SyncCard from "@/components/settings/SyncCard";
import TaskCategoriesCard from "@/components/settings/TaskCategoriesCard";
import UpdatesCard from "@/components/settings/UpdatesCard";
import WalkthroughCard from "@/components/settings/WalkthroughCard";
import { useProgressStore } from "@/stores/progressStore";
import {
  ACCENTS,
  isAccentUnlocked,
  useThemeStore,
  type AccentPreference,
  type ThemePreference,
} from "@/stores/themeStore";

/**
 * Names the rewards and the level that opens each, in a sentence under the
 * picker. The same fact is on the locked rows themselves, but those are
 * disabled — dimmed below the contrast a sentence has to meet — so it is
 * also said here, where it can be read.
 */
function accentUnlockHint(level: number | null, isLoading: boolean): string {
  const rewards = ACCENTS.filter((accent) => accent.unlockLevel !== null);
  const locked = rewards.filter((accent) => !isAccentUnlocked(accent, level));
  if (locked.length === 0) return "Every accent is unlocked.";

  const list = rewards
    .map((accent) => `${accent.label} at level ${accent.unlockLevel}`)
    .join(" and ");
  const where =
    level !== null
      ? ` You are level ${level}.`
      : isLoading
        ? ""
        : " Your level could not be read just now.";
  return `${list} unlock as you level up — nothing else in the app does.${where}`;
}

function Settings() {
  const preference = useThemeStore((state) => state.preference);
  const setPreference = useThemeStore((state) => state.setPreference);
  const accent = useThemeStore((state) => state.accent);
  const setAccent = useThemeStore((state) => state.setAccent);
  const level = useProgressStore((state) => state.progress?.level.level ?? null);
  const isProgressLoading = useProgressStore((state) => state.isLoading);
  const loadProgress = useProgressStore((state) => state.loadProgress);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      {/* Section 52's Daily Settings, first: they shape every day the app is
          used — the defaults new work starts with and where the week begins —
          where everything below is set once and left alone. */}
      <DailySettingsCard />

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
          <CardDescription>
            Choose how the app looks. "System" follows your Windows theme.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
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

          {/* Section 48's cosmetic rewards. The accent in use is always
              selectable, even if it is above the current level — after a data
              reset, say — because a colour already chosen is never taken back. */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-4">
              <Label htmlFor="accent">Accent</Label>
              <Select
                value={accent}
                onValueChange={(value) => setAccent(value as AccentPreference)}
              >
                <SelectTrigger id="accent" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCENTS.map((option) => {
                    const isAvailable =
                      option.id === accent || isAccentUnlocked(option, level);
                    return (
                      <SelectItem key={option.id} value={option.id} disabled={!isAvailable}>
                        <span
                          data-accent-preview={option.id}
                          className="size-3 shrink-0 rounded-full bg-primary"
                          aria-hidden
                        />
                        {option.label}
                        {!isAvailable && (
                          <span className="ml-auto flex items-center gap-1 pl-2 text-xs">
                            <Lock className="size-3" aria-hidden />
                            Level {option.unlockLevel}
                          </span>
                        )}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {accentUnlockHint(level, isProgressLoading)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Directly under Appearance: theme, motion and sound are the three
          settings about how the app presents itself, and they belong together
          above the ones about what it is allowed to do. */}
      <MotionSoundCard />

      <CloseToTrayCard />

      {/* Directly under the tray, because it is the same subject seen from
          the other end: close-to-tray decides where the app goes when you
          shut its window, start-up decides whether it is there before you
          open one. Both are answers to "is this thing running when I am not
          looking at it". */}
      <StartupCard />

      <QuickLauncherCard />

      <DesktopWidgetCard />

      <CommandActionsCard />

      <WalkthroughCard />

      {/* Section 92's Tier 5 connections, together: each reaches past this
          window — to a calendar, to a phone on the same Wi-Fi, to the
          programs in front of you — and each is off until set up here. */}
      <CalendarCard />

      <CompanionCard />

      <AppUsageCard />

      {/* Section 13's categories. The first card about what the app holds
          rather than how it behaves, so it opens that half of the page —
          directly above Data, which is the rest of it. */}
      <TaskCategoriesCard />

      {/* Section 69's Data group. Last of the working settings, and after
          the walkthrough on purpose: the switches above change how the app
          behaves, and this one changes what it holds. Export, Import and
          Reset are also the only controls on this page that can lose
          something, so they sit at the end rather than in the middle of the
          switches. */}
      <DataCard />

      {/* Section 92's sync folder, directly under Data because it is the
          same file carried between computers: a pull is an import, a push an
          export, done for you. */}
      <SyncCard />

      {/* Section 85's update strategy. Below Data on purpose: an update
          replaces the program and leaves the database alone, and the card
          directly above it is the one that can put the database somewhere
          safe first. Above Diagnostics and About for the same reason those
          two are next to each other — this is the third thing you read out
          to whoever is helping you, and the one that most often ends the
          conversation. */}
      <UpdatesCard />

      {/* Section 85's crash log. Below Data because it is the same subject at
          one remove — that group is what the app holds on purpose, this is
          what it wrote down when something failed — and directly above About
          because the two are what you read out to whoever is helping you: the
          version, and the file. */}
      <DiagnosticsCard />

      <AboutCard />
    </div>
  );
}

export default Settings;
