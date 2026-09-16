/**
 * Section 55's rule-based suggestions, on this side of the `invoke` boundary.
 * See `src-tauri/src/services/suggestions.rs`.
 *
 * Neither call changes a task. Taking a suggestion goes through the ordinary
 * task commands.
 */

import { invoke } from "@tauri-apps/api/core";

import type { Suggestion } from "@/types/suggestion";

/** Every suggestion that applies now and has not been dismissed. */
export async function listSuggestions(): Promise<Suggestion[]> {
  return invoke<Suggestion[]>("list_suggestions");
}

/** Declines the suggestion `key` for good: it does not come back for that title. */
export async function dismissSuggestion(key: string): Promise<void> {
  return invoke<void>("dismiss_suggestion", { key });
}
