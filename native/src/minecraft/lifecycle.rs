use crate::config::Config;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::Path,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    Waiting,
    Connecting,
    Authenticating,
    Spawned,
    Active,
    Leaving,
    Error,
    Cooldown,
    Stopped,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DisconnectReason {
    Manual,
    Shutdown,
    ServerStop,
    PermanentAuth,
    Rejected,
    Transient,
    NoHumans,
    SpawnTimeout,
}
pub fn classify_disconnect(reason: Option<&str>) -> DisconnectReason {
    let Some(reason) = reason else {
        return DisconnectReason::Transient;
    };
    let s = reason.to_ascii_lowercase();
    if ["closed", "shutdown", "stopping", "restart", "server stop"]
        .iter()
        .any(|t| s.contains(t))
    {
        DisconnectReason::ServerStop
    } else if [
        "invalid session",
        "authentication",
        "authenticate",
        "verify username",
        "not authenticated",
    ]
    .iter()
    .any(|t| s.contains(t))
    {
        DisconnectReason::PermanentAuth
    } else if [
        "timeout",
        "timed out",
        "connection reset",
        "connection lost",
    ]
    .iter()
    .any(|t| s.contains(t))
    {
        DisconnectReason::Transient
    } else {
        DisconnectReason::Rejected
    }
}
pub struct Presence {
    pub online: HashSet<Uuid>,
    pub empty_since: Option<Instant>,
    grace: Duration,
}
impl Presence {
    pub fn new(grace: Duration, now: Instant) -> Self {
        Self {
            online: HashSet::new(),
            empty_since: Some(now),
            grace,
        }
    }
    pub fn reconcile(&mut self, online: HashSet<Uuid>, now: Instant) {
        self.online = online;
        if self.online.is_empty() {
            self.empty_since.get_or_insert(now);
        } else {
            self.empty_since = None;
        }
    }
    pub fn expired(&self, now: Instant) -> bool {
        self.empty_since
            .is_some_and(|t| now.saturating_duration_since(t) >= self.grace)
    }
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Activation {
    pub active: bool,
    pub authorized_players: Vec<String>,
    pub expires_unix: u64,
    pub session_id: Uuid,
}
pub async fn read_activation(path: &Path, c: &Config) -> Option<Activation> {
    let metadata = tokio::fs::metadata(path).await.ok()?;
    if metadata.len() > 4096 {
        return None;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o022 != 0 {
            return None;
        }
    }
    let bytes = tokio::fs::read(path).await.ok()?;
    let lease: Activation = serde_json::from_slice(&bytes).ok()?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs();
    if !lease.active
        || lease.expires_unix <= now
        || lease.expires_unix > now + 120
        || !lease
            .authorized_players
            .iter()
            .any(|n| c.authorized.contains(&n.to_ascii_lowercase()))
    {
        return None;
    }
    Some(lease)
}
