//! Transport: shared token bucket, bounded concurrency, retries/backoff, 429 handling, and
//! classification of failures into `ReqError`.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{RequestBuilder, Response, StatusCode, Url};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::time::Instant;

use crate::error::Error;

/// Hard cap on an API JSON body (a 200-hash version_files answer is a few hundred KB).
pub(crate) const MAX_API_BODY: usize = 32 * 1024 * 1024;
/// Waits longer than this are not slept through; the call reports `RateLimited` instead.
const MAX_SINGLE_WAIT: Duration = Duration::from_secs(60);

/// Transport-level failure, mapped to `crate::error::Error` at the API surface.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ReqError {
    /// HTTP 410: this API version was retired.
    Gone,
    /// Still 429 after all retries (or asked to wait longer than we are willing to).
    RateLimited { retry_after_s: u32 },
    /// No connection / DNS / timeout, after retries. Treated as "network down".
    Connect(String),
    NotFound,
    /// Any other non-success status (after retries for 5xx).
    Status(u16),
    /// A redirect to another origin was refused.
    Redirect(String),
    /// The body could not be read or parsed.
    Body(String),
}

impl ReqError {
    pub fn into_error(self, what: &str) -> Error {
        match self {
            ReqError::Gone => Error::Network(
                "Modrinth has retired the API version this app uses (HTTP 410), so update Modpack Doctor to keep using Modrinth features"
                    .into(),
            ),
            ReqError::RateLimited { retry_after_s } => Error::RateLimited { retry_after_s },
            ReqError::Connect(m) => Error::Network(m),
            ReqError::NotFound => Error::NotFound { path: what.to_string() },
            ReqError::Status(code) => Error::Network(format!("Modrinth answered HTTP {code} for {what}")),
            ReqError::Redirect(m) => Error::Network(m),
            ReqError::Body(m) => Error::Network(format!("the response for {what} could not be read ({m})")),
        }
    }
}

/// Retry/backoff knobs. Production values come from `Default`; tests shrink them.
#[derive(Debug, Clone)]
pub(crate) struct RetryPolicy {
    /// Retries after a 429 or 5xx/timeout (so up to `max_retries + 1` attempts).
    pub max_retries: u32,
    /// Retries after a connection failure (DNS, refused): kept low so offline is detected fast.
    pub max_connect_retries: u32,
    /// First backoff step; doubles per attempt.
    pub backoff_base: Duration,
    pub backoff_cap: Duration,
    /// Lower bound of the wait after a 429.
    pub min_429_wait: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            max_retries: 5,
            max_connect_retries: 1,
            backoff_base: Duration::from_secs(1),
            backoff_cap: Duration::from_secs(30),
            min_429_wait: Duration::from_secs(1),
        }
    }
}

struct Bucket {
    tokens: f64,
    last: Instant,
    blocked_until: Option<Instant>,
}

/// Client-side token bucket (300/min by default) shared by every API call of one client.
pub(crate) struct Limiter {
    state: Mutex<Bucket>,
    capacity: f64,
    per_sec: f64,
}

impl Limiter {
    pub fn new(capacity: u32, per_minute: u32) -> Self {
        let capacity = f64::from(capacity.max(1));
        Limiter {
            state: Mutex::new(Bucket { tokens: capacity, last: Instant::now(), blocked_until: None }),
            capacity,
            per_sec: f64::from(per_minute.max(1)) / 60.0,
        }
    }

    pub async fn acquire(&self) {
        loop {
            let wait = {
                let mut b = self.state.lock().await;
                let now = Instant::now();
                let elapsed = now.saturating_duration_since(b.last).as_secs_f64();
                b.tokens = (b.tokens + elapsed * self.per_sec).min(self.capacity);
                b.last = now;
                match b.blocked_until {
                    Some(until) if until > now => until - now,
                    _ if b.tokens >= 1.0 => {
                        b.tokens -= 1.0;
                        return;
                    }
                    _ => Duration::from_secs_f64((1.0 - b.tokens) / self.per_sec),
                }
            };
            tokio::time::sleep(wait).await;
        }
    }

    /// Pause every caller for `d` (after a 429 or an exhausted server-side budget).
    pub async fn block_for(&self, d: Duration) {
        let mut b = self.state.lock().await;
        let until = Instant::now() + d;
        if b.blocked_until.is_none_or(|u| u < until) {
            b.blocked_until = Some(until);
        }
    }

    /// Never hold more local tokens than the server says remain.
    pub async fn clamp(&self, remaining: u32) {
        let mut b = self.state.lock().await;
        b.tokens = b.tokens.min(f64::from(remaining));
    }
}

static JITTER_SEED: AtomicU64 = AtomicU64::new(0x9E37_79B9_7F4A_7C15);

/// 0..=25% extra, from a tiny xorshift (no `rand` crate).
fn jitter(d: Duration) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|t| u64::from(t.subsec_nanos()))
        .unwrap_or(0);
    let mut x = JITTER_SEED.fetch_add(0x6A09_E667_F3BC_C909, Ordering::Relaxed) ^ nanos;
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    let frac = (x % 1000) as f64 / 4000.0;
    d + d.mul_f64(frac)
}

fn backoff(p: &RetryPolicy, attempt: u32) -> Duration {
    let factor = 1u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX);
    jitter(p.backoff_base.saturating_mul(factor).min(p.backoff_cap))
}

/// `"... rate limit exceeded; retry after 1234 milliseconds"` → 1234 ms.
pub(crate) fn parse_429_wait(body: &[u8]) -> Option<Duration> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let desc = v.get("description")?.as_str()?.to_ascii_lowercase();
    let after = &desc[desc.find("retry after")? + "retry after".len()..];
    let digits: String = after.trim_start().chars().take_while(|c| c.is_ascii_digit()).collect();
    let n: u64 = digits.parse().ok()?;
    let rest = after.trim_start()[digits.len()..].trim_start();
    if rest.starts_with("ms") || rest.starts_with("milli") {
        Some(Duration::from_millis(n))
    } else if rest.starts_with('s') {
        Some(Duration::from_secs(n))
    } else {
        Some(Duration::from_millis(n))
    }
}

fn header_u64(resp: &Response, name: &str) -> Option<u64> {
    resp.headers().get(name)?.to_str().ok()?.trim().parse().ok()
}

fn secs_ceil(d: Duration) -> u32 {
    let ms = d.as_millis();
    u32::try_from(ms.div_ceil(1000).max(1)).unwrap_or(u32::MAX)
}

/// Same scheme, host and port.
pub(crate) fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// Redirects are followed only within the original origin (max 5); anything else stops and
/// surfaces as a 3xx, which callers turn into `ReqError::Redirect`.
pub(crate) fn redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(|attempt| {
        if attempt.previous().len() > 5 {
            return attempt.error("too many redirects");
        }
        let allowed = attempt.previous().first().is_some_and(|first| same_origin(first, attempt.url()));
        if allowed {
            attempt.follow()
        } else {
            attempt.stop()
        }
    })
}

fn describe(e: &reqwest::Error) -> String {
    let kind = if e.is_timeout() {
        "the request timed out"
    } else if e.is_connect() {
        "no connection could be made"
    } else {
        "the request failed"
    };
    match e.url() {
        Some(u) => format!("{kind} ({})", u.host_str().unwrap_or("unknown host")),
        None => kind.to_string(),
    }
}

/// Send with limiter, concurrency bound and retries. Returns a 2xx response together with the
/// concurrency permit (hold it while reading the body).
pub(crate) async fn send(
    build: &(dyn Fn() -> RequestBuilder + Send + Sync),
    limiter: Option<&Limiter>,
    sem: Option<&Arc<Semaphore>>,
    policy: &RetryPolicy,
    abort: Option<&AtomicBool>,
) -> Result<(Response, Option<OwnedSemaphorePermit>), ReqError> {
    let mut attempt: u32 = 0;
    let mut connect_attempt: u32 = 0;
    loop {
        let permit = match sem {
            Some(s) => Some(
                Arc::clone(s)
                    .acquire_owned()
                    .await
                    .map_err(|_| ReqError::Connect("the Modrinth client was shut down".into()))?,
            ),
            None => None,
        };
        // Another batch of the same call already found the network down: don't wait for ours.
        if abort.is_some_and(|a| a.load(Ordering::Relaxed)) {
            return Err(ReqError::Connect("Modrinth is unreachable".into()));
        }
        if let Some(l) = limiter {
            l.acquire().await;
        }
        let resp = match build().send().await {
            Ok(r) => r,
            Err(e) => {
                drop(permit);
                if e.is_redirect() {
                    return Err(ReqError::Redirect("Modrinth redirected the request too many times".into()));
                }
                // Timeouts get the long schedule (server may be slow); refused/DNS the short one.
                let (n, max) = if e.is_timeout() {
                    (&mut attempt, policy.max_retries)
                } else {
                    (&mut connect_attempt, policy.max_connect_retries)
                };
                if *n >= max {
                    return Err(ReqError::Connect(describe(&e)));
                }
                tokio::time::sleep(backoff(policy, *n)).await;
                *n += 1;
                continue;
            }
        };

        let remaining = header_u64(&resp, "x-ratelimit-remaining");
        if let (Some(l), Some(rem)) = (limiter, remaining) {
            let rem = u32::try_from(rem).unwrap_or(u32::MAX);
            l.clamp(rem).await;
            if rem == 0 && resp.status().is_success() {
                l.block_for(Duration::from_secs(1)).await;
            }
        }

        let status = resp.status();
        if status.is_success() {
            return Ok((resp, permit));
        }
        if status.is_redirection() {
            let to = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|loc| resp.url().join(loc).ok())
                .and_then(|u| u.host_str().map(str::to_string))
                .unwrap_or_else(|| "an unknown location".into());
            return Err(ReqError::Redirect(format!("Modrinth redirected to another host ({to}), which is not allowed")));
        }
        match status {
            StatusCode::TOO_MANY_REQUESTS => {
                let reset = header_u64(&resp, "x-ratelimit-reset").map(Duration::from_secs);
                let body = read_capped(resp, 64 * 1024).await.unwrap_or_default();
                drop(permit);
                let wait = parse_429_wait(&body)
                    .or(reset)
                    .unwrap_or_else(|| backoff(policy, attempt))
                    .max(policy.min_429_wait);
                if attempt >= policy.max_retries || wait > MAX_SINGLE_WAIT {
                    return Err(ReqError::RateLimited { retry_after_s: secs_ceil(wait) });
                }
                let wait = jitter(wait);
                if let Some(l) = limiter {
                    l.block_for(wait).await;
                }
                tokio::time::sleep(wait).await;
                attempt += 1;
            }
            StatusCode::GONE => return Err(ReqError::Gone),
            StatusCode::NOT_FOUND => return Err(ReqError::NotFound),
            s if s.is_server_error() || s == StatusCode::REQUEST_TIMEOUT => {
                drop(permit);
                if attempt >= policy.max_retries {
                    return Err(ReqError::Status(s.as_u16()));
                }
                tokio::time::sleep(backoff(policy, attempt)).await;
                attempt += 1;
            }
            s => return Err(ReqError::Status(s.as_u16())),
        }
    }
}

/// Read a body up to `cap` bytes (`Body` error beyond it).
pub(crate) async fn read_capped(mut resp: Response, cap: usize) -> Result<Vec<u8>, ReqError> {
    if resp.content_length().is_some_and(|n| n > cap as u64) {
        return Err(ReqError::Body("the response is too large".into()));
    }
    let mut out = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| ReqError::Body(describe(&e)))? {
        if out.len() + chunk.len() > cap {
            return Err(ReqError::Body("the response is too large".into()));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_429_description() {
        let b = br#"{"error":"ratelimit_error","description":"You are being rate-limited. Please wait 1234 milliseconds. 0/300 remaining. rate limit exceeded; retry after 1234 milliseconds"}"#;
        assert_eq!(parse_429_wait(b), Some(Duration::from_millis(1234)));
        let b = br#"{"error":"ratelimit_error","description":"retry after 3 seconds"}"#;
        assert_eq!(parse_429_wait(b), Some(Duration::from_secs(3)));
        assert_eq!(parse_429_wait(b"not json"), None);
        assert_eq!(parse_429_wait(br#"{"description":"slow down"}"#), None);
    }

    #[test]
    fn backoff_grows_and_caps() {
        let p = RetryPolicy::default();
        assert!(backoff(&p, 0) >= Duration::from_secs(1) && backoff(&p, 0) <= Duration::from_millis(1250));
        assert!(backoff(&p, 3) >= Duration::from_secs(8));
        assert!(backoff(&p, 20) <= Duration::from_millis(37_500));
        assert_eq!(secs_ceil(Duration::from_millis(1)), 1);
        assert_eq!(secs_ceil(Duration::from_millis(2001)), 3);
    }

    #[tokio::test]
    async fn bucket_refills_at_rate() {
        let l = Limiter::new(2, 600); // 10 tokens/s
        let t0 = Instant::now();
        l.acquire().await;
        l.acquire().await;
        assert!(Instant::now() - t0 < Duration::from_millis(50), "burst should not wait");
        l.acquire().await;
        assert!(Instant::now() - t0 >= Duration::from_millis(90), "third token must wait for refill");
        l.block_for(Duration::from_millis(150)).await;
        let t1 = Instant::now();
        l.acquire().await;
        assert!(Instant::now() - t1 >= Duration::from_millis(140));
    }
}
