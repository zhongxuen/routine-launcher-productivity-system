//! The phone companion (development-plan.md section 92 Tier 5, "Mobile
//! companion application").
//!
//! A second app on a second platform would need a server to meet this one
//! through, and sections 56 and 68 rule that out. So the companion is served
//! by this app, to phones on the **same local network**, as one small web
//! page: today's tasks, tick one off, add one. Open the link on the phone
//! (or scan the QR code in Settings) and add it to the home screen.
//!
//! # Off, local, and locked
//!
//! * **Off by default.** Nothing listens until the user turns it on in
//!   Settings, and turning it off closes the socket.
//! * **Local network only.** A connection from an address that is not
//!   private (10/8, 172.16/12, 192.168/16, link-local, loopback, IPv6 ULA) is
//!   dropped before a byte is read, so a port forwarded by mistake still
//!   answers nobody on the internet.
//! * **A pairing token.** Every data request carries a 256-bit random token
//!   as a bearer header, compared in constant time. The link in Settings
//!   carries it in the URL *fragment*, which browsers never send, so it is
//!   not in any request line or `Referer`. Rotating it in Settings unpairs
//!   every phone at once.
//! * **Not a browser's cross-site target.** The `Host` header has to be an IP
//!   address or `localhost` (no DNS rebinding), no CORS headers are sent, and
//!   the pre-flight a cross-site bearer request needs is refused.
//! * **Only tasks.** The companion can read today's tasks, complete and reopen
//!   them, and add one for today. It cannot launch a routine, run a command,
//!   read files, or reach Settings — nothing a phone could do here touches
//!   the computer beyond the task list.
//!
//! Plain HTTP on the local network, because a certificate a phone would trust
//! needs a domain and a CA this app does not have. The page says so, and the
//! token is the thing that stands between a neighbour on the same Wi-Fi and
//! the list.
//!
//! Writes go through `services::tasks`, the same functions the task commands
//! call, so XP, recurrence and the anti-farming rules apply exactly as they do
//! on the desktop, and every window and the tray are told afterwards.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use tauri::{AppHandle, Emitter, Manager};

use crate::db::DbConnection;

use super::error::{ServiceError, ServiceResult};
use super::random;
use super::settings;
use super::tasks::{self, NewTask, TaskFilter, TaskStatus, TaskUpdate, TaskView};
use super::tray;

const ENABLED_KEY: &str = "companion.enabled";
const TOKEN_KEY: &str = "companion.token";
const PORT_KEY: &str = "companion.port";

/// The port it listens on unless the user picks another.
pub const DEFAULT_PORT: u16 = 47_821;

const MAX_HEADER_BYTES: usize = 16 * 1024;
const MAX_BODY_BYTES: usize = 8 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TITLE_CHARS: usize = 200;

const PAGE: &str = include_str!("companion_page.html");

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn enabled(conn: &Connection) -> ServiceResult<bool> {
    settings::get_bool(conn, ENABLED_KEY, false)
}

pub fn port(conn: &Connection) -> ServiceResult<u16> {
    Ok(settings::get(conn, PORT_KEY)?
        .and_then(|port| port.parse().ok())
        .filter(|port| *port >= 1024)
        .unwrap_or(DEFAULT_PORT))
}

/// The pairing token, created the first time it is needed.
pub fn token(conn: &Connection) -> ServiceResult<String> {
    if let Some(token) = settings::get(conn, TOKEN_KEY)?.filter(|token| token.len() == 64) {
        return Ok(token);
    }
    rotate_token(conn)
}

/// A new token. Every paired phone has to scan again.
pub fn rotate_token(conn: &Connection) -> ServiceResult<String> {
    let token = random::hex_token(32)?;
    settings::set(conn, TOKEN_KEY, &token)?;
    Ok(token)
}

pub fn set_enabled(conn: &Connection, on: bool) -> ServiceResult<()> {
    settings::set_bool(conn, ENABLED_KEY, on)
}

pub fn set_port(conn: &Connection, value: u16) -> ServiceResult<()> {
    if value < 1024 {
        return Err(ServiceError::validation("Choose a port from 1024 to 65535."));
    }
    settings::set(conn, PORT_KEY, &value.to_string())
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionStatus {
    pub enabled: bool,
    pub running: bool,
    pub port: u16,
    /// The pairing link for each local address, token included. Empty while
    /// off.
    pub links: Vec<String>,
    /// The first link as an SVG QR code.
    pub qr_svg: Option<String>,
    /// Why the server is not running although it is switched on.
    pub error: Option<String>,
}

/// This computer's address on the local network: the one the default route
/// leaves from. Connecting a UDP socket sends nothing; it only asks the OS
/// which interface it would use.
pub fn lan_addresses() -> Vec<IpAddr> {
    let mut addresses = Vec::new();
    for probe in ["192.168.0.1:9", "10.0.0.1:9", "8.8.8.8:9"] {
        let found = UdpSocket::bind("0.0.0.0:0")
            .and_then(|socket| socket.connect(probe).map(|()| socket))
            .and_then(|socket| socket.local_addr())
            .map(|addr| addr.ip());
        if let Ok(ip) = found {
            if is_local_peer(ip) && !ip.is_loopback() && !addresses.contains(&ip) {
                addresses.push(ip);
            }
        }
    }
    addresses
}

pub fn link(ip: IpAddr, port: u16, token: &str) -> String {
    match ip {
        IpAddr::V4(v4) => format!("http://{v4}:{port}/#t={token}"),
        IpAddr::V6(v6) => format!("http://[{v6}]:{port}/#t={token}"),
    }
}

pub fn qr_svg(text: &str) -> Option<String> {
    let code = qrcode::QrCode::new(text.as_bytes()).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color<'_>>()
            .min_dimensions(220, 220)
            .quiet_zone(true)
            .build(),
    )
}

pub fn status(conn: &Connection) -> ServiceResult<CompanionStatus> {
    let on = enabled(conn)?;
    let port = port(conn)?;
    let (running, error) = server_state();
    let links = if on && running {
        let token = token(conn)?;
        lan_addresses().into_iter().map(|ip| link(ip, port, &token)).collect()
    } else {
        Vec::new()
    };
    Ok(CompanionStatus {
        enabled: on,
        running,
        port,
        qr_svg: links.first().and_then(|first| qr_svg(first)),
        links,
        error: if on { error } else { None },
    })
}

// ---------------------------------------------------------------------------
// Who may connect
// ---------------------------------------------------------------------------

/// Whether a peer is on this computer's local network.
pub fn is_local_peer(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_local_peer(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Whether a `Host` header names this machine by address rather than by a
/// domain someone else controls.
pub fn is_address_host(host: &str) -> bool {
    let host = host.trim();
    let bare = if let Some(rest) = host.strip_prefix('[') {
        match rest.split_once(']') {
            Some((inside, _)) => inside,
            None => return false,
        }
    } else {
        host.rsplit_once(':').map_or(host, |(name, port)| {
            if port.bytes().all(|b| b.is_ascii_digit()) { name } else { host }
        })
    };
    bare.eq_ignore_ascii_case("localhost") || bare.parse::<IpAddr>().is_ok()
}

/// Compares two tokens without leaking where they differ through timing.
pub fn tokens_match(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String,
    pub host: Option<String>,
    pub authorization: Option<String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    pub status: u16,
    pub content_type: &'static str,
    pub body: Vec<u8>,
    /// Whether the task list changed, so the windows should be told.
    pub changed: bool,
}

impl Response {
    fn json(status: u16, value: &impl Serialize) -> Self {
        Self {
            status,
            content_type: "application/json; charset=utf-8",
            body: serde_json::to_vec(value).unwrap_or_else(|_| b"{}".to_vec()),
            changed: false,
        }
    }

    fn error(status: u16, message: &str) -> Self {
        Self::json(status, &serde_json::json!({ "error": message }))
    }

    fn to_bytes(&self) -> Vec<u8> {
        let reason = match self.status {
            200 => "OK",
            201 => "Created",
            400 => "Bad Request",
            401 => "Unauthorized",
            403 => "Forbidden",
            404 => "Not Found",
            405 => "Method Not Allowed",
            413 => "Payload Too Large",
            _ => "Internal Server Error",
        };
        let mut head = format!(
            "HTTP/1.1 {} {reason}\r\nContent-Type: {}\r\nContent-Length: {}\r\n\
             Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\
             Referrer-Policy: no-referrer\r\nX-Frame-Options: DENY\r\nConnection: close\r\n",
            self.status,
            self.content_type,
            self.body.len()
        );
        if self.content_type.starts_with("text/html") {
            head.push_str(
                "Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline'; \
                 style-src 'unsafe-inline'; connect-src 'self'; img-src data:; \
                 manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'\r\n",
            );
        }
        head.push_str("\r\n");
        let mut bytes = head.into_bytes();
        bytes.extend_from_slice(&self.body);
        bytes
    }
}

/// Reads one request, refusing anything oversized or malformed.
pub fn read_request(stream: impl Read) -> Result<Request, Response> {
    let mut reader = BufReader::new(stream.take((MAX_HEADER_BYTES + MAX_BODY_BYTES) as u64));
    let mut line = String::new();
    let mut header_bytes = 0usize;

    let mut read_line = |reader: &mut BufReader<_>, line: &mut String| -> Result<(), Response> {
        line.clear();
        let n = reader
            .read_line(line)
            .map_err(|_| Response::error(400, "The request could not be read."))?;
        header_bytes += n;
        if n == 0 || header_bytes > MAX_HEADER_BYTES {
            return Err(Response::error(400, "The request could not be read."));
        }
        Ok(())
    };

    read_line(&mut reader, &mut line)?;
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();
    if method.is_empty() || !path.starts_with('/') {
        return Err(Response::error(400, "The request could not be read."));
    }

    let mut host = None;
    let mut authorization = None;
    let mut content_length = 0usize;
    loop {
        read_line(&mut reader, &mut line)?;
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        let Some((name, value)) = trimmed.split_once(':') else {
            continue;
        };
        let value = value.trim().to_string();
        match name.trim().to_ascii_lowercase().as_str() {
            "host" => host = Some(value),
            "authorization" => authorization = Some(value),
            "content-length" => {
                content_length = value
                    .parse()
                    .map_err(|_| Response::error(400, "The request could not be read."))?
            }
            "transfer-encoding" => {
                return Err(Response::error(400, "Chunked requests are not accepted."))
            }
            _ => {}
        }
    }

    if content_length > MAX_BODY_BYTES {
        return Err(Response::error(413, "That request is too large."));
    }
    let mut body = vec![0u8; content_length];
    reader
        .read_exact(&mut body)
        .map_err(|_| Response::error(400, "The request could not be read."))?;

    Ok(Request { method, path, host, authorization, body })
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompanionTask {
    id: i64,
    title: String,
    priority: String,
    due_time: Option<String>,
    completed: bool,
    overdue: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Today {
    date: String,
    completed: usize,
    total: usize,
    tasks: Vec<CompanionTask>,
}

#[derive(Debug, Deserialize)]
struct NewCompanionTask {
    title: String,
}

/// Answers one request against the database. Pure apart from the database,
/// so every rule above is tested without a socket.
pub fn respond(db: &DbConnection, request: &Request) -> Response {
    if !request.host.as_deref().is_some_and(is_address_host) {
        return Response::error(403, "Open the companion by its address, as shown in Settings.");
    }

    let path = request.path.split(['?', '#']).next().unwrap_or("/");
    if request.method == "GET" && (path == "/" || path == "/index.html") {
        return Response {
            status: 200,
            content_type: "text/html; charset=utf-8",
            body: PAGE.as_bytes().to_vec(),
            changed: false,
        };
    }
    if request.method == "GET" && path == "/manifest.webmanifest" {
        return Response {
            status: 200,
            content_type: "application/manifest+json",
            body: br##"{"name":"Routine Launcher","short_name":"Routines","start_url":"/","display":"standalone","background_color":"#111827","theme_color":"#111827"}"##.to_vec(),
            changed: false,
        };
    }
    if !path.starts_with("/api/") {
        return Response::error(404, "Not found.");
    }

    let Ok(conn) = db.lock() else {
        return Response::error(500, "The app is busy. Try again.");
    };

    let expected = match token(&conn) {
        Ok(token) => token,
        Err(error) => return Response::error(500, &error.to_string()),
    };
    let given = request
        .authorization
        .as_deref()
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !tokens_match(given.trim(), &expected) {
        return Response::error(401, "This phone is not paired. Scan the code in Settings again.");
    }

    let segments: Vec<&str> = path.trim_start_matches("/api/").split('/').collect();
    let result = match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["today"]) => today(&conn).map(|today| Response::json(200, &today)),
        ("POST", ["tasks"]) => add_task(&conn, &request.body),
        ("POST", ["tasks", id, action @ ("complete" | "reopen")]) => match id.parse::<i64>() {
            Ok(id) => set_completed(&conn, id, *action == "complete"),
            Err(_) => Ok(Response::error(404, "Not found.")),
        },
        (_, ["today"]) | (_, ["tasks", ..]) => Ok(Response::error(405, "Not allowed.")),
        _ => Ok(Response::error(404, "Not found.")),
    };

    result.unwrap_or_else(|error| match error {
        ServiceError::NotFound(message) => Response::error(404, &message),
        ServiceError::Validation(message) => Response::error(400, &message),
        other => Response::error(500, &other.to_string()),
    })
}

fn today(conn: &Connection) -> ServiceResult<Today> {
    let date: String = conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
    let list = tasks::list(
        conn,
        TaskFilter {
            view: Some(TaskView::Today),
            statuses: Some(vec![TaskStatus::Todo, TaskStatus::InProgress, TaskStatus::Completed]),
            ..TaskFilter::default()
        },
    )?;
    let tasks: Vec<CompanionTask> = list
        .into_iter()
        .map(|task| CompanionTask {
            id: task.id,
            title: task.title,
            priority: task.priority.as_str().to_string(),
            due_time: task.due_time,
            completed: task.status == TaskStatus::Completed,
            overdue: task.is_overdue,
        })
        .collect();
    Ok(Today {
        date,
        completed: tasks.iter().filter(|task| task.completed).count(),
        total: tasks.len(),
        tasks,
    })
}

fn add_task(conn: &Connection, body: &[u8]) -> ServiceResult<Response> {
    let input: NewCompanionTask = serde_json::from_slice(body)
        .map_err(|_| ServiceError::validation("Send a title."))?;
    let title = input.title.trim();
    if title.is_empty() {
        return Err(ServiceError::validation("A task needs a title."));
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err(ServiceError::validation("That title is too long."));
    }
    let date: String = conn.query_row("SELECT date('now', 'localtime')", [], |row| row.get(0))?;
    let task = tasks::create(
        conn,
        NewTask {
            title: title.to_string(),
            description: None,
            status: None,
            priority: None,
            category_id: None,
            due_date: Some(date),
            due_time: None,
            estimated_minutes: None,
            routine_id: None,
            recurrence: None,
        },
    )?;
    let mut response = Response::json(201, &serde_json::json!({ "id": task.id }));
    response.changed = true;
    Ok(response)
}

fn set_completed(conn: &Connection, id: i64, completed: bool) -> ServiceResult<Response> {
    let task = tasks::get(conn, id)?
        .ok_or_else(|| ServiceError::not_found("That task is no longer there."))?;
    let status = if completed { TaskStatus::Completed } else { TaskStatus::Todo };
    if task.status != status {
        tasks::update(conn, id, TaskUpdate { status: Some(status), ..TaskUpdate::default() })?;
    }
    let mut response = Response::json(200, &serde_json::json!({ "id": id, "completed": completed }));
    response.changed = task.status != status;
    Ok(response)
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

struct Running {
    stop: Arc<AtomicBool>,
    port: u16,
}

/// The server, if one is running, and the last reason starting one failed.
static SERVER: Mutex<(Option<Running>, Option<String>)> = Mutex::new((None, None));

fn server_state() -> (bool, Option<String>) {
    match SERVER.lock() {
        Ok(state) => (state.0.is_some(), state.1.clone()),
        Err(_) => (false, None),
    }
}

/// Stops the server if it is running. Returns once the socket is closed.
pub fn stop() {
    if let Ok(mut state) = SERVER.lock() {
        if let Some(running) = state.0.take() {
            running.stop.store(true, Ordering::Relaxed);
            crate::log_info!("[companion] stopped listening on port {}", running.port);
        }
        state.1 = None;
    }
}

/// The cross-window broadcast the frontend listens to (`src/lib/window-sync.ts`).
const DATA_CHANGED_EVENT: &str = "app://data-changed";

/// Starts listening on `port`, replacing a server already running.
pub fn start(app: AppHandle, port: u16) -> ServiceResult<()> {
    stop();

    let listener = TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], port))).map_err(|error| {
        let message = format!(
            "Port {port} could not be opened ({error}). Another program may be using it; choose              a different port."
        );
        if let Ok(mut state) = SERVER.lock() {
            state.1 = Some(message.clone());
        }
        ServiceError::validation(message)
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| ServiceError::validation(error.to_string()))?;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop = stop_flag.clone();

    std::thread::Builder::new()
        .name("companion".into())
        .spawn(move || serve(listener, thread_stop, app))
        .map_err(|error| ServiceError::validation(format!("Could not start the companion: {error}")))?;

    if let Ok(mut state) = SERVER.lock() {
        state.0 = Some(Running { stop: stop_flag, port });
        state.1 = None;
    }
    crate::log_info!("[companion] listening on port {port}");
    Ok(())
}

fn serve(listener: TcpListener, stop_flag: Arc<AtomicBool>, app: AppHandle) {
    while !stop_flag.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, peer)) => {
                if !is_local_peer(peer.ip()) {
                    // Dropped unread. See the module docs.
                    continue;
                }
                let app = app.clone();
                // One short-lived thread per request, so a phone on a slow
                // connection cannot hold up another.
                let _ = std::thread::Builder::new()
                    .name("companion-request".into())
                    .spawn(move || handle(stream, &app));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(150));
            }
            Err(error) => {
                crate::log_warn!("[companion] accept failed: {error}");
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

fn handle(mut stream: TcpStream, app: &AppHandle) {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(IO_TIMEOUT));
    let _ = stream.set_write_timeout(Some(IO_TIMEOUT));

    let request = stream
        .try_clone()
        .map_err(|_| Response::error(400, "The request could not be read."))
        .and_then(read_request);
    let response = match (request, app.try_state::<DbConnection>()) {
        (Ok(request), Some(db)) => respond(&db, &request),
        (Ok(_), None) => Response::error(500, "The app is still starting. Try again."),
        (Err(response), _) => response,
    };

    if response.status == 401 {
        // A wrong token costs a moment, so guessing costs a lifetime.
        std::thread::sleep(Duration::from_millis(250));
    }
    let _ = stream.write_all(&response.to_bytes());
    let _ = stream.flush();

    if response.changed {
        let payload = serde_json::json!({ "scope": "tasks", "source": "companion" });
        if let Err(error) = app.emit(DATA_CHANGED_EVENT, payload) {
            crate::log_warn!("[companion] could not tell the windows about a change: {error}");
        }
        tray::refresh(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_memory_db;
    use std::net::{Ipv4Addr, Ipv6Addr};

    fn db() -> DbConnection {
        Mutex::new(init_memory_db().unwrap())
    }

    fn request(db: &DbConnection, method: &str, path: &str, auth: bool, body: &str) -> Response {
        let token = token(&db.lock().unwrap()).unwrap();
        respond(
            db,
            &Request {
                method: method.into(),
                path: path.into(),
                host: Some("192.168.1.20:47821".into()),
                authorization: auth.then(|| format!("Bearer {token}")),
                body: body.as_bytes().to_vec(),
            },
        )
    }

    fn json(response: &Response) -> serde_json::Value {
        serde_json::from_slice(&response.body).unwrap()
    }

    #[test]
    fn only_the_local_network_is_answered() {
        assert!(is_local_peer(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 7))));
        assert!(is_local_peer(IpAddr::V4(Ipv4Addr::new(10, 3, 0, 1))));
        assert!(is_local_peer(IpAddr::V4(Ipv4Addr::new(172, 20, 0, 1))));
        assert!(is_local_peer(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(is_local_peer("fe80::1".parse().unwrap()));
        assert!(is_local_peer("fd12:3456::1".parse().unwrap()));
        assert!(is_local_peer("::ffff:192.168.0.4".parse().unwrap()));
        assert!(!is_local_peer(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_local_peer(IpAddr::V4(Ipv4Addr::new(172, 32, 0, 1))));
        assert!(!is_local_peer(IpAddr::V6("2001:db8::1".parse::<Ipv6Addr>().unwrap())));
        assert!(!is_local_peer("::ffff:1.1.1.1".parse().unwrap()));
    }

    #[test]
    fn only_address_hosts_are_accepted() {
        for host in ["192.168.1.2:47821", "192.168.1.2", "[fe80::1]:47821", "localhost:47821"] {
            assert!(is_address_host(host), "{host}");
        }
        for host in ["evil.example:47821", "evil.example", "[fe80::1", "192.168.1.2.evil.example"] {
            assert!(!is_address_host(host), "{host}");
        }
        let db = db();
        let response = respond(
            &db,
            &Request {
                method: "GET".into(),
                path: "/".into(),
                host: Some("rebound.example.test".into()),
                authorization: None,
                body: Vec::new(),
            },
        );
        assert_eq!(response.status, 403);
    }

    #[test]
    fn data_needs_the_token_but_the_page_does_not() {
        let db = db();
        let page = request(&db, "GET", "/", false, "");
        assert_eq!(page.status, 200);
        assert!(String::from_utf8_lossy(&page.body).contains("<html"));
        assert!(!String::from_utf8_lossy(&page.body).contains(&token(&db.lock().unwrap()).unwrap()));

        assert_eq!(request(&db, "GET", "/api/today", false, "").status, 401);
        let wrong = respond(
            &db,
            &Request {
                method: "GET".into(),
                path: "/api/today".into(),
                host: Some("127.0.0.1".into()),
                authorization: Some(format!("Bearer {}", "0".repeat(64))),
                body: Vec::new(),
            },
        );
        assert_eq!(wrong.status, 401);
        assert_eq!(request(&db, "GET", "/api/today", true, "").status, 200);

        // Rotating unpairs: the old token no longer works.
        let old = token(&db.lock().unwrap()).unwrap();
        rotate_token(&db.lock().unwrap()).unwrap();
        assert!(!tokens_match(&old, &token(&db.lock().unwrap()).unwrap()));
    }

    #[test]
    fn a_phone_adds_completes_and_reopens_todays_tasks() {
        let db = db();
        let added = request(&db, "POST", "/api/tasks", true, r#"{"title":"  Buy milk "}"#);
        assert_eq!(added.status, 201);
        assert!(added.changed);
        let id = json(&added)["id"].as_i64().unwrap();

        let today = json(&request(&db, "GET", "/api/today", true, ""));
        assert_eq!(today["total"], 1);
        assert_eq!(today["tasks"][0]["title"], "Buy milk");
        assert_eq!(today["tasks"][0]["completed"], false);

        let done = request(&db, "POST", &format!("/api/tasks/{id}/complete"), true, "");
        assert_eq!(done.status, 200);
        assert!(done.changed);
        assert_eq!(json(&request(&db, "GET", "/api/today", true, ""))["completed"], 1);
        {
            let conn = db.lock().unwrap();
            let earned: i64 = conn
                .query_row(
                    "SELECT COALESCE(SUM(amount), 0) FROM xp_transactions
                      WHERE source = 'task_completion' AND source_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(
                earned,
                crate::services::xp::TASK_COMPLETION_XP,
                "a phone's tick earns what a desktop tick earns"
            );
        }

        let again = request(&db, "POST", &format!("/api/tasks/{id}/complete"), true, "");
        assert!(!again.changed, "completing twice changes nothing");

        let reopened = request(&db, "POST", &format!("/api/tasks/{id}/reopen"), true, "");
        assert!(reopened.changed);
        assert_eq!(json(&request(&db, "GET", "/api/today", true, ""))["completed"], 0);
    }

    #[test]
    fn the_companion_can_do_nothing_but_tasks() {
        let db = db();
        assert_eq!(request(&db, "POST", "/api/tasks", true, r#"{"title":"   "}"#).status, 400);
        assert_eq!(request(&db, "POST", "/api/tasks", true, "not json").status, 400);
        assert_eq!(request(&db, "POST", "/api/tasks/999/complete", true, "").status, 404);
        assert_eq!(request(&db, "DELETE", "/api/tasks/1", true, "").status, 405);
        assert_eq!(request(&db, "OPTIONS", "/api/today", true, "").status, 405);
        assert_eq!(request(&db, "POST", "/api/routines/1/launch", true, "").status, 404);
        assert_eq!(request(&db, "GET", "/api/settings", true, "").status, 404);
        assert_eq!(request(&db, "GET", "/../app.db", true, "").status, 404);
    }

    #[test]
    fn requests_are_parsed_and_limited() {
        let raw = "POST /api/tasks HTTP/1.1\r\nHost: 10.0.0.2:47821\r\nAuthorization: Bearer abc\r\n\
                   Content-Length: 14\r\n\r\n{\"title\":\"Hi\"}";
        let parsed = read_request(raw.as_bytes()).unwrap();
        assert_eq!(parsed.method, "POST");
        assert_eq!(parsed.path, "/api/tasks");
        assert_eq!(parsed.host.as_deref(), Some("10.0.0.2:47821"));
        assert_eq!(parsed.authorization.as_deref(), Some("Bearer abc"));
        assert_eq!(parsed.body, br#"{"title":"Hi"}"#);

        let too_big = format!("POST / HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY_BYTES + 1);
        assert_eq!(read_request(too_big.as_bytes()).unwrap_err().status, 413);

        let chunked = "POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n";
        assert_eq!(read_request(chunked.as_bytes()).unwrap_err().status, 400);

        let huge_header = format!("GET / HTTP/1.1\r\nX: {}\r\n\r\n", "a".repeat(MAX_HEADER_BYTES));
        assert!(read_request(huge_header.as_bytes()).is_err());
        assert!(read_request("garbage".as_bytes()).is_err());
    }

    #[test]
    fn responses_carry_the_protective_headers() {
        let db = db();
        let page = String::from_utf8(request(&db, "GET", "/", false, "").to_bytes()).unwrap();
        assert!(page.contains("Content-Security-Policy: default-src 'none'"));
        assert!(page.contains("Cache-Control: no-store"));
        assert!(!page.to_ascii_lowercase().contains("access-control-allow-origin"));
    }

    #[test]
    fn links_put_the_token_in_the_fragment_and_draw_as_a_qr_code() {
        let token = "ab".repeat(32);
        let url = link(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20)), 47821, &token);
        assert_eq!(url, format!("http://192.168.1.20:47821/#t={token}"));
        assert!(qr_svg(&url).unwrap().starts_with("<?xml"));
    }

    #[test]
    fn it_is_off_until_switched_on() {
        let conn = init_memory_db().unwrap();
        assert!(!enabled(&conn).unwrap());
        assert_eq!(port(&conn).unwrap(), DEFAULT_PORT);
        assert!(set_port(&conn, 80).is_err());
        let status = status(&conn).unwrap();
        assert!(status.links.is_empty() && status.qr_svg.is_none());
    }
}
