/**
 * The colours a task category can be given (development-plan.md section 13).
 *
 * The seven seeded categories use seven of these (see
 * `0002_seed_task_categories.sql`), so a category made in the app sits beside
 * them as an equal rather than in a colour nothing else uses. Stored as the
 * hex value itself, so a row renders without looking anything up here.
 */

import type { TaskCategory } from "@/types/task";

export const CATEGORY_COLORS = [
  { value: "#ef4444", label: "Red" },
  { value: "#f97316", label: "Orange" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#84cc16", label: "Lime" },
  { value: "#22c55e", label: "Green" },
  { value: "#14b8a6", label: "Teal" },
  { value: "#06b6d4", label: "Cyan" },
  { value: "#3b82f6", label: "Blue" },
  { value: "#6366f1", label: "Indigo" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
  { value: "#94a3b8", label: "Slate" },
] as const;

/**
 * The colour a new category starts with: the first one no category has yet,
 * so the next few are told apart without anyone choosing. Once every colour
 * is taken they are handed out again in turn.
 */
export function nextCategoryColor(categories: TaskCategory[]): string {
  const used = new Set(categories.map((category) => category.color?.toLowerCase()));
  const unused = CATEGORY_COLORS.find((color) => !used.has(color.value));
  return (unused ?? CATEGORY_COLORS[categories.length % CATEGORY_COLORS.length]).value;
}
