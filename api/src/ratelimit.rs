//! Sliding-window counter of failed attempts, kept in memory.
// shortcut: per-process and reset on restart; move to Postgres or Redis when running several API replicas.
use std::{
    collections::{HashMap, VecDeque},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

pub struct Limiter {
    max: usize,
    window: Duration,
    hits: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl Limiter {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { max, window, hits: Mutex::new(HashMap::new()) }
    }

    /// Seconds until the key may try again, or None when it is under the limit.
    pub fn blocked(&self, key: &str, now: Instant) -> Option<u64> {
        let mut map = self.hits.lock().unwrap();
        let q = map.get_mut(key)?;
        while q.front().is_some_and(|t| now.duration_since(*t) >= self.window) {
            q.pop_front();
        }
        if q.is_empty() {
            map.remove(key);
            return None;
        }
        (q.len() >= self.max).then(|| (self.window - now.duration_since(q[0])).as_secs().max(1))
    }

    pub fn record(&self, key: &str, now: Instant) {
        let mut map = self.hits.lock().unwrap();
        // Bound memory under a spray of distinct keys: drop the stalest keys first.
        if map.len() > 50_000 {
            let window = self.window;
            map.retain(|_, q| q.back().is_some_and(|t| now.duration_since(*t) < window));
        }
        map.entry(key.to_string()).or_default().push_back(now);
    }

    pub fn clear(&self, key: &str) {
        self.hits.lock().unwrap().remove(key);
    }
}

const WINDOW: Duration = Duration::from_secs(15 * 60);
/// Failed sign-ins for one email address.
pub static SIGNIN_EMAIL: LazyLock<Limiter> = LazyLock::new(|| Limiter::new(10, WINDOW));
/// Failed sign-ins from one client address (generous: offices and NAT share addresses).
pub static SIGNIN_IP: LazyLock<Limiter> = LazyLock::new(|| Limiter::new(100, WINDOW));

#[cfg(test)]
mod tests {
    use super::Limiter;
    use std::time::{Duration, Instant};

    #[test]
    fn blocks_after_max_and_frees_after_window() {
        let l = Limiter::new(3, Duration::from_secs(60));
        let t0 = Instant::now();
        for i in 0..3 {
            assert_eq!(l.blocked("a", t0), None, "attempt {i}");
            l.record("a", t0);
        }
        assert_eq!(l.blocked("a", t0 + Duration::from_secs(10)), Some(50));
        assert_eq!(l.blocked("b", t0), None, "other keys are independent");
        assert_eq!(l.blocked("a", t0 + Duration::from_secs(60)), None, "window passed");
    }

    #[test]
    fn clear_resets_a_key() {
        let l = Limiter::new(1, Duration::from_secs(60));
        let t0 = Instant::now();
        l.record("a", t0);
        assert!(l.blocked("a", t0).is_some());
        l.clear("a");
        assert!(l.blocked("a", t0).is_none());
    }
}
