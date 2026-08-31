//! The installed-programs catalogue behind the routine builder's application
//! picker (development-plan.md sections 30, 31).
//!
//! Thin, per section 86: everything about *how* a program is found lives in
//! [`services::installed_apps`](crate::services::installed_apps). This is
//! read-only and touches neither the database nor anything the user owns — it
//! lists what is installed and nothing else, which is why it takes no
//! arguments beyond the reload flag and returns no paths the frontend did not
//! already have a right to see.

use crate::services::installed_apps::{self, InstalledApp};

/// Every program this computer knows about, by display name.
///
/// `refresh` rescans instead of answering from the cache — what the picker's
/// reload button sends after the user has installed something while the app
/// was open. Never fails: a source that cannot be read contributes nothing
/// and the rest of the list still arrives, because a picker with most of the
/// programs on it is useful and an error toast is not.
#[tauri::command]
pub fn list_installed_applications(refresh: Option<bool>) -> Vec<InstalledApp> {
    installed_apps::list(refresh.unwrap_or(false))
}
