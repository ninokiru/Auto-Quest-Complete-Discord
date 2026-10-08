//! Per-route release pacing for the Discord REST client.
//!
//! Discord's request limits are scoped to a route (and its rate-limit bucket),
//! never to a caller. This app runs up to five quests in parallel with one token,
//! so five heartbeats on the same route are seen as one very fast client: one 429
//! and every slot in the process pays for it. Releasing one request per route per
//! `ROUTE_GAP` keeps the parallel slots inside the budget a single Discord client
//! would have.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use reqwest::header::HeaderMap;
use reqwest::{RequestBuilder, Response};

/// Minimum spacing between two requests on the same route.
const ROUTE_GAP: Duration = Duration::from_millis(600);

/// A route is never held longer than this, whichever header or `retry_after`
/// asked for the hold. Discord's own 429 payloads stay well under it, and a
/// longer hold would outlive the quest that triggered it.
const MAX_HOLD: Duration = Duration::from_secs(60);

/// Earliest instant each route may next release a request.
static ROUTE_DEADLINES: Lazy<Mutex<HashMap<String, Instant>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Rate-limit bucket Discord reported for a route. Different routes can share one
/// bucket and therefore one budget; remembering the pairing lets a hold taken on
/// either route delay both.
static ROUTE_BUCKETS: Lazy<Mutex<HashMap<String, String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// Accessors instead of `&ROUTE_*` at each call site: dereferencing a `Lazy` through
// a generic `&Mutex<T>` parameter needs the map type spelled out somewhere.
fn deadlines() -> &'static Mutex<HashMap<String, Instant>> {
    &ROUTE_DEADLINES
}

fn buckets() -> &'static Mutex<HashMap<String, String>> {
    &ROUTE_BUCKETS
}

/// Gate key for a request. Snowflake ids (quests, applications) are collapsed so
/// five slots polling five different quests share one key instead of stampeding
/// five keys that Discord counts as one route.
pub fn route_key(method: &str, path: &str) -> String {
    let normalized = path
        .split('/')
        .map(|segment| {
            if !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_digit()) {
                ":id"
            } else {
                segment
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("{method} {normalized}")
}

fn bucket_key(bucket: &str) -> String {
    format!("bucket:{bucket}")
}

/// Return the instant the request may go out, reserving the gap after it. A route
/// under a hold delays the request; an idle route returns `now` and is marked for
/// the next caller. Pure, so the arithmetic is testable without sleeping.
fn schedule(
    table: &mut HashMap<String, Instant>,
    keys: &[String],
    now: Instant,
    gap: Duration,
) -> Instant {
    let mut start = now;
    for key in keys {
        if let Some(deadline) = table.get(key) {
            start = start.max(*deadline);
        }
    }
    for key in keys {
        table.insert(key.clone(), start + gap);
    }
    start
}

/// Extend the hold on every key. Existing longer holds win, so a late-arriving
/// response cannot shorten a wait another task is already sleeping through.
fn reserve(table: &mut HashMap<String, Instant>, keys: &[String], now: Instant, hold: Duration) {
    let hold = hold.max(Duration::ZERO).min(MAX_HOLD);
    for key in keys {
        let target = now.checked_add(hold).unwrap_or(now);
        let current = table.get(key).copied().unwrap_or(now);
        if current < target {
            table.insert(key.clone(), target);
        }
    }
}

/// Discord's `x-ratelimit-*` headers as a hold: once `remaining` reaches zero the
/// route is spent and `reset-after` says how long until it refills. Acting on that
/// pair releases the next request after the refill instead of letting it fail with
/// a 429 and pay the retry cost.
fn header_hold(headers: &HeaderMap) -> Option<Duration> {
    if headers.get("x-ratelimit-remaining")?.to_str().ok()? != "0" {
        return None;
    }
    let reset_after = headers.get("x-ratelimit-reset-after")?.to_str().ok()?;
    reset_after
        .parse::<f64>()
        .ok()
        .map(|seconds| Duration::from_secs_f64(seconds.max(0.0).min(MAX_HOLD.as_secs_f64())))
}

fn bucket_of(headers: &HeaderMap) -> Option<String> {
    Some(bucket_key(headers.get("x-ratelimit-bucket")?.to_str().ok()?))
}

/// A request's place in the queue for its route and, once Discord names it, its
/// rate-limit bucket.
pub struct Gate {
    route: String,
}

impl Gate {
    /// Derive the gate from an unsent request. `None` when the builder cannot be
    /// cloned or built, which leaves the request behaving the way it did before
    /// this module existed rather than gating it under a wrong key.
    pub fn from_builder(builder: &RequestBuilder) -> Option<Gate> {
        let request = builder.try_clone().and_then(|builder| builder.build().ok())?;
        Some(Gate {
            route: route_key(request.method().as_str(), request.url().path()),
        })
    }

    fn keys(&self, bucket: Option<String>) -> Vec<String> {
        let mut keys = vec![self.route.clone()];
        if let Some(bucket) = bucket {
            keys.push(bucket);
        }
        keys
    }

    /// Wait until this request's route is releasable, then take the slot.
    pub async fn wait(&self) {
        let bucket = lock_or_recover(buckets()).get(&self.route).cloned();
        let keys = self.keys(bucket);
        let start = {
            let mut table = lock_or_recover(deadlines());
            schedule(&mut table, &keys, Instant::now(), ROUTE_GAP)
        };
        let now = Instant::now();
        if start > now {
            tokio::time::sleep(start - now).await;
        }
    }

    /// Learn this route's bucket, then hold the route when its budget is spent.
    pub fn observe(&self, response: &Response) {
        let headers = response.headers();
        let bucket = bucket_of(headers);
        if let Some(bucket) = bucket.clone() {
            let mut known = lock_or_recover(buckets());
            known.entry(self.route.clone()).or_insert(bucket);
        }
        let Some(hold) = header_hold(headers) else {
            return;
        };
        let keys = self.keys(bucket);
        let mut table = lock_or_recover(deadlines());
        reserve(&mut table, &keys, Instant::now(), hold);
    }

    /// Hold the whole route for `seconds` after a 429. Without this, the other
    /// slots each take their own 429 and each sleep `retry_after` separately, so
    /// the bucket is still being hit when the first of them retries.
    pub fn backoff(&self, seconds: f64) {
        let bucket = lock_or_recover(buckets()).get(&self.route).cloned();
        let keys = self.keys(bucket);
        let hold = Duration::from_secs_f64(seconds.max(0.0).min(MAX_HOLD.as_secs_f64()));
        let mut table = lock_or_recover(deadlines());
        reserve(&mut table, &keys, Instant::now(), hold);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Instant {
        Instant::now()
    }

    fn key(name: &str) -> String {
        name.to_string()
    }

    #[test]
    fn collapses_snowflake_segments_so_one_route_shares_one_gate() {
        assert_eq!(
            route_key("POST", "/api/v9/quests/1234567890123456789/heartbeat"),
            route_key("POST", "/api/v9/quests/9876543210987654321/heartbeat")
        );
        assert_eq!(
            route_key("POST", "/api/v9/quests/123/heartbeat"),
            "POST /api/v9/quests/:id/heartbeat"
        );
    }

    #[test]
    fn keeps_version_and_named_segments_intact() {
        assert_eq!(route_key("GET", "/api/v9/quests/@me"), "GET /api/v9/quests/@me");
        assert_ne!(
            route_key("GET", "/api/v9/quests/@me"),
            route_key("POST", "/api/v9/quests/@me")
        );
    }

    #[test]
    fn first_request_on_an_idle_route_goes_out_immediately() {
        let now = base();
        let mut table = HashMap::new();
        let keys = vec![key("POST /a")];

        assert_eq!(schedule(&mut table, &keys, now, ROUTE_GAP), now);
        assert_eq!(table.get(&keys[0]), Some(&(now + ROUTE_GAP)));
    }

    #[test]
    fn later_requests_queue_behind_the_reserved_gap() {
        let now = base();
        let mut table = HashMap::new();
        let keys = vec![key("POST /a")];

        schedule(&mut table, &keys, now, ROUTE_GAP);
        assert_eq!(schedule(&mut table, &keys, now, ROUTE_GAP), now + ROUTE_GAP);
        assert_eq!(schedule(&mut table, &keys, now, ROUTE_GAP), now + ROUTE_GAP * 2);
    }

    #[test]
    fn a_hold_delays_the_route_beyond_the_plain_gap() {
        let now = base();
        let mut table = HashMap::new();
        let keys = vec![key("POST /a")];

        reserve(&mut table, &keys, now, Duration::from_secs(5));
        assert_eq!(schedule(&mut table, &keys, now, ROUTE_GAP), now + Duration::from_secs(5));
    }

    #[test]
    fn holds_are_capped_and_never_shorten_an_existing_hold() {
        let now = base();
        let mut table = HashMap::new();
        let keys = vec![key("POST /a")];

        reserve(&mut table, &keys, now, Duration::from_secs(600));
        let capped = table.get(&keys[0]).copied().unwrap();
        assert_eq!(capped, now + MAX_HOLD);

        reserve(&mut table, &keys, now, Duration::from_secs(1));
        assert_eq!(table.get(&keys[0]).copied().unwrap(), capped);
    }

    #[test]
    fn shared_bucket_holds_every_route_it_covers() {
        let now = base();
        let mut table = HashMap::new();
        let enroll = vec![key("POST /a"), key("bucket:b7")];
        let claim = vec![key("POST /c"), key("bucket:b7")];

        reserve(&mut table, &enroll, now, Duration::from_secs(3));
        assert_eq!(schedule(&mut table, &claim, now, ROUTE_GAP), now + Duration::from_secs(3));
    }

    #[test]
    fn header_hold_only_arms_when_the_budget_is_spent() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ratelimit-remaining", "4".parse().unwrap());
        headers.insert("x-ratelimit-reset-after", "0.3".parse().unwrap());
        assert_eq!(header_hold(&headers), None);

        let mut spent = HeaderMap::new();
        spent.insert("x-ratelimit-remaining", "0".parse().unwrap());
        spent.insert("x-ratelimit-reset-after", "1.25".parse().unwrap());
        assert_eq!(header_hold(&spent), Some(Duration::from_secs_f64(1.25)));

        let mut unparsable = HeaderMap::new();
        unparsable.insert("x-ratelimit-remaining", "0".parse().unwrap());
        unparsable.insert("x-ratelimit-reset-after", "soon".parse().unwrap());
        assert_eq!(header_hold(&unparsable), None);
    }

    #[test]
    fn bucket_alias_is_only_added_once_the_header_exists() {
        let gate = Gate {
            route: key("GET /x"),
        };
        assert_eq!(gate.keys(None), vec![key("GET /x")]);
        let shared = gate.keys(Some(key("bucket:b1")));
        assert_eq!(shared, vec![key("GET /x"), key("bucket:b1")]);
    }
}
