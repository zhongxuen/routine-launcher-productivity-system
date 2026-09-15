/**
 * PLAN TODAY's top priorities (development-plan.md sections 20 and 51).
 *
 * {@link DailyPlan} mirrors the payload of `get_daily_plan` / `set_daily_plan`
 * in `src-tauri/src/services/daily_plans.rs`. camelCase on the wire, like
 * `settings.ts`: the rank is a position in the list rather than a field.
 */

/** Section 51 numbers three. Rust and the table refuse a fourth. */
export const MAX_TOP_PRIORITIES = 3;

export interface DailyPlan {
  /** The local `YYYY-MM-DD` the priorities are for. */
  date: string;
  /** Task ids, rank 1 first. Empty for a day nothing has been picked for. */
  taskIds: number[];
}
