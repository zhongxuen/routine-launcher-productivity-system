/**
 * The installed-programs catalogue behind the routine builder's application
 * picker.
 *
 * The wire shape of `InstalledApp` in
 * `src-tauri/src/services/installed_apps.rs`, field for field. What is *in*
 * the list — which programs, under which names — is decided there; nothing on
 * this side filters or renames, so the dropdown shows what the machine has.
 */

/** One program the user can point an `application` action at. */
export interface InstalledApp {
  /** What the user calls it: `Google Chrome`. */
  name: string;
  /** What the action stores — a path to the program, or a Store app's ID. */
  target: string;
  /**
   * Whether the target is opened by Windows rather than run directly. These
   * are the ones that cannot take arguments, so the builder hides the
   * arguments field when one is chosen rather than letting the user type
   * something the launch would refuse.
   */
  via_shell: boolean;
}
