//! The first-launch flag behind section 84's onboarding walkthrough.
//!
//! One key in the `settings` table and two functions over it. It lives here
//! rather than inline in `commands/onboarding.rs` for the reason every other
//! preference does (development-plan.md section 86): the command layer parses
//! and maps errors, the service owns the key and what its absence means.
//!
//! The absence is the whole feature. A fresh install has never written this
//! key, so it reads false, so the walkthrough runs — and the *only* thing
//! that writes it is the walkthrough ending, whether the user finished it or
//! skipped out of it. Both are "has seen it", which is what the flag records;
//! it is deliberately not "has completed it", because a tour the user walked
//! out of is one they do not want shown again either.
//!
//! Storing it in the database rather than in `localStorage` matters here in a
//! way it does not for the theme: the walkthrough asks the user to create a
//! task and a routine, and both of those live in the database. A flag that
//! travelled with the webview profile could put the tour back in front of
//! someone whose first task and first routine are already sitting there.

use rusqlite::Connection;

use super::error::ServiceResult;
use super::settings;

/// Settings key recording that the first-run walkthrough has been seen.
/// Absent means it has not — see the module docs.
pub const ONBOARDING_SEEN_KEY: &str = "onboarding.seen";

/// Whether the walkthrough has already been shown and dismissed.
///
/// False on a fresh install, which is what makes the tour a *first*-run one.
pub fn is_seen(conn: &Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, ONBOARDING_SEEN_KEY, false)
}

/// Records that the walkthrough has been seen, or puts it back.
///
/// Setting it false is not an undo of the user's choice — nothing in the app
/// calls it by accident. It is the Settings card's "show it again", which is
/// the only way back to a one-time flow once it has been spent.
pub fn set_seen(conn: &Connection, seen: bool) -> ServiceResult<()> {
    settings::set_bool(conn, ONBOARDING_SEEN_KEY, seen)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    #[test]
    fn a_fresh_database_has_not_seen_the_walkthrough() {
        let conn = init_memory_db().unwrap();
        assert!(!is_seen(&conn).unwrap());
    }

    #[test]
    fn the_flag_round_trips_in_both_directions() {
        let conn = init_memory_db().unwrap();

        set_seen(&conn, true).unwrap();
        assert!(is_seen(&conn).unwrap());

        // Twice, because finishing the tour and skipping it both write true
        // and neither should care which happened first.
        set_seen(&conn, true).unwrap();
        assert!(is_seen(&conn).unwrap());

        set_seen(&conn, false).unwrap();
        assert!(!is_seen(&conn).unwrap());
    }
}
