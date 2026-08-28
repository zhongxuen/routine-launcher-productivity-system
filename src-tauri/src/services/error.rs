//! The error type shared by every service.
//!
//! Services distinguish between "the caller sent something we refuse to
//! store" (`Validation`), "the row you asked for is not there" (`NotFound`)
//! and "SQLite itself failed" (`Db`), so a command can decide how loudly to
//! report a failure. Commands flatten this to `String` at the `invoke`
//! boundary — the frontend only ever sees the `Display` text, which is
//! written to be safe to show to the user directly.

use std::fmt;

#[derive(Debug)]
pub enum ServiceError {
    /// Input that broke a business rule (empty title, malformed date, a
    /// foreign key pointing at a row that does not exist, ...).
    Validation(String),
    /// The caller referred to a row by id that no longer exists.
    NotFound(String),
    /// Anything SQLite rejected or failed on that is not the caller's fault.
    Db(rusqlite::Error),
}

pub type ServiceResult<T> = Result<T, ServiceError>;

impl ServiceError {
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound(message.into())
    }

    /// Turns a SQLite constraint failure into a friendly `Validation` error
    /// with `message`, and leaves every other SQLite error untouched.
    ///
    /// Used where a constraint violation has exactly one plausible cause,
    /// e.g. a duplicate category name or a `category_id` that points at a
    /// deleted category.
    pub fn from_constraint(err: rusqlite::Error, message: impl Into<String>) -> Self {
        match &err {
            rusqlite::Error::SqliteFailure(failure, _)
                if failure.code == rusqlite::ErrorCode::ConstraintViolation =>
            {
                Self::validation(message)
            }
            _ => Self::Db(err),
        }
    }
}

impl fmt::Display for ServiceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Validation(message) | Self::NotFound(message) => write!(f, "{message}"),
            Self::Db(err) => write!(f, "Database error: {err}"),
        }
    }
}

impl std::error::Error for ServiceError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Db(err) => Some(err),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for ServiceError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Db(err)
    }
}
