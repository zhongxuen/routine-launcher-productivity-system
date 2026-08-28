//! Recurring task rules — development-plan.md section 23.
//!
//! Owns the `task_recurrence` table and, more importantly, the calendar
//! question every caller actually asks: *does this rule fire on this date?*
//! Materialising the tasks themselves stays in `services::tasks`, which is
//! the only module allowed to write to `tasks`.
//!
//! The five frequencies are deliberately non-overlapping, so a rule reads the
//! same way in the picker and in the database:
//!
//! - `daily` — every day
//! - `weekdays` — Monday to Friday
//! - `weekly` — the chosen weekdays, every `interval` weeks
//! - `monthly` — `day_of_month`, every `interval` months
//! - `custom` — every `interval` days
//!
//! `start_date` is the rule's anchor: `weekly`/`monthly` intervals count from
//! the week/month it falls in, and no occurrence is ever produced before it.
//! `create` and `replace` snap it forward to the first date the rule really
//! fires, so a caller can use `rule.start_date` as the first instance's due
//! date without recomputing anything.
//!
//! All date arithmetic is done by SQLite (`date`, `julianday`, `strftime`)
//! rather than in Rust, which keeps "today" consistent with the
//! `date('now', 'localtime')` comparisons the task views use.

use rusqlite::types::{FromSql, FromSqlError, FromSqlResult, ToSqlOutput, ValueRef};
use rusqlite::{params, Connection, OptionalExtension, Row, ToSql};
use serde::{Deserialize, Serialize};

use super::error::{ServiceError, ServiceResult};
use super::validate::{normalize_text, validate_date, validate_optional_date};

const RECURRENCE_COLUMNS: &str =
    "id, frequency, interval, days_of_week, day_of_month, start_date, end_date, created_at";

/// How far ahead `first_occurrence_on_or_after` will look before giving up.
/// A rule that fires at all fires at least once a year — "every 12 months on
/// the 29th" is the sparsest schedule the picker can express — so a date more
/// than this far out means the rule is unsatisfiable, not merely rare.
const SEARCH_HORIZON_DAYS: i64 = 400;

/// Weekday tokens as stored in `days_of_week`, indexed by SQLite's
/// `strftime('%w')` (0 = Sunday).
const WEEKDAY_TOKENS: [&str; 7] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

// ---------------------------------------------------------------------------
// Frequency
// ---------------------------------------------------------------------------

/// The five options from development-plan.md section 23. Nothing else is
/// accepted by the table's CHECK constraint either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecurrenceFrequency {
    Daily,
    Weekdays,
    Weekly,
    Monthly,
    Custom,
}

impl RecurrenceFrequency {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekdays => "weekdays",
            Self::Weekly => "weekly",
            Self::Monthly => "monthly",
            Self::Custom => "custom",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "daily" => Some(Self::Daily),
            "weekdays" => Some(Self::Weekdays),
            "weekly" => Some(Self::Weekly),
            "monthly" => Some(Self::Monthly),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }

    /// Whether `interval` means anything for this frequency. Daily and
    /// Weekdays fire on a fixed calendar pattern, so their interval is
    /// pinned to 1 rather than being silently ignored.
    fn uses_interval(self) -> bool {
        matches!(self, Self::Weekly | Self::Monthly | Self::Custom)
    }
}

impl ToSql for RecurrenceFrequency {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for RecurrenceFrequency {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        let raw = value.as_str()?;
        Self::parse(raw).ok_or_else(|| {
            FromSqlError::Other(format!("unknown recurrence frequency {raw:?} in database").into())
        })
    }
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

/// A rule as stored. `days_of_week` is exposed as tokens (`["MON", "WED"]`)
/// rather than the `"MON,WED"` string the column holds, so the frontend never
/// has to parse it.
#[derive(Debug, Clone, Serialize)]
pub struct Recurrence {
    pub id: i64,
    pub frequency: RecurrenceFrequency,
    pub interval: i64,
    pub days_of_week: Vec<String>,
    pub day_of_month: Option<i64>,
    /// The first date the rule fires — never merely the date it was created.
    pub start_date: String,
    /// Last date the rule may fire, or null for "forever".
    pub end_date: Option<String>,
    pub created_at: String,
}

impl Recurrence {
    fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        let days_of_week: Option<String> = row.get("days_of_week")?;

        Ok(Self {
            id: row.get("id")?,
            frequency: row.get("frequency")?,
            interval: row.get("interval")?,
            days_of_week: parse_weekday_tokens(days_of_week.as_deref()),
            day_of_month: row.get("day_of_month")?,
            start_date: row.get("start_date")?,
            end_date: row.get("end_date")?,
            created_at: row.get("created_at")?,
        })
    }

    /// The weekdays this rule fires on, as `strftime('%w')` numbers. An empty
    /// selection on a weekly rule falls back to the weekday its `start_date`
    /// lands on, so "repeat weekly" needs no further input from the user.
    fn weekday_numbers(&self, start_weekday: i64) -> Vec<i64> {
        let selected: Vec<i64> = self
            .days_of_week
            .iter()
            .filter_map(|token| weekday_number(token))
            .collect();

        if selected.is_empty() {
            vec![start_weekday]
        } else {
            selected
        }
    }
}

/// Fields accepted when creating or replacing a rule. Everything except
/// `frequency` is optional: the sensible default for each is derived from the
/// anchor date the task supplies.
#[derive(Debug, Clone, Deserialize)]
pub struct NewRecurrence {
    pub frequency: RecurrenceFrequency,
    /// "every N weeks/months/days". Defaults to 1, and must be 1 for `daily`
    /// and `weekdays`.
    #[serde(default)]
    pub interval: Option<i64>,
    /// Weekday tokens (`["MON", "WED", "FRI"]`) for `weekly`.
    #[serde(default)]
    pub days_of_week: Option<Vec<String>>,
    /// 1-31 for `monthly`. Defaults to the anchor date's day. A month too
    /// short for it fires on its last day instead, so a rule set to the 31st
    /// still fires in February.
    #[serde(default)]
    pub day_of_month: Option<i64>,
    /// Defaults to the anchor date the caller passes in (the task's due date,
    /// or today).
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub end_date: Option<String>,
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/// Every rule, oldest first.
pub fn list(conn: &Connection) -> ServiceResult<Vec<Recurrence>> {
    let sql = format!("SELECT {RECURRENCE_COLUMNS} FROM task_recurrence ORDER BY id");
    let mut statement = conn.prepare(&sql)?;
    let rules = statement
        .query_map([], Recurrence::from_row)?
        .collect::<rusqlite::Result<Vec<Recurrence>>>()?;

    Ok(rules)
}

pub fn get(conn: &Connection, id: i64) -> ServiceResult<Option<Recurrence>> {
    let sql = format!("SELECT {RECURRENCE_COLUMNS} FROM task_recurrence WHERE id = ?1");
    conn.query_row(&sql, params![id], Recurrence::from_row)
        .optional()
        .map_err(ServiceError::from)
}

/// Stores a rule and snaps its `start_date` forward to the first date it
/// actually fires on or after `anchor_date` (used when the caller did not
/// supply a `start_date` of its own).
pub fn create(
    conn: &Connection,
    new_rule: NewRecurrence,
    anchor_date: &str,
) -> ServiceResult<Recurrence> {
    let fields = RuleFields::build(new_rule, anchor_date)?;

    conn.execute(
        "INSERT INTO task_recurrence (
            frequency, interval, days_of_week, day_of_month, start_date, end_date
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            fields.frequency,
            fields.interval,
            fields.days_of_week,
            fields.day_of_month,
            fields.start_date,
            fields.end_date,
        ],
    )
    .map_err(|err| ServiceError::from_constraint(err, INVALID_RULE))?;

    anchor_start_date(conn, conn.last_insert_rowid())
}

/// Overwrites an existing rule in place. The row keeps its id — and therefore
/// every task already pointing at it — so editing a schedule re-times the
/// series instead of detaching it.
pub fn replace(
    conn: &Connection,
    id: i64,
    new_rule: NewRecurrence,
    anchor_date: &str,
) -> ServiceResult<Recurrence> {
    get(conn, id)?.ok_or_else(|| rule_not_found(id))?;
    let fields = RuleFields::build(new_rule, anchor_date)?;

    conn.execute(
        "UPDATE task_recurrence
            SET frequency = ?1, interval = ?2, days_of_week = ?3,
                day_of_month = ?4, start_date = ?5, end_date = ?6
          WHERE id = ?7",
        params![
            fields.frequency,
            fields.interval,
            fields.days_of_week,
            fields.day_of_month,
            fields.start_date,
            fields.end_date,
            id,
        ],
    )
    .map_err(|err| ServiceError::from_constraint(err, INVALID_RULE))?;

    anchor_start_date(conn, id)
}

/// Drops a rule. `tasks.recurrence_id` is `ON DELETE SET NULL`, so the tasks
/// already generated from it survive as ordinary one-off tasks — stopping a
/// repeat should not erase the work it produced.
pub fn delete(conn: &Connection, id: i64) -> ServiceResult<()> {
    let deleted = conn.execute("DELETE FROM task_recurrence WHERE id = ?1", params![id])?;
    if deleted == 0 {
        return Err(rule_not_found(id));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The calendar
// ---------------------------------------------------------------------------

/// Whether `rule` fires on `date` (a `YYYY-MM-DD` key).
pub fn occurs_on(conn: &Connection, rule: &Recurrence, date: &str) -> ServiceResult<bool> {
    if date < rule.start_date.as_str() {
        return Ok(false);
    }
    if rule.end_date.as_deref().is_some_and(|end| date > end) {
        return Ok(false);
    }

    let facts = date_facts(conn, date, &rule.start_date, 1)?;
    Ok(facts.first().is_some_and(|day| matches_rule(rule, day)))
}

/// The first date on or after `from_date` that `rule` fires on, or `None` if
/// it never does within [`SEARCH_HORIZON_DAYS`].
pub fn first_occurrence_on_or_after(
    conn: &Connection,
    rule: &Recurrence,
    from_date: &str,
) -> ServiceResult<Option<String>> {
    let from = if from_date < rule.start_date.as_str() {
        rule.start_date.as_str()
    } else {
        from_date
    };

    for day in date_facts(conn, from, &rule.start_date, SEARCH_HORIZON_DAYS)? {
        if rule.end_date.as_deref().is_some_and(|end| day.date.as_str() > end) {
            return Ok(None);
        }
        if matches_rule(rule, &day) {
            return Ok(Some(day.date));
        }
    }

    Ok(None)
}

/// Today in the user's local timezone, as a `YYYY-MM-DD` key. Read from
/// SQLite so it agrees with the `date('now', 'localtime')` comparisons the
/// task views make.
pub fn local_today(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))
}

/// One candidate date and everything the frequency rules need to judge it,
/// all relative to the rule's `start_date`.
struct DayFacts {
    date: String,
    /// `strftime('%w')`: 0 = Sunday.
    weekday: i64,
    day_of_month: i64,
    days_from_start: i64,
    /// Whole weeks between the Sunday-anchored week of `start_date` and of
    /// this date, so "every 2 weeks" counts calendar weeks, not 14-day blocks.
    weeks_from_start: i64,
    months_from_start: i64,
    /// Days in this date's month, used to clamp `day_of_month`.
    days_in_month: i64,
    start_weekday: i64,
    start_day_of_month: i64,
}

/// Whether a rule fires on a single already-computed candidate date. Every
/// frequency's meaning is decided here and nowhere else.
fn matches_rule(rule: &Recurrence, day: &DayFacts) -> bool {
    let interval = rule.interval.max(1);

    match rule.frequency {
        RecurrenceFrequency::Daily => true,
        // Section 23's "Check email — every weekday".
        RecurrenceFrequency::Weekdays => (1..=5).contains(&day.weekday),
        // Section 23's "Study JavaScript — every Monday, Wednesday, Friday".
        RecurrenceFrequency::Weekly => {
            day.weeks_from_start % interval == 0
                && rule
                    .weekday_numbers(day.start_weekday)
                    .contains(&day.weekday)
        }
        RecurrenceFrequency::Monthly => {
            let wanted = rule.day_of_month.unwrap_or(day.start_day_of_month);
            day.months_from_start % interval == 0
                && day.day_of_month == wanted.min(day.days_in_month)
        }
        RecurrenceFrequency::Custom => day.days_from_start % interval == 0,
    }
}

/// Expands `count` consecutive dates starting at `from_date` and has SQLite
/// work out each one's calendar facts relative to `start_date`, in one query.
fn date_facts(
    conn: &Connection,
    from_date: &str,
    start_date: &str,
    count: i64,
) -> ServiceResult<Vec<DayFacts>> {
    // `date(d, '-6 days', 'weekday 0')` is the Sunday on or before `d`:
    // 'weekday 0' jumps forward to the next Sunday (staying put if already
    // Sunday), so stepping back 6 days first lands it inside this week.
    const SQL: &str = "WITH RECURSIVE seq(n) AS (
            SELECT 0 UNION ALL SELECT n + 1 FROM seq WHERE n + 1 < ?3
        ),
        days(day) AS (SELECT date(?1, '+' || n || ' days') FROM seq)
        SELECT
            day,
            CAST(strftime('%w', day) AS INTEGER),
            CAST(strftime('%d', day) AS INTEGER),
            CAST(julianday(day) - julianday(?2) AS INTEGER),
            CAST((julianday(date(day, '-6 days', 'weekday 0'))
                  - julianday(date(?2, '-6 days', 'weekday 0'))) / 7 AS INTEGER),
            (CAST(strftime('%Y', day) AS INTEGER) * 12 + CAST(strftime('%m', day) AS INTEGER))
                - (CAST(strftime('%Y', ?2) AS INTEGER) * 12
                   + CAST(strftime('%m', ?2) AS INTEGER)),
            CAST(strftime('%d', date(day, 'start of month', '+1 month', '-1 day')) AS INTEGER),
            CAST(strftime('%w', ?2) AS INTEGER),
            CAST(strftime('%d', ?2) AS INTEGER)
        FROM days";

    let mut statement = conn.prepare_cached(SQL)?;
    let rows = statement
        .query_map(params![from_date, start_date, count.max(1)], |row| {
            Ok(DayFacts {
                date: row.get(0)?,
                weekday: row.get(1)?,
                day_of_month: row.get(2)?,
                days_from_start: row.get(3)?,
                weeks_from_start: row.get(4)?,
                months_from_start: row.get(5)?,
                days_in_month: row.get(6)?,
                start_weekday: row.get(7)?,
                start_day_of_month: row.get(8)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<DayFacts>>>()?;

    Ok(rows)
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const INVALID_RULE: &str = "That repeat schedule is not one this app can store.";

fn rule_not_found(id: i64) -> ServiceError {
    ServiceError::not_found(format!("Repeat schedule {id} was not found."))
}

/// A validated rule, ready to be written to the columns of the same name.
struct RuleFields {
    frequency: RecurrenceFrequency,
    interval: i64,
    days_of_week: Option<String>,
    day_of_month: Option<i64>,
    start_date: String,
    end_date: Option<String>,
}

impl RuleFields {
    fn build(new_rule: NewRecurrence, anchor_date: &str) -> ServiceResult<Self> {
        let frequency = new_rule.frequency;

        let interval = match new_rule.interval {
            // Silently rewriting the number the user typed would be worse
            // than telling them it does not apply to this frequency.
            Some(value) if !frequency.uses_interval() && value != 1 => {
                return Err(ServiceError::validation(format!(
                    "A {} repeat happens on fixed days, so it has no interval.",
                    frequency.as_str()
                )))
            }
            Some(value) if value < 1 => {
                return Err(ServiceError::validation(
                    "A repeat interval must be at least 1.",
                ))
            }
            Some(value) if value > 366 => {
                return Err(ServiceError::validation(
                    "That repeat interval is too long to ever come around again.",
                ))
            }
            Some(value) => value,
            None => 1,
        };

        let days_of_week = normalize_weekdays(frequency, new_rule.days_of_week)?;
        let day_of_month = match new_rule.day_of_month {
            Some(_) if frequency != RecurrenceFrequency::Monthly => None,
            Some(day) if !(1..=31).contains(&day) => {
                return Err(ServiceError::validation(
                    "A monthly repeat needs a day of the month between 1 and 31.",
                ))
            }
            other => other,
        };

        let start_date = match normalize_text(new_rule.start_date) {
            Some(date) => validate_date("Start date", &date)?,
            None => validate_date("Start date", anchor_date)?,
        };
        let end_date = validate_optional_date("End date", new_rule.end_date)?;

        if end_date.as_deref().is_some_and(|end| end < start_date.as_str()) {
            return Err(ServiceError::validation(
                "A repeat cannot end before it starts.",
            ));
        }

        Ok(Self {
            frequency,
            interval,
            days_of_week,
            day_of_month,
            start_date,
            end_date,
        })
    }
}

/// Uppercases and de-duplicates the weekday tokens, keeping them in calendar
/// order, and drops them entirely for frequencies that do not use them.
fn normalize_weekdays(
    frequency: RecurrenceFrequency,
    days: Option<Vec<String>>,
) -> ServiceResult<Option<String>> {
    let Some(days) = days else { return Ok(None) };
    if frequency != RecurrenceFrequency::Weekly {
        return Ok(None);
    }

    let mut numbers: Vec<i64> = Vec::new();
    for token in days {
        let Some(token) = normalize_text(Some(token)) else {
            continue;
        };
        let number = weekday_number(&token).ok_or_else(|| {
            ServiceError::validation(format!("{token:?} is not a day of the week."))
        })?;
        if !numbers.contains(&number) {
            numbers.push(number);
        }
    }

    if numbers.is_empty() {
        return Ok(None);
    }

    numbers.sort_unstable();
    let tokens: Vec<&str> = numbers
        .into_iter()
        .map(|number| WEEKDAY_TOKENS[number as usize])
        .collect();

    Ok(Some(tokens.join(",")))
}

fn weekday_number(token: &str) -> Option<i64> {
    let token = token.trim().to_ascii_uppercase();
    WEEKDAY_TOKENS
        .iter()
        .position(|candidate| *candidate == token)
        .map(|index| index as i64)
}

fn parse_weekday_tokens(stored: Option<&str>) -> Vec<String> {
    stored
        .unwrap_or_default()
        .split(',')
        .filter_map(weekday_number)
        .map(|number| WEEKDAY_TOKENS[number as usize].to_owned())
        .collect()
}

/// Moves a freshly written rule's `start_date` onto the first date it really
/// fires, so callers can treat it as "the first occurrence" and a week/month
/// interval counts from a date the rule agrees with.
///
/// The search runs with the interval flattened to 1, because the interval has
/// nothing to count from until the series has actually begun: "every 2 weeks
/// on Sunday", set up on a Monday, should start this coming Sunday and then
/// skip a fortnight — not skip a fortnight before it has ever run.
fn anchor_start_date(conn: &Connection, id: i64) -> ServiceResult<Recurrence> {
    let rule = get(conn, id)?.ok_or_else(|| rule_not_found(id))?;
    let start = rule.start_date.clone();

    let mut first_pass = rule.clone();
    first_pass.interval = 1;

    let Some(first) = first_occurrence_on_or_after(conn, &first_pass, &start)? else {
        return Err(ServiceError::validation(
            "That repeat schedule never comes around — check the days and the end date.",
        ));
    };

    if first == rule.start_date {
        return Ok(rule);
    }

    conn.execute(
        "UPDATE task_recurrence SET start_date = ?1 WHERE id = ?2",
        params![first, id],
    )?;
    get(conn, id)?.ok_or_else(|| rule_not_found(id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use serde_json::json;

    fn new_rule(value: serde_json::Value) -> NewRecurrence {
        serde_json::from_value(value).expect("valid NewRecurrence payload")
    }

    /// The dates in `[from, from + days)` that `rule` fires on.
    fn occurrences(conn: &Connection, rule: &Recurrence, from: &str, days: i64) -> Vec<String> {
        date_facts(conn, from, &rule.start_date, days)
            .unwrap()
            .into_iter()
            .filter(|day| {
                day.date >= rule.start_date
                    && rule.end_date.as_deref().map_or(true, |end| day.date.as_str() <= end)
                    && matches_rule(rule, day)
            })
            .map(|day| day.date)
            .collect()
    }

    #[test]
    fn daily_fires_every_day() {
        let conn = init_memory_db().unwrap();
        // 2026-08-31 is a Monday.
        let rule = create(&conn, new_rule(json!({ "frequency": "daily" })), "2026-08-31").unwrap();

        assert_eq!(rule.start_date, "2026-08-31");
        assert_eq!(
            occurrences(&conn, &rule, "2026-08-31", 4),
            vec!["2026-08-31", "2026-09-01", "2026-09-02", "2026-09-03"]
        );
    }

    #[test]
    fn weekdays_skips_the_weekend_and_starts_on_the_next_working_day() {
        let conn = init_memory_db().unwrap();
        // Anchored on a Saturday, so the first instance belongs on Monday.
        let rule =
            create(&conn, new_rule(json!({ "frequency": "weekdays" })), "2026-09-05").unwrap();

        assert_eq!(rule.start_date, "2026-09-07");
        assert_eq!(
            occurrences(&conn, &rule, "2026-09-07", 7),
            vec![
                "2026-09-07",
                "2026-09-08",
                "2026-09-09",
                "2026-09-10",
                "2026-09-11"
            ]
        );
    }

    #[test]
    fn weekly_fires_on_the_chosen_days() {
        let conn = init_memory_db().unwrap();
        let rule = create(
            &conn,
            new_rule(json!({ "frequency": "weekly", "days_of_week": ["fri", "MON", "wed", "mon"] })),
            "2026-08-31",
        )
        .unwrap();

        assert_eq!(rule.days_of_week, vec!["MON", "WED", "FRI"]);
        assert_eq!(
            occurrences(&conn, &rule, "2026-08-31", 14),
            vec![
                "2026-08-31",
                "2026-09-02",
                "2026-09-04",
                "2026-09-07",
                "2026-09-09",
                "2026-09-11"
            ]
        );
    }

    #[test]
    fn weekly_without_days_repeats_on_the_start_date_weekday() {
        let conn = init_memory_db().unwrap();
        let rule = create(&conn, new_rule(json!({ "frequency": "weekly" })), "2026-08-31").unwrap();

        assert!(rule.days_of_week.is_empty());
        assert_eq!(
            occurrences(&conn, &rule, "2026-08-31", 22),
            vec!["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21"]
        );
    }

    #[test]
    fn a_weekly_interval_counts_calendar_weeks() {
        let conn = init_memory_db().unwrap();
        let rule = create(
            &conn,
            new_rule(json!({ "frequency": "weekly", "interval": 2, "days_of_week": ["SUN"] })),
            "2026-08-31",
        )
        .unwrap();

        // Anchored in the week of Mon 31 Aug, so the first Sunday is 6 Sep and
        // the next comes a fortnight later.
        assert_eq!(rule.start_date, "2026-09-06");
        assert_eq!(
            occurrences(&conn, &rule, "2026-09-06", 30),
            vec!["2026-09-06", "2026-09-20", "2026-10-04"]
        );
    }

    #[test]
    fn monthly_clamps_to_the_last_day_of_a_short_month() {
        let conn = init_memory_db().unwrap();
        let rule = create(
            &conn,
            new_rule(json!({ "frequency": "monthly", "day_of_month": 31 })),
            "2026-01-31",
        )
        .unwrap();

        assert_eq!(
            occurrences(&conn, &rule, "2026-01-31", 90),
            vec!["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
        );
    }

    #[test]
    fn custom_repeats_every_n_days() {
        let conn = init_memory_db().unwrap();
        let rule = create(
            &conn,
            new_rule(json!({ "frequency": "custom", "interval": 3 })),
            "2026-08-31",
        )
        .unwrap();

        assert_eq!(
            occurrences(&conn, &rule, "2026-08-31", 10),
            vec!["2026-08-31", "2026-09-03", "2026-09-06", "2026-09-09"]
        );
    }

    #[test]
    fn an_end_date_stops_the_series() {
        let conn = init_memory_db().unwrap();
        let rule = create(
            &conn,
            new_rule(json!({ "frequency": "daily", "end_date": "2026-09-02" })),
            "2026-08-31",
        )
        .unwrap();

        assert!(occurs_on(&conn, &rule, "2026-09-02").unwrap());
        assert!(!occurs_on(&conn, &rule, "2026-09-03").unwrap());
        assert_eq!(
            first_occurrence_on_or_after(&conn, &rule, "2026-09-03").unwrap(),
            None
        );
    }

    #[test]
    fn rejects_schedules_it_cannot_keep() {
        let conn = init_memory_db().unwrap();

        let cases = vec![
            json!({ "frequency": "custom", "interval": 0 }),
            json!({ "frequency": "daily", "interval": 3 }),
            json!({ "frequency": "weekly", "days_of_week": ["MONDAY"] }),
            json!({ "frequency": "monthly", "day_of_month": 32 }),
            json!({ "frequency": "daily", "end_date": "2026-08-01" }),
            json!({ "frequency": "daily", "start_date": "31/08/2026" }),
        ];

        for case in cases {
            let result = create(&conn, new_rule(case.clone()), "2026-08-31");
            assert!(
                matches!(result, Err(ServiceError::Validation(_))),
                "expected {case} to be rejected, got {result:?}"
            );
        }
    }

    #[test]
    fn replacing_a_rule_keeps_its_id_and_re_times_it() {
        let conn = init_memory_db().unwrap();
        let rule = create(&conn, new_rule(json!({ "frequency": "daily" })), "2026-08-31").unwrap();

        let replaced = replace(
            &conn,
            rule.id,
            new_rule(json!({ "frequency": "weekly", "days_of_week": ["SAT"] })),
            "2026-08-31",
        )
        .unwrap();

        assert_eq!(replaced.id, rule.id);
        assert_eq!(replaced.frequency, RecurrenceFrequency::Weekly);
        assert_eq!(replaced.start_date, "2026-09-05");
        assert_eq!(list(&conn).unwrap().len(), 1);
    }

    #[test]
    fn deletes_a_rule_and_reports_a_missing_one() {
        let conn = init_memory_db().unwrap();
        let rule = create(&conn, new_rule(json!({ "frequency": "daily" })), "2026-08-31").unwrap();

        delete(&conn, rule.id).unwrap();
        assert!(get(&conn, rule.id).unwrap().is_none());
        assert!(matches!(
            delete(&conn, rule.id),
            Err(ServiceError::NotFound(_))
        ));
    }
}
