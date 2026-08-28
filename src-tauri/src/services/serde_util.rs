//! Small serde helpers shared by the service layer.

use serde::{Deserialize, Deserializer};

/// Deserializes a nullable field into `Option<Option<T>>` so that "absent"
/// and "explicitly null" stay distinguishable.
///
/// Partial-update payloads need all three states: leave the column alone
/// (key missing -> `None`), clear the column (key present as `null` ->
/// `Some(None)`), or set it (`Some(Some(value))`). Serde's default
/// behaviour collapses the first two into `None`, so nullable fields on
/// `*Update` structs use `#[serde(default, deserialize_with = "double_option")]`.
pub fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::deserialize(deserializer).map(Some)
}
