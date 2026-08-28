//! Input normalisation and the date/time format checks the services share.
//!
//! Tasks and recurrence rules both store dates as `YYYY-MM-DD` and times as
//! 24-hour `HH:MM` TEXT — the shapes SQLite's `date()`/`strftime()` functions
//! understand — so the checks that guard those columns live here rather than
//! being written twice. Each takes a `label` (`"Due date"`, `"Start date"`,
//! ...) so the rejection message names the field the user actually filled in.

use rusqlite::types::Value;

use super::error::{ServiceError, ServiceResult};

/// Trims free text and treats a blank string as "no value", so the UI can
/// send an empty input without an empty string ending up in the database.
pub fn normalize_text(value: Option<String>) -> Option<String> {
    value
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

pub fn optional_text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::Text)
}

pub fn optional_integer(value: Option<i64>) -> Value {
    value.map_or(Value::Null, Value::Integer)
}

/// Checks the `YYYY-MM-DD` shape SQLite's date functions require. The day is
/// range-checked but not calendar-checked (31 February passes); that is
/// enough to keep the date comparisons in the task views working, and the UI
/// picks dates from a calendar anyway.
pub fn validate_date(label: &str, value: &str) -> ServiceResult<String> {
    let bytes = value.as_bytes();
    let well_formed = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());

    let month: u32 = value.get(5..7).and_then(|part| part.parse().ok()).unwrap_or(0);
    let day: u32 = value.get(8..10).and_then(|part| part.parse().ok()).unwrap_or(0);

    if !well_formed || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(ServiceError::validation(format!(
            "{label} {value:?} is not a valid YYYY-MM-DD date."
        )));
    }
    Ok(value.to_owned())
}

/// Checks the 24-hour `HH:MM` shape. Display formatting (e.g. "5:00 PM" in
/// development-plan.md section 10) is the frontend's job.
pub fn validate_time(label: &str, value: &str) -> ServiceResult<String> {
    let bytes = value.as_bytes();
    let well_formed = bytes.len() == 5
        && bytes[2] == b':'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 2 || byte.is_ascii_digit());

    let hour: u32 = value.get(0..2).and_then(|part| part.parse().ok()).unwrap_or(99);
    let minute: u32 = value.get(3..5).and_then(|part| part.parse().ok()).unwrap_or(99);

    if !well_formed || hour > 23 || minute > 59 {
        return Err(ServiceError::validation(format!(
            "{label} {value:?} is not a valid 24-hour HH:MM time."
        )));
    }
    Ok(value.to_owned())
}

/// `validate_date` over an optional, blank-tolerant field.
pub fn validate_optional_date(label: &str, value: Option<String>) -> ServiceResult<Option<String>> {
    match normalize_text(value) {
        Some(date) => validate_date(label, &date).map(Some),
        None => Ok(None),
    }
}

/// `validate_time` over an optional, blank-tolerant field.
pub fn validate_optional_time(label: &str, value: Option<String>) -> ServiceResult<Option<String>> {
    match normalize_text(value) {
        Some(time) => validate_time(label, &time).map(Some),
        None => Ok(None),
    }
}
