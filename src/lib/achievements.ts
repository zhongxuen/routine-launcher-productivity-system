/**
 * Presentation for the six achievements of development-plan.md section 47.
 *
 * Names and descriptions are not here. They come from the data —
 * `achievements.name` and `.description`, seeded by
 * `database/migrations/0005_seed_achievements.sql` — so they are written down
 * once, in the migration, and this file never repeats them.
 *
 * The icon is the part that cannot cross that boundary on its own.
 * `achievements.icon` holds a lucide-react *name* (the convention 0002 set
 * for task categories), and the grid draws lucide *components*, so something
 * has to turn one into the other. That is {@link achievementIcon}, and it
 * answers in three steps rather than one:
 *
 * 1. the row's icon name, which is what the seed intends and what a later
 *    migration can change without touching this file;
 * 2. failing that, the achievement's `key`, which is stable, exhaustive over
 *    section 47's six, and type-checked;
 * 3. failing that, a trophy — because the *data* decides what arrives here,
 *    and a seventh achievement seeded in a later phase, or an icon name that
 *    lucide has since renamed, should cost a generic glyph rather than a
 *    blank tile or a crash.
 */

import {
  Award,
  Brain,
  CalendarCheck,
  CircleCheckBig,
  Flame,
  FolderCheck,
  ListChecks,
  Rocket,
  Sparkles,
  Timer,
  Trophy,
  type LucideIcon,
} from "lucide-react";

import { ACHIEVEMENT_KEYS, type Achievement, type AchievementKey } from "@/types/progress";

/**
 * lucide names to components, for the names the seed actually uses plus the
 * ones {@link ACHIEVEMENT_ICONS} falls back to.
 *
 * Deliberately a small hand-written table and not lucide's dynamic-import
 * map: this is a desktop app bundling exactly the icons it draws, and pulling
 * in the whole icon set to render six tiles would be a poor trade. Names are
 * kebab-case as the database stores them.
 */
const ICONS_BY_NAME: Record<string, LucideIcon> = {
  award: Award,
  brain: Brain,
  "calendar-check": CalendarCheck,
  // Both spellings of the same glyph: lucide renamed `check-circle-2` to
  // `circle-check-big`, and the seed predates a rename it cannot know about.
  "check-circle-2": CircleCheckBig,
  "circle-check-big": CircleCheckBig,
  flame: Flame,
  "folder-check": FolderCheck,
  "list-checks": ListChecks,
  rocket: Rocket,
  sparkles: Sparkles,
  timer: Timer,
  trophy: Trophy,
};

/** One icon per achievement key, for rows that carry no icon of their own. */
export const ACHIEVEMENT_ICONS: Record<AchievementKey, LucideIcon> = {
  first_task: ListChecks,
  first_routine: Rocket,
  focused: Timer,
  consistent: CalendarCheck,
  organized: FolderCheck,
  deep_work: Award,
};

/** The icon to draw for an achievement: its own, then its key's, then a trophy. */
export function achievementIcon(
  achievement: Pick<Achievement, "key" | "icon">,
): LucideIcon {
  const named = achievement.icon ? ICONS_BY_NAME[achievement.icon] : undefined;
  return named ?? ACHIEVEMENT_ICONS[achievement.key as AchievementKey] ?? Trophy;
}

/**
 * Section 47's order, with anything unrecognised kept at the end rather than
 * dropped.
 *
 * The grid sorts rather than trusting the order it was given, so a tile can
 * never move between two reads — an achievement unlocking must not reshuffle
 * the five around it while the user is looking at them.
 */
export function sortAchievements(achievements: Achievement[]): Achievement[] {
  const order = (key: string) => {
    const index = ACHIEVEMENT_KEYS.indexOf(key as AchievementKey);
    return index === -1 ? ACHIEVEMENT_KEYS.length : index;
  };

  return [...achievements].sort((a, b) => order(a.key) - order(b.key));
}
