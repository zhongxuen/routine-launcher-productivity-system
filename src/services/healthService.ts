import { invoke } from "@tauri-apps/api/core";

/**
 * Temporary service used only to prove the SQLite round trip works
 * end-to-end (React -> Service -> Tauri Command -> Rust -> SQLite, per
 * development-plan.md section 86). Calls the `db_health_check` command,
 * which writes a timestamp into the `settings` table and reads it back.
 *
 * Remove/replace once a real feature (tasks, routines, ...) exercises the
 * database from the UI instead.
 */
export async function checkDbHealth(): Promise<string> {
  return invoke<string>("db_health_check");
}
