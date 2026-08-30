/**
 * The first-run walkthrough's side of the `invoke` boundary
 * (development-plan.md section 84).
 *
 * Only the flag crosses here. The walkthrough's two working steps create a
 * task and a routine, and both go through `taskService` and `routineService`
 * exactly as the ordinary forms do — a tour that wrote its own rows through
 * its own commands would be a second, worse way to make a task.
 */

import { invoke } from "@tauri-apps/api/core";

/**
 * Whether the walkthrough has already been shown and dismissed.
 *
 * False on a fresh install: the key is only ever written by the tour ending,
 * so its absence is what "first launch" means. See
 * `src-tauri/src/services/onboarding.rs`.
 */
export async function getOnboardingSeen(): Promise<boolean> {
  return invoke<boolean>("get_onboarding_seen");
}

/**
 * Records that the walkthrough has been seen — or, with `false`, puts it back
 * for Settings' "show it again". Answers with what was stored.
 */
export async function setOnboardingSeen(seen: boolean): Promise<boolean> {
  return invoke<boolean>("set_onboarding_seen", { seen });
}
