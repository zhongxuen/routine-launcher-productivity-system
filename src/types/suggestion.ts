/**
 * Section 55's rule-based suggestions.
 *
 * {@link Suggestion} mirrors the payload of `list_suggestions` in
 * `src-tauri/src/services/suggestions.rs`. snake_case on the wire, like
 * `task.ts`, whose recurrence and priority types it reuses.
 */

import type { RecurrenceFrequency, TaskPriority, Weekday } from "@/types/task";

/** "You complete this often. Make it recurring?" */
export interface MakeRecurringSuggestion {
  kind: "make_recurring";
  /** Pass to `dismissSuggestion`. */
  key: string;
  title: string;
  /** The open task to give the schedule to, or null to create one from `template`. */
  task_id: number | null;
  template: {
    title: string;
    priority: TaskPriority;
    category_id: number | null;
    estimated_minutes: number | null;
    routine_id: number | null;
  };
  /** Distinct days it was completed on in the last fortnight. */
  days_completed: number;
  /** The schedule those days imply, for the repeat picker to open on. */
  recurrence: {
    frequency: RecurrenceFrequency;
    days_of_week: Weekday[];
  };
}

/** "This usually takes longer. Update the estimate?" */
export interface UpdateEstimateSuggestion {
  kind: "update_estimate";
  key: string;
  title: string;
  /** The tasks whose estimate would change. */
  task_ids: number[];
  current_minutes: number;
  /** The median focus time of the last three completions. */
  suggested_minutes: number;
}

export type Suggestion = MakeRecurringSuggestion | UpdateEstimateSuggestion;
