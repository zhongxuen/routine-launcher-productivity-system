//! Calendar integration (development-plan.md sections 53, 54, 92 Tier 5).
//!
//! Section 53 kept a full calendar out and left "optional calendar
//! integration" for later. This is that, kept deliberately small by section
//! 54 ("not a project-management system"):
//!
//! * **In:** events from an iCalendar (`.ics`) file the user picked, or from
//!   an `.ics` feed URL they pasted — every calendar service offers one
//!   ("secret address in iCal format"). Events are shown read-only beside the
//!   day's tasks on Tasks > Today. Nothing is created from them.
//! * **Out:** open tasks with a due date exported as an `.ics` file, which any
//!   calendar can import.
//!
//! No account and no calendar API: a file is read from disk, and a feed is one
//! plain `GET` (made by `commands::calendar`, because the network belongs to
//! the command layer). The app never writes to anyone's calendar.
//!
//! # Occurrences, in local time
//!
//! [`parse`] reads `VEVENT`s; [`expand`] turns each into the occurrences that
//! fall in a window around today ([`WINDOW_DAYS_BEFORE`], [`WINDOW_DAYS_AFTER`])
//! following its `RRULE` (daily, weekly, monthly and yearly, with `INTERVAL`,
//! `COUNT`, `UNTIL`, `BYDAY`, `BYMONTHDAY` and `BYMONTH`), minus its `EXDATE`s
//! and with `RECURRENCE-ID` overrides applied. Those rows replace the source's
//! previous rows in one transaction, so a day's events are a plain lookup.
//!
//! Times written in UTC (`…Z`) are converted to this computer's local time.
//! Times with a `TZID` are taken as local: this app has no time-zone database,
//! and for the common case — a calendar kept in the zone its owner lives in —
//! that is the right answer. A meeting set in another zone shows at its
//! written time, which the Settings card says.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{params, Connection};
use serde::Serialize;

use super::error::{ServiceError, ServiceResult};
use super::settings;
use super::validate::validate_date;

/// Occurrences this many days before today are kept (yesterday's navigation).
pub const WINDOW_DAYS_BEFORE: i64 = 31;
/// … and this many after.
pub const WINDOW_DAYS_AFTER: i64 = 366;
/// A calendar larger than this is refused rather than parsed.
pub const MAX_CALENDAR_BYTES: usize = 10 * 1024 * 1024;
/// A sanity cap on stored occurrences per source.
const MAX_OCCURRENCES: usize = 20_000;
/// A sanity cap on how many periods one rule is stepped through.
const MAX_RULE_STEPS: usize = 50_000;
/// An all-day event longer than this is shown on its first day only.
const MAX_SPAN_DAYS: i64 = 62;

const FEED_URL_KEY: &str = "calendar.feed_url";
const FEED_REFRESHED_AT_KEY: &str = "calendar.feed_refreshed_at";
const FEED_ERROR_KEY: &str = "calendar.feed_error";
const FILE_NAME_KEY: &str = "calendar.file_name";
const FILE_IMPORTED_AT_KEY: &str = "calendar.file_imported_at";

// ---------------------------------------------------------------------------
// Dates without a date library
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 of a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
pub fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let yoe = year - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The inverse of [`days_from_civil`].
pub fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { yoe + era * 400 + 1 } else { yoe + era * 400 }, month, day)
}

/// 0 = Sunday … 6 = Saturday.
pub fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    let (next_year, next_month) = if month == 12 { (year + 1, 1) } else { (year, month + 1) };
    days_from_civil(next_year, next_month, 1) - days_from_civil(year, month, 1)
}

fn format_date(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

fn parse_date_key(key: &str) -> Option<i64> {
    let mut parts = key.split('-');
    let y = parts.next()?.parse().ok()?;
    let m = parts.next()?.parse().ok()?;
    let d = parts.next()?.parse().ok()?;
    Some(days_from_civil(y, m, d))
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// A `DTSTART` / `DTEND` / `EXDATE` / `RECURRENCE-ID` value.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct IcsTime {
    /// Days since the epoch.
    pub days: i64,
    /// Seconds after midnight, or `None` for a date.
    pub seconds: Option<i64>,
    /// Written in UTC (`Z`).
    pub utc: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frequency {
    Daily,
    Weekly,
    Monthly,
    Yearly,
}

/// The parts of an `RRULE` this module follows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
    pub frequency: Frequency,
    pub interval: i64,
    pub count: Option<usize>,
    pub until: Option<IcsTime>,
    /// (ordinal, weekday 0 = Sunday); ordinal 0 means "every".
    pub by_day: Vec<(i64, i64)>,
    pub by_month_day: Vec<i64>,
    pub by_month: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct IcsEvent {
    pub uid: Option<String>,
    pub title: String,
    pub location: Option<String>,
    pub start: Option<IcsTime>,
    pub end: Option<IcsTime>,
    /// From `DURATION`, used when there is no `DTEND`.
    pub duration_seconds: Option<i64>,
    pub rule: Option<Rule>,
    pub exdates: Vec<IcsTime>,
    pub recurrence_id: Option<IcsTime>,
    pub cancelled: bool,
}

/// Reads every `VEVENT` in a calendar. Refuses text that is not a calendar.
pub fn parse(text: &str) -> ServiceResult<Vec<IcsEvent>> {
    if text.len() > MAX_CALENDAR_BYTES {
        return Err(ServiceError::validation("That calendar is too large to read."));
    }
    let text = text.trim_start_matches('\u{feff}');
    if !text.trim_start().to_ascii_uppercase().starts_with("BEGIN:VCALENDAR") {
        return Err(ServiceError::validation(
            "That is not an iCalendar (.ics) calendar.",
        ));
    }

    // Unfold: a line starting with a space or tab continues the one before.
    let mut lines: Vec<String> = Vec::new();
    for raw in text.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        if (raw.starts_with(' ') || raw.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap().push_str(&raw[1..]);
        } else {
            lines.push(raw.to_string());
        }
    }

    let mut events = Vec::new();
    let mut current: Option<IcsEvent> = None;
    // Depth of components nested inside the event (VALARM), whose
    // properties are not the event's.
    let mut nested = 0usize;

    for line in lines {
        let Some((name, params, value)) = split_property(&line) else {
            continue;
        };

        match (name.as_str(), value.to_ascii_uppercase().as_str()) {
            ("BEGIN", "VEVENT") => {
                current = Some(IcsEvent::default());
                nested = 0;
                continue;
            }
            ("END", "VEVENT") => {
                if let Some(event) = current.take() {
                    if event.start.is_some() {
                        events.push(event);
                    }
                }
                continue;
            }
            ("BEGIN", _) if current.is_some() => {
                nested += 1;
                continue;
            }
            ("END", _) if current.is_some() => {
                nested = nested.saturating_sub(1);
                continue;
            }
            _ => {}
        }

        let Some(event) = current.as_mut() else {
            continue;
        };
        if nested > 0 {
            continue;
        }

        match name.as_str() {
            "UID" => event.uid = Some(value.trim().to_string()),
            "SUMMARY" => event.title = unescape(&value),
            "LOCATION" => {
                let location = unescape(&value);
                event.location = (!location.trim().is_empty()).then_some(location);
            }
            "DTSTART" => event.start = parse_time(&value, &params),
            "DTEND" => event.end = parse_time(&value, &params),
            "DURATION" => event.duration_seconds = parse_duration(&value),
            "RRULE" => event.rule = parse_rule(&value),
            "EXDATE" => {
                for part in value.split(',') {
                    if let Some(time) = parse_time(part, &params) {
                        event.exdates.push(time);
                    }
                }
            }
            "RECURRENCE-ID" => event.recurrence_id = parse_time(&value, &params),
            "STATUS" => event.cancelled = value.trim().eq_ignore_ascii_case("CANCELLED"),
            _ => {}
        }
    }

    Ok(events)
}

/// `NAME;PARAM=V;…:value` → (upper-case name, upper-case params, value).
fn split_property(line: &str) -> Option<(String, BTreeMap<String, String>, String)> {
    let mut in_quotes = false;
    let mut colon = None;
    for (index, c) in line.char_indices() {
        match c {
            '"' => in_quotes = !in_quotes,
            ':' if !in_quotes => {
                colon = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon = colon?;
    let (head, value) = (&line[..colon], &line[colon + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.trim().to_ascii_uppercase();
    let params = parts
        .filter_map(|part| part.split_once('='))
        .map(|(key, value)| (key.trim().to_ascii_uppercase(), value.trim_matches('"').to_string()))
        .collect();
    Some((name, params, value.to_string()))
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n') | Some('N') => out.push(' '),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out.trim().to_string()
}

/// `20260916`, `20260916T093000` or `20260916T093000Z`.
fn parse_time(value: &str, params: &BTreeMap<String, String>) -> Option<IcsTime> {
    let value = value.trim();
    let digits = |s: &str| -> Option<i64> {
        (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok())?
    };
    if value.len() < 8 {
        return None;
    }
    let year = digits(value.get(0..4)?)?;
    let month = digits(value.get(4..6)?)?;
    let day = digits(value.get(6..8)?)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let days = days_from_civil(year, month, day);

    let is_date = params.get("VALUE").is_some_and(|v| v.eq_ignore_ascii_case("DATE")) || value.len() == 8;
    if is_date {
        return Some(IcsTime { days, seconds: None, utc: false });
    }

    let time = value.get(9..)?;
    let utc = time.ends_with('Z') || time.ends_with('z');
    let time = time.trim_end_matches(['Z', 'z']);
    if time.len() < 4 {
        return None;
    }
    let hour = digits(time.get(0..2)?)?;
    let minute = digits(time.get(2..4)?)?;
    let second = time.get(4..6).and_then(digits).unwrap_or(0);
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(IcsTime { days, seconds: Some(hour * 3600 + minute * 60 + second), utc })
}

/// `PT1H30M`, `P1D`, `P2W`, `-PT15M` (negative is ignored).
fn parse_duration(value: &str) -> Option<i64> {
    let value = value.trim();
    if value.starts_with('-') {
        return None;
    }
    let value = value.trim_start_matches('+').strip_prefix('P')?;
    let mut total = 0i64;
    let mut number = String::new();
    let mut in_time = false;
    for c in value.chars() {
        match c {
            'T' => in_time = true,
            '0'..='9' => number.push(c),
            unit => {
                let n: i64 = number.parse().ok()?;
                number.clear();
                total += match (unit, in_time) {
                    ('W', _) => n * 7 * 86_400,
                    ('D', _) => n * 86_400,
                    ('H', true) => n * 3600,
                    ('M', true) => n * 60,
                    ('S', true) => n,
                    _ => return None,
                };
            }
        }
    }
    Some(total)
}

fn parse_rule(value: &str) -> Option<Rule> {
    let mut rule = Rule {
        frequency: Frequency::Daily,
        interval: 1,
        count: None,
        until: None,
        by_day: Vec::new(),
        by_month_day: Vec::new(),
        by_month: Vec::new(),
    };
    let mut frequency = None;

    for part in value.split(';') {
        let Some((key, val)) = part.split_once('=') else {
            continue;
        };
        match key.trim().to_ascii_uppercase().as_str() {
            "FREQ" => {
                frequency = match val.trim().to_ascii_uppercase().as_str() {
                    "DAILY" => Some(Frequency::Daily),
                    "WEEKLY" => Some(Frequency::Weekly),
                    "MONTHLY" => Some(Frequency::Monthly),
                    "YEARLY" => Some(Frequency::Yearly),
                    // Hourly and finer are not calendar days; shown once.
                    _ => None,
                }
            }
            "INTERVAL" => rule.interval = val.trim().parse().ok().filter(|n: &i64| *n >= 1)?,
            "COUNT" => rule.count = val.trim().parse().ok(),
            "UNTIL" => rule.until = parse_time(val, &BTreeMap::new()),
            "BYDAY" => {
                for token in val.split(',') {
                    let token = token.trim().to_ascii_uppercase();
                    if token.len() < 2 {
                        continue;
                    }
                    let (ordinal, name) = token.split_at(token.len() - 2);
                    let weekday = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
                        .iter()
                        .position(|day| *day == name)? as i64;
                    let ordinal = if ordinal.is_empty() { 0 } else { ordinal.trim_start_matches('+').parse().ok()? };
                    rule.by_day.push((ordinal, weekday));
                }
            }
            "BYMONTHDAY" => {
                rule.by_month_day = val.split(',').filter_map(|n| n.trim().parse().ok()).collect()
            }
            "BYMONTH" => rule.by_month = val.split(',').filter_map(|n| n.trim().parse().ok()).collect(),
            _ => {}
        }
    }

    rule.frequency = frequency?;
    Some(rule)
}

// ---------------------------------------------------------------------------
// Expansion
// ---------------------------------------------------------------------------

/// One occurrence in local time, ready to store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Occurrence {
    pub uid: Option<String>,
    pub title: String,
    pub location: Option<String>,
    pub date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
}

/// Converts a UTC wall-clock moment (days, seconds) to local time. The
/// production one asks SQLite; tests pass one that shifts by a fixed offset.
pub type ToLocal<'a> = &'a dyn Fn(i64, i64) -> (i64, i64);

/// Every occurrence of `events` whose local date is in `[from, to]`.
pub fn expand(events: &[IcsEvent], from: i64, to: i64, to_local: ToLocal<'_>) -> Vec<Occurrence> {
    // RECURRENCE-ID overrides, by UID: the original starts they replace.
    let mut overridden: BTreeMap<String, BTreeSet<(i64, Option<i64>)>> = BTreeMap::new();
    for event in events {
        if let (Some(uid), Some(recurrence_id)) = (&event.uid, event.recurrence_id) {
            overridden
                .entry(uid.clone())
                .or_default()
                .insert((recurrence_id.days, recurrence_id.seconds));
        }
    }

    let mut out = Vec::new();
    for event in events {
        if event.cancelled {
            continue;
        }
        let Some(start) = event.start else {
            continue;
        };

        let starts: Vec<IcsTime> = match (&event.rule, event.recurrence_id) {
            (Some(rule), None) => rule_starts(start, rule, to + 1),
            _ => vec![start],
        };

        let skipped = event.uid.as_ref().and_then(|uid| overridden.get(uid));
        for occurrence in starts {
            if event.recurrence_id.is_none() {
                if skipped.is_some_and(|set| {
                    set.contains(&(occurrence.days, occurrence.seconds))
                        || set.contains(&(occurrence.days, None))
                }) {
                    continue;
                }
                if event.exdates.iter().any(|ex| {
                    ex.days == occurrence.days && (ex.seconds.is_none() || ex.seconds == occurrence.seconds)
                }) {
                    continue;
                }
            }
            push_occurrence(&mut out, event, start, occurrence, from, to, to_local);
            if out.len() >= MAX_OCCURRENCES {
                return out;
            }
        }
    }

    out.sort_by(|a, b| {
        (&a.date, !a.all_day, &a.start_time, &a.title).cmp(&(&b.date, !b.all_day, &b.start_time, &b.title))
    });
    out
}

fn push_occurrence(
    out: &mut Vec<Occurrence>,
    event: &IcsEvent,
    original_start: IcsTime,
    occurrence: IcsTime,
    from: i64,
    to: i64,
    to_local: ToLocal<'_>,
) {
    let title = if event.title.trim().is_empty() { "(No title)".to_string() } else { event.title.clone() };

    match occurrence.seconds {
        None => {
            // All day. DTEND is exclusive; a missing one means one day.
            let span = match event.end {
                Some(end) if end.seconds.is_none() => (end.days - original_start.days).clamp(1, MAX_SPAN_DAYS),
                _ => event
                    .duration_seconds
                    .map(|seconds| (seconds / 86_400).clamp(1, MAX_SPAN_DAYS))
                    .unwrap_or(1),
            };
            for offset in 0..span {
                let day = occurrence.days + offset;
                if day < from || day > to {
                    continue;
                }
                out.push(Occurrence {
                    uid: event.uid.clone(),
                    title: title.clone(),
                    location: event.location.clone(),
                    date: format_date(day),
                    start_time: None,
                    end_time: None,
                    all_day: true,
                });
            }
        }
        Some(seconds) => {
            let length = match (event.end, original_start.seconds) {
                (Some(end), Some(start_seconds)) if end.seconds.is_some() => {
                    (end.days - original_start.days) * 86_400 + end.seconds.unwrap_or(0) - start_seconds
                }
                _ => event.duration_seconds.unwrap_or(0),
            }
            .max(0);

            let local = |days: i64, secs: i64, utc: bool| -> (i64, i64) {
                let days = days + secs.div_euclid(86_400);
                let secs = secs.rem_euclid(86_400);
                if utc { to_local(days, secs) } else { (days, secs) }
            };
            let (start_day, start_secs) = local(occurrence.days, seconds, occurrence.utc);
            if start_day < from || start_day > to {
                return;
            }
            let (end_day, end_secs) = local(occurrence.days, seconds + length, occurrence.utc);

            out.push(Occurrence {
                uid: event.uid.clone(),
                title,
                location: event.location.clone(),
                date: format_date(start_day),
                start_time: Some(hhmm(start_secs)),
                // An event that ends on a later day shows no end on this one.
                end_time: (length > 0 && end_day == start_day).then(|| hhmm(end_secs)),
                all_day: false,
            });
        }
    }
}

fn hhmm(seconds: i64) -> String {
    format!("{:02}:{:02}", seconds / 3600, (seconds % 3600) / 60)
}

/// The starts a rule produces from `start`, stopping before day `stop`.
fn rule_starts(start: IcsTime, rule: &Rule, stop: i64) -> Vec<IcsTime> {
    let (start_year, start_month, start_day) = civil_from_days(start.days);
    let until = rule.until.map(|until| until.days);
    let mut out = Vec::new();
    let mut emitted = 0usize;

    let mut emit = |day: i64, out: &mut Vec<IcsTime>| -> bool {
        // Returns false once the rule is exhausted.
        if day < start.days {
            return true;
        }
        if until.is_some_and(|until| day > until) || day >= stop {
            return false;
        }
        if rule.count.is_some_and(|count| emitted >= count) {
            return false;
        }
        emitted += 1;
        out.push(IcsTime { days: day, ..start });
        true
    };

    let monthly_days = |year: i64, month: i64| -> Vec<i64> {
        let first = days_from_civil(year, month, 1);
        let length = days_in_month(year, month);
        let mut days: BTreeSet<i64> = BTreeSet::new();
        if !rule.by_day.is_empty() {
            for &(ordinal, wd) in &rule.by_day {
                let matching: Vec<i64> =
                    (0..length).map(|offset| first + offset).filter(|day| weekday(*day) == wd).collect();
                match ordinal {
                    0 => days.extend(matching),
                    n if n > 0 => {
                        if let Some(day) = matching.get((n - 1) as usize) {
                            days.insert(*day);
                        }
                    }
                    n => {
                        let index = matching.len() as i64 + n;
                        if index >= 0 {
                            days.insert(matching[index as usize]);
                        }
                    }
                }
            }
        } else if !rule.by_month_day.is_empty() {
            for &n in &rule.by_month_day {
                let day = if n > 0 { n } else { length + n + 1 };
                if (1..=length).contains(&day) {
                    days.insert(first + day - 1);
                }
            }
        } else if start_day <= length {
            days.insert(first + start_day - 1);
        }
        days.into_iter().collect()
    };

    for step in 0..MAX_RULE_STEPS as i64 {
        let k = step * rule.interval;
        let candidates: Vec<i64> = match rule.frequency {
            Frequency::Daily => vec![start.days + k],
            Frequency::Weekly => {
                // Weeks start on Monday (the RFC's default WKST).
                let monday = start.days - (weekday(start.days) + 6) % 7 + 7 * k;
                let mut days: Vec<i64> = if rule.by_day.is_empty() {
                    vec![monday + (weekday(start.days) + 6) % 7]
                } else {
                    rule.by_day.iter().map(|&(_, wd)| monday + (wd + 6) % 7).collect()
                };
                days.sort_unstable();
                days.dedup();
                days
            }
            Frequency::Monthly => {
                let index = start_year * 12 + (start_month - 1) + k;
                monthly_days(index.div_euclid(12), index.rem_euclid(12) + 1)
            }
            Frequency::Yearly => {
                let year = start_year + k;
                let months = if rule.by_month.is_empty() { vec![start_month] } else { rule.by_month.clone() };
                months
                    .into_iter()
                    .filter(|month| (1..=12).contains(month))
                    .flat_map(|month| monthly_days(year, month))
                    .collect()
            }
        };

        let first_candidate = candidates.first().copied();
        for day in candidates {
            if !emit(day, &mut out) {
                return out;
            }
        }
        // A period that starts past the stop day ends the rule even when it
        // produced nothing (a February 30th).
        let period_start = match rule.frequency {
            Frequency::Daily | Frequency::Weekly => first_candidate.unwrap_or(start.days + k),
            Frequency::Monthly => {
                let index = start_year * 12 + (start_month - 1) + k;
                days_from_civil(index.div_euclid(12), index.rem_euclid(12) + 1, 1)
            }
            Frequency::Yearly => days_from_civil(start_year + k, 1, 1),
        };
        if period_start >= stop || until.is_some_and(|until| period_start > until) {
            return out;
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    File,
    Feed,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Self::File => "file",
            Self::Feed => "feed",
        }
    }
}

/// A stored occurrence, as Tasks > Today shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub id: i64,
    pub source: String,
    pub title: String,
    pub location: Option<String>,
    pub date: String,
    pub start_time: Option<String>,
    pub end_time: Option<String>,
    pub all_day: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarStatus {
    pub feed_url: Option<String>,
    /// UTC, the last successful refresh.
    pub feed_refreshed_at: Option<String>,
    /// Why the last refresh failed, if it did.
    pub feed_error: Option<String>,
    pub feed_events: i64,
    pub file_name: Option<String>,
    pub file_imported_at: Option<String>,
    pub file_events: i64,
}

fn count(conn: &Connection, source: Source) -> ServiceResult<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM calendar_events WHERE source = ?1",
        [source.as_str()],
        |row| row.get(0),
    )?)
}

pub fn status(conn: &Connection) -> ServiceResult<CalendarStatus> {
    Ok(CalendarStatus {
        feed_url: settings::get(conn, FEED_URL_KEY)?,
        feed_refreshed_at: settings::get(conn, FEED_REFRESHED_AT_KEY)?,
        feed_error: settings::get(conn, FEED_ERROR_KEY)?,
        feed_events: count(conn, Source::Feed)?,
        file_name: settings::get(conn, FILE_NAME_KEY)?,
        file_imported_at: settings::get(conn, FILE_IMPORTED_AT_KEY)?,
        file_events: count(conn, Source::File)?,
    })
}

/// The production [`ToLocal`]: SQLite's own `'localtime'`, which knows this
/// computer's zone and its daylight-saving rules.
fn sqlite_to_local(conn: &Connection) -> impl Fn(i64, i64) -> (i64, i64) + '_ {
    move |days, seconds| {
        let utc = format!("{} {}", format_date(days), {
            let s = seconds.rem_euclid(86_400);
            format!("{:02}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
        });
        let local: Option<String> = conn
            .query_row("SELECT datetime(?1, 'localtime')", [utc], |row| row.get(0))
            .ok();
        local
            .and_then(|local| {
                let date = parse_date_key(local.get(0..10)?)?;
                let hour: i64 = local.get(11..13)?.parse().ok()?;
                let minute: i64 = local.get(14..16)?.parse().ok()?;
                let second: i64 = local.get(17..19)?.parse().ok()?;
                Some((date, hour * 3600 + minute * 60 + second))
            })
            .unwrap_or((days, seconds))
    }
}

/// Parses `text` and replaces `source`'s stored occurrences with it, in one
/// transaction. Answers how many occurrences were stored.
pub fn store(conn: &Connection, source: Source, text: &str) -> ServiceResult<usize> {
    let events = parse(text)?;
    let today: String = conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
    let today = parse_date_key(&today).unwrap_or(0);

    let to_local = sqlite_to_local(conn);
    let occurrences = expand(&events, today - WINDOW_DAYS_BEFORE, today + WINDOW_DAYS_AFTER, &to_local);

    let transaction = conn.unchecked_transaction()?;
    transaction.execute("DELETE FROM calendar_events WHERE source = ?1", [source.as_str()])?;
    {
        let mut insert = transaction.prepare(
            "INSERT INTO calendar_events
                 (source, uid, title, location, date, start_time, end_time, all_day)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for occurrence in &occurrences {
            insert.execute(params![
                source.as_str(),
                occurrence.uid,
                occurrence.title,
                occurrence.location,
                occurrence.date,
                occurrence.start_time,
                occurrence.end_time,
                occurrence.all_day,
            ])?;
        }
    }
    transaction.commit()?;
    Ok(occurrences.len())
}

/// Imports a calendar file the user picked. Replaces the previous file's events.
pub fn import_file(conn: &Connection, path: &str) -> ServiceResult<CalendarStatus> {
    let bytes = std::fs::read(path)
        .map_err(|e| ServiceError::validation(format!("Could not read {path}: {e}")))?;
    if bytes.len() > MAX_CALENDAR_BYTES {
        return Err(ServiceError::validation("That calendar is too large to read."));
    }
    let text = String::from_utf8_lossy(&bytes);
    store(conn, Source::File, &text)?;

    let name = std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    settings::set(conn, FILE_NAME_KEY, &name)?;
    let now: String = conn.query_row("SELECT datetime('now')", [], |row| row.get(0))?;
    settings::set(conn, FILE_IMPORTED_AT_KEY, &now)?;
    status(conn)
}

/// Removes a source's events and what is remembered about it.
pub fn clear(conn: &Connection, source: Source) -> ServiceResult<CalendarStatus> {
    conn.execute("DELETE FROM calendar_events WHERE source = ?1", [source.as_str()])?;
    let keys: &[&str] = match source {
        Source::File => &[FILE_NAME_KEY, FILE_IMPORTED_AT_KEY],
        Source::Feed => &[FEED_URL_KEY, FEED_REFRESHED_AT_KEY, FEED_ERROR_KEY],
    };
    for key in keys {
        conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
    }
    status(conn)
}

/// Checks a feed address and returns the `https://` URL to fetch.
///
/// `webcal://` is how calendar services label their feeds, and means https.
/// Plain `http://` is accepted because some self-hosted calendars use it.
pub fn normalize_feed_url(url: &str) -> ServiceResult<String> {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    let normalized = if let Some(rest) = lower.strip_prefix("webcal://") {
        format!("https://{}", &url[url.len() - rest.len()..])
    } else if lower.starts_with("https://") || lower.starts_with("http://") {
        url.to_string()
    } else {
        return Err(ServiceError::validation(
            "A calendar feed address starts with https:// or webcal://.",
        ));
    };
    let host = normalized.split("://").nth(1).unwrap_or_default();
    if host.is_empty() || host.starts_with('/') || normalized.chars().any(char::is_whitespace) {
        return Err(ServiceError::validation("That calendar feed address is not complete."));
    }
    if normalized.len() > 2048 {
        return Err(ServiceError::validation("That calendar feed address is too long."));
    }
    Ok(normalized)
}

/// The stored feed address, if any.
pub fn feed_url(conn: &Connection) -> ServiceResult<Option<String>> {
    settings::get(conn, FEED_URL_KEY)
}

/// Stores a feed address. Its events arrive with the first refresh.
pub fn set_feed_url(conn: &Connection, url: &str) -> ServiceResult<String> {
    let normalized = normalize_feed_url(url)?;
    if feed_url(conn)?.as_deref() != Some(normalized.as_str()) {
        conn.execute("DELETE FROM calendar_events WHERE source = 'feed'", [])?;
        conn.execute(
            "DELETE FROM settings WHERE key IN (?1, ?2)",
            [FEED_REFRESHED_AT_KEY, FEED_ERROR_KEY],
        )?;
    }
    settings::set(conn, FEED_URL_KEY, &normalized)?;
    Ok(normalized)
}

/// Records the outcome of a fetch: the feed's text, or why it failed. A failed
/// refresh keeps the events from the last good one.
pub fn record_feed(conn: &Connection, fetched: Result<String, String>) -> ServiceResult<CalendarStatus> {
    let outcome = fetched.and_then(|text| store(conn, Source::Feed, &text).map_err(|e| e.to_string()));
    match outcome {
        Ok(_) => {
            let now: String = conn.query_row("SELECT datetime('now')", [], |row| row.get(0))?;
            settings::set(conn, FEED_REFRESHED_AT_KEY, &now)?;
            conn.execute("DELETE FROM settings WHERE key = ?1", [FEED_ERROR_KEY])?;
        }
        Err(error) => settings::set(conn, FEED_ERROR_KEY, &error)?,
    }
    status(conn)
}

/// A day's events: all-day ones first, then by start time.
pub fn list_for_date(conn: &Connection, date: &str) -> ServiceResult<Vec<CalendarEvent>> {
    let date = validate_date("Calendar date", date)?;
    let mut statement = conn.prepare(
        "SELECT id, source, title, location, date, start_time, end_time, all_day
           FROM calendar_events
          WHERE date = ?1
          ORDER BY all_day DESC, start_time, title, id",
    )?;
    let events = statement
        .query_map([date], |row| {
            Ok(CalendarEvent {
                id: row.get("id")?,
                source: row.get("source")?,
                title: row.get("title")?,
                location: row.get("location")?,
                date: row.get("date")?,
                start_time: row.get("start_time")?,
                end_time: row.get("end_time")?,
                all_day: row.get("all_day")?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(events)
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// The file name export suggests.
pub const EXPORT_FILE_NAME: &str = "routine-launcher-tasks.ics";

/// Open tasks with a due date as an iCalendar. Answers the text and how many
/// tasks it holds.
///
/// A task with a due time becomes an event of its estimate (30 minutes when
/// it has none) at that time, in floating local time; one without becomes an
/// all-day event. The UID is stable per task, so importing a newer export
/// updates the events rather than duplicating them in calendars that honour
/// UIDs.
pub fn tasks_ics(conn: &Connection) -> ServiceResult<(String, usize)> {
    let mut statement = conn.prepare(
        "SELECT id, title, description, due_date, due_time, estimated_minutes
           FROM tasks
          WHERE due_date IS NOT NULL AND status IN ('todo', 'in_progress')
          ORDER BY due_date, due_time, id",
    )?;
    let tasks = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let stamp: String = conn.query_row("SELECT strftime('%Y%m%dT%H%M%SZ', 'now')", [], |row| row.get(0))?;

    let mut lines = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//Routine Launcher//Tasks//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
        "X-WR-CALNAME:Routine Launcher tasks".to_string(),
    ];

    for (id, title, description, due_date, due_time, estimate) in &tasks {
        let Some(day) = parse_date_key(due_date) else {
            continue;
        };
        let compact = |days: i64| format_date(days).replace('-', "");
        lines.push("BEGIN:VEVENT".into());
        lines.push(format!("UID:task-{id}@routine-launcher"));
        lines.push(format!("DTSTAMP:{stamp}"));
        match due_time.as_deref().and_then(|time| {
            let (h, m) = time.split_once(':')?;
            Some((h.parse::<i64>().ok()?, m.parse::<i64>().ok()?))
        }) {
            Some((hour, minute)) => {
                lines.push(format!("DTSTART:{}T{hour:02}{minute:02}00", compact(day)));
                lines.push(format!("DURATION:PT{}M", estimate.filter(|m| *m > 0).unwrap_or(30)));
            }
            None => {
                lines.push(format!("DTSTART;VALUE=DATE:{}", compact(day)));
                lines.push(format!("DTEND;VALUE=DATE:{}", compact(day + 1)));
            }
        }
        lines.push(format!("SUMMARY:{}", escape(title)));
        if let Some(description) = description.as_deref().filter(|d| !d.trim().is_empty()) {
            lines.push(format!("DESCRIPTION:{}", escape(description)));
        }
        lines.push("END:VEVENT".into());
    }
    lines.push("END:VCALENDAR".into());

    let text = lines.iter().map(|line| fold(line)).collect::<Vec<_>>().join("\r\n") + "\r\n";
    Ok((text, tasks.len()))
}

/// Writes [`tasks_ics`] to `path`. Answers how many tasks went in.
pub fn export_tasks(conn: &Connection, path: &str) -> ServiceResult<usize> {
    let (text, count) = tasks_ics(conn)?;
    std::fs::write(path, text)
        .map_err(|e| ServiceError::validation(format!("Could not write {path}: {e}")))?;
    Ok(count)
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace("\r\n", "\\n")
        .replace('\n', "\\n")
}

/// RFC 5545's 75-octet line folding, never splitting a character.
fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + 8);
    let mut width = 0;
    for c in line.chars() {
        let len = c.len_utf8();
        if width + len > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += len;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;

    fn day(y: i64, m: i64, d: i64) -> i64 {
        days_from_civil(y, m, d)
    }

    fn no_shift(days: i64, seconds: i64) -> (i64, i64) {
        (days, seconds)
    }

    fn calendar(body: &str) -> String {
        format!("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n{body}\r\nEND:VCALENDAR\r\n")
    }

    fn dates(occurrences: &[Occurrence]) -> Vec<&str> {
        occurrences.iter().map(|o| o.date.as_str()).collect()
    }

    #[test]
    fn civil_dates_round_trip() {
        for days in [-1000, 0, 1, 20_000, day(2026, 2, 28), day(2024, 2, 29)] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
        assert_eq!(weekday(day(2026, 9, 16)), 3, "a Wednesday");
        assert_eq!(days_in_month(2024, 2), 29);
        assert_eq!(days_in_month(2026, 2), 28);
    }

    #[test]
    fn a_calendar_with_folded_lines_and_escapes_is_read() {
        let text = calendar(
            "BEGIN:VEVENT\r\nUID:1@x\r\nSUMMARY:Plan\\, review\r\n  and ship\r\nLOCATION:Room \\;2\r\n\
             DTSTART:20260916T093000\r\nDTEND:20260916T101500\r\n\
             BEGIN:VALARM\r\nSUMMARY:Not the title\r\nEND:VALARM\r\nEND:VEVENT",
        );
        let events = parse(&text).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].title, "Plan, review and ship");
        assert_eq!(events[0].location.as_deref(), Some("Room ;2"));

        let occurrences = expand(&events, day(2026, 9, 1), day(2026, 9, 30), &no_shift);
        assert_eq!(
            occurrences,
            vec![Occurrence {
                uid: Some("1@x".into()),
                title: "Plan, review and ship".into(),
                location: Some("Room ;2".into()),
                date: "2026-09-16".into(),
                start_time: Some("09:30".into()),
                end_time: Some("10:15".into()),
                all_day: false,
            }]
        );
    }

    #[test]
    fn not_a_calendar_is_refused() {
        assert!(parse("hello").is_err());
        assert!(parse("<html>").is_err());
    }

    #[test]
    fn utc_times_are_moved_to_local_time() {
        let text = calendar("BEGIN:VEVENT\r\nSUMMARY:Call\r\nDTSTART:20260916T233000Z\r\nDURATION:PT1H\r\nEND:VEVENT");
        let events = parse(&text).unwrap();
        // UTC+8: 23:30 UTC is 07:30 the next morning.
        let plus_eight = |days: i64, seconds: i64| {
            let total = seconds + 8 * 3600;
            (days + total.div_euclid(86_400), total.rem_euclid(86_400))
        };
        let occurrences = expand(&events, day(2026, 9, 1), day(2026, 9, 30), &plus_eight);
        assert_eq!(dates(&occurrences), ["2026-09-17"]);
        assert_eq!(occurrences[0].start_time.as_deref(), Some("07:30"));
        assert_eq!(occurrences[0].end_time.as_deref(), Some("08:30"));
    }

    #[test]
    fn all_day_events_cover_each_of_their_days() {
        let text = calendar(
            "BEGIN:VEVENT\r\nSUMMARY:Trip\r\nDTSTART;VALUE=DATE:20260918\r\nDTEND;VALUE=DATE:20260921\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&text).unwrap(), day(2026, 9, 1), day(2026, 9, 30), &no_shift);
        assert_eq!(dates(&occurrences), ["2026-09-18", "2026-09-19", "2026-09-20"]);
        assert!(occurrences.iter().all(|o| o.all_day && o.start_time.is_none()));
    }

    #[test]
    fn a_weekly_rule_with_days_exceptions_and_an_override() {
        let text = calendar(
            "BEGIN:VEVENT\r\nUID:standup\r\nSUMMARY:Stand-up\r\nDTSTART:20260907T090000\r\nDTEND:20260907T091500\r\n\
             RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=9\r\nEXDATE:20260911T090000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nUID:standup\r\nRECURRENCE-ID:20260916T090000\r\nSUMMARY:Stand-up (moved)\r\n\
             DTSTART:20260916T110000\r\nDTEND:20260916T111500\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&text).unwrap(), day(2026, 9, 1), day(2026, 9, 30), &no_shift);
        let summary: Vec<(&str, &str)> = occurrences
            .iter()
            .map(|o| (o.date.as_str(), o.start_time.as_deref().unwrap()))
            .collect();
        // Nine occurrences from Monday the 7th, less the 11th (excluded) and
        // the 16th at 9 (moved to 11).
        assert_eq!(
            summary,
            [
                ("2026-09-07", "09:00"),
                ("2026-09-09", "09:00"),
                ("2026-09-14", "09:00"),
                ("2026-09-16", "11:00"),
                ("2026-09-18", "09:00"),
                ("2026-09-21", "09:00"),
                ("2026-09-23", "09:00"),
                ("2026-09-25", "09:00"),
            ]
        );
    }

    #[test]
    fn monthly_and_yearly_rules() {
        let every_last_friday = calendar(
            "BEGIN:VEVENT\r\nSUMMARY:Review\r\nDTSTART;VALUE=DATE:20260130\r\nRRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20260430\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&every_last_friday).unwrap(), day(2026, 1, 1), day(2026, 12, 31), &no_shift);
        assert_eq!(dates(&occurrences), ["2026-01-30", "2026-02-27", "2026-03-27", "2026-04-24"]);

        let the_31st = calendar(
            "BEGIN:VEVENT\r\nSUMMARY:Rent\r\nDTSTART;VALUE=DATE:20260131\r\nRRULE:FREQ=MONTHLY;COUNT=4\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&the_31st).unwrap(), day(2026, 1, 1), day(2026, 12, 31), &no_shift);
        // Months without a 31st are skipped, as the RFC says.
        assert_eq!(dates(&occurrences), ["2026-01-31", "2026-03-31", "2026-05-31", "2026-07-31"]);

        let birthday = calendar(
            "BEGIN:VEVENT\r\nSUMMARY:Birthday\r\nDTSTART;VALUE=DATE:20200916\r\nRRULE:FREQ=YEARLY\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&birthday).unwrap(), day(2026, 1, 1), day(2027, 12, 31), &no_shift);
        assert_eq!(dates(&occurrences), ["2026-09-16", "2027-09-16"]);

        let fortnightly = calendar(
            "BEGIN:VEVENT\r\nSUMMARY:Payday\r\nDTSTART;VALUE=DATE:20260904\r\nRRULE:FREQ=DAILY;INTERVAL=14\r\nEND:VEVENT",
        );
        let occurrences = expand(&parse(&fortnightly).unwrap(), day(2026, 9, 1), day(2026, 10, 15), &no_shift);
        assert_eq!(dates(&occurrences), ["2026-09-04", "2026-09-18", "2026-10-02"]);
    }

    #[test]
    fn cancelled_events_are_not_shown() {
        let text = calendar("BEGIN:VEVENT\r\nSUMMARY:Off\r\nSTATUS:CANCELLED\r\nDTSTART;VALUE=DATE:20260916\r\nEND:VEVENT");
        assert!(expand(&parse(&text).unwrap(), day(2026, 9, 1), day(2026, 9, 30), &no_shift).is_empty());
    }

    #[test]
    fn storing_replaces_only_its_own_source() {
        let conn = init_memory_db().unwrap();
        let today: String = conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0)).unwrap();
        let compact = today.replace('-', "");
        let text = calendar(&format!(
            "BEGIN:VEVENT\r\nSUMMARY:Dentist\r\nDTSTART:{compact}T150000\r\nDTEND:{compact}T160000\r\nEND:VEVENT\r\n\
             BEGIN:VEVENT\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:{compact}\r\nEND:VEVENT"
        ));

        assert_eq!(store(&conn, Source::File, &text).unwrap(), 2);
        assert_eq!(store(&conn, Source::Feed, &text).unwrap(), 2);
        assert_eq!(store(&conn, Source::File, &text).unwrap(), 2, "a re-import replaces, not appends");

        let events = list_for_date(&conn, &today).unwrap();
        assert_eq!(events.len(), 4);
        assert!(events[0].all_day, "all-day events come first");
        assert_eq!(events[2].start_time.as_deref(), Some("15:00"));

        clear(&conn, Source::Feed).unwrap();
        assert_eq!(list_for_date(&conn, &today).unwrap().len(), 2);
    }

    #[test]
    fn a_failed_feed_refresh_keeps_the_last_good_events() {
        let conn = init_memory_db().unwrap();
        set_feed_url(&conn, "webcal://calendar.example.test/private/basic.ics").unwrap();
        assert_eq!(
            feed_url(&conn).unwrap().as_deref(),
            Some("https://calendar.example.test/private/basic.ics")
        );

        let today: String = conn.query_row("SELECT strftime('%Y%m%d', 'now', 'localtime')", [], |row| row.get(0)).unwrap();
        let good = calendar(&format!("BEGIN:VEVENT\r\nSUMMARY:Gym\r\nDTSTART;VALUE=DATE:{today}\r\nEND:VEVENT"));
        let status = record_feed(&conn, Ok(good)).unwrap();
        assert_eq!(status.feed_events, 1);
        assert!(status.feed_refreshed_at.is_some());

        let status = record_feed(&conn, Err("The server did not answer.".into())).unwrap();
        assert_eq!(status.feed_events, 1);
        assert_eq!(status.feed_error.as_deref(), Some("The server did not answer."));

        let status = record_feed(&conn, Ok("<html>Sign in</html>".into())).unwrap();
        assert_eq!(status.feed_events, 1);
        assert!(status.feed_error.is_some());
    }

    #[test]
    fn feed_addresses_are_checked() {
        assert!(normalize_feed_url("ftp://x/cal.ics").is_err());
        assert!(normalize_feed_url("https://").is_err());
        assert!(normalize_feed_url("calendar.google.com").is_err());
        assert_eq!(normalize_feed_url(" https://x.test/a.ics ").unwrap(), "https://x.test/a.ics");
        assert_eq!(normalize_feed_url("WEBCAL://X.test/A.ics").unwrap(), "https://X.test/A.ics");
    }

    #[test]
    fn open_tasks_export_as_events_that_read_back() {
        let conn = init_memory_db().unwrap();
        conn.execute_batch(
            "INSERT INTO tasks (title, description, due_date, due_time, estimated_minutes)
             VALUES ('Write report; part 2', 'Line one\nLine two', '2026-09-16', '14:00', 90);
             INSERT INTO tasks (title, due_date) VALUES ('Pay rent', '2026-09-30');
             INSERT INTO tasks (title, due_date, status) VALUES ('Done already', '2026-09-16', 'completed');
             INSERT INTO tasks (title) VALUES ('No date');",
        )
        .unwrap();

        let (text, count) = tasks_ics(&conn).unwrap();
        assert_eq!(count, 2);
        assert!(text.lines().all(|line| line.len() <= 76));

        let events = parse(&text).unwrap();
        let occurrences = expand(&events, day(2026, 9, 1), day(2026, 9, 30), &no_shift);
        assert_eq!(occurrences.len(), 2);
        assert_eq!(occurrences[0].title, "Write report; part 2");
        assert_eq!(occurrences[0].start_time.as_deref(), Some("14:00"));
        assert_eq!(occurrences[0].end_time.as_deref(), Some("15:30"));
        assert_eq!(occurrences[1].date, "2026-09-30");
        assert!(occurrences[1].all_day);
    }

    #[test]
    fn long_lines_fold_without_splitting_characters() {
        let line = format!("SUMMARY:{}", "é".repeat(60));
        let folded = fold(&line);
        for part in folded.split("\r\n") {
            assert!(part.len() <= 75);
        }
        let unfolded = folded.replace("\r\n ", "");
        assert_eq!(unfolded, line);
    }
}
