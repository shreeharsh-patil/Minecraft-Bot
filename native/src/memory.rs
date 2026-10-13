use crate::{actions::Position, world::Point};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, VecDeque},
    io,
    path::{Path, PathBuf},
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_FILE_BYTES: u64 = 262144;
const MAX_ENTRIES: usize = 128;
const VERSION: u32 = 3;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Location {
    pub position: Point,
    pub dimension: String,
    #[serde(default)]
    pub name: String,
    #[serde(default = "resolved_default")]
    pub resolved: bool,
    #[serde(rename = "createdAt", default)]
    pub created_at: u64,
}
fn resolved_default() -> bool {
    true
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Persistent {
    #[serde(rename = "namedLocations", default)]
    pub locations: BTreeMap<String, Location>,
    #[serde(default)]
    pub preferences: BTreeMap<String, String>,
    #[serde(rename = "preferenceUpdatedAt", default)]
    pub preference_updated_at: BTreeMap<String, u64>,
    #[serde(rename = "usefulCoordinates", default)]
    pub useful_coordinates: BTreeMap<String, Point>,
    #[serde(rename = "trustedPlayers", default)]
    pub trusted_players: Vec<String>,
}
impl Persistent {
    fn validate(&self) -> Result<(), String> {
        if [
            self.locations.len(),
            self.preferences.len(),
            self.preference_updated_at.len(),
            self.useful_coordinates.len(),
            self.trusted_players.len(),
        ]
        .into_iter()
        .any(|n| n > MAX_ENTRIES)
        {
            return Err("persistent memory exceeds entry limit".into());
        }
        for (key, location) in &self.locations {
            memory_key(key)?;
            location.position.validate()?;
            dimension_name(&location.dimension)?;
            if location.name.len() > 64 {
                return Err("location display name exceeds limit".into());
            }
        }
        for (key, value) in &self.preferences {
            memory_key(key)?;
            if value.len() > 512 {
                return Err("preference value exceeds limit".into());
            }
        }
        for key in self.preference_updated_at.keys() {
            if !self.preferences.contains_key(key) {
                return Err("preference timestamp has no matching preference".into());
            }
        }
        for (key, point) in &self.useful_coordinates {
            memory_key(key)?;
            point.validate()?;
        }
        if self
            .trusted_players
            .iter()
            .any(|p| !crate::actions::valid_player(p))
        {
            return Err("invalid trusted player in memory".into());
        }
        Ok(())
    }
}
fn memory_key(key: &str) -> Result<(), String> {
    if crate::actions::valid_name(key) {
        Ok(())
    } else {
        Err("invalid memory key".into())
    }
}
fn dimension_name(name: &str) -> Result<(), String> {
    let Some((namespace, path)) = name.split_once(':') else {
        return Err("dimension must be a namespaced identifier".into());
    };
    if name.len() <= 128
        && !namespace.is_empty()
        && !path.is_empty()
        && namespace
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_.-".contains(&c))
        && path
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"_.-/".contains(&c))
    {
        Ok(())
    } else {
        Err("invalid memory dimension".into())
    }
}
#[derive(Debug, Default)]
pub struct Memory {
    pub persistent: Persistent,
    pub conversation: VecDeque<(String, String)>,
    pub failures: VecDeque<String>,
    pub objective: Option<String>,
    file: Option<PathBuf>,
}
impl Memory {
    pub async fn load(file: Option<PathBuf>) -> Self {
        let mut m = Self {
            file,
            ..Self::default()
        };
        let Some(path) = &m.file else {
            return m;
        };
        let bytes = match read_bounded(path).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return m,
            Err(_) => {
                tracing::warn!("memory file unreadable or too large; leaving it untouched");
                m.file = None;
                return m;
            }
        };
        let loaded = serde_json::from_slice::<serde_json::Value>(&bytes)
            .ok()
            .and_then(|v| {
                if !matches!(v.get("version").and_then(|v| v.as_u64()), Some(2 | 3)) {
                    return None;
                }
                let mut p: Persistent =
                    serde_json::from_value(v.get("persistent")?.clone()).ok()?;
                p.validate().ok()?;
                for (key, location) in &mut p.locations {
                    if location.name.is_empty() {
                        location.name.clone_from(key);
                    }
                }
                Some(p)
            });
        if let Some(p) = loaded {
            m.persistent = p;
        } else {
            tracing::warn!("memory schema invalid or legacy; leaving it untouched; use --import-memory for version 1");
            m.file = None;
        }
        m
    }
    pub fn conversation(&mut self, player: &str, text: &str) {
        if self.conversation.len() >= 12 {
            self.conversation.pop_front();
        }
        self.conversation
            .push_back((player.into(), text.chars().take(160).collect()));
    }
    pub fn failure(&mut self, text: &str) {
        if self.failures.len() >= 10 {
            self.failures.pop_front();
        }
        self.failures.push_back(text.chars().take(160).collect());
    }
    pub fn remember(
        &mut self,
        name: &str,
        position: Position,
        dimension: &str,
    ) -> Result<(), String> {
        self.remember_point(
            name,
            Point {
                x: position.x as f64,
                y: position.y as f64,
                z: position.z as f64,
            },
            dimension,
        )
    }
    pub fn remember_point(
        &mut self,
        name: &str,
        position: Point,
        dimension: &str,
    ) -> Result<(), String> {
        let key = name.to_ascii_lowercase();
        memory_key(&key)?;
        if self.persistent.locations.len() >= MAX_ENTRIES
            && !self.persistent.locations.contains_key(&key)
        {
            return Err("location memory is full".into());
        }
        position.validate()?;
        dimension_name(dimension)?;
        let (name, created_at) = self
            .persistent
            .locations
            .get(&key)
            .map(|l| (l.name.clone(), l.created_at))
            .unwrap_or_else(|| (name.into(), now_millis()));
        self.persistent.locations.insert(
            key,
            Location {
                position,
                dimension: dimension.into(),
                name,
                resolved: true,
                created_at,
            },
        );
        Ok(())
    }
    pub fn location(&self, name: &str, dimension: &str) -> Result<&Location, String> {
        let location = self
            .persistent
            .locations
            .get(&name.to_ascii_lowercase())
            .ok_or_else(|| "unknown named location".to_string())?;
        if !location.resolved {
            return Err("location is unresolved; use !remember to set it".into());
        }
        if location.dimension != dimension {
            return Err("location is in another dimension".into());
        }
        Ok(location)
    }
    pub fn set_preference(&mut self, key: &str, value: &str) -> Result<(), String> {
        let key = key.to_ascii_lowercase();
        memory_key(&key)?;
        if value.len() > 512
            || self.persistent.preferences.len() >= MAX_ENTRIES
                && !self.persistent.preferences.contains_key(&key)
        {
            return Err("preference memory limit exceeded".into());
        }
        self.persistent
            .preferences
            .insert(key.clone(), value.into());
        self.persistent
            .preference_updated_at
            .insert(key, now_millis());
        Ok(())
    }
    pub fn preference(&self, key: &str) -> Option<&str> {
        self.persistent
            .preferences
            .get(&key.to_ascii_lowercase())
            .map(String::as_str)
    }
    pub fn add_trusted(&mut self, player: &str) -> Result<(), String> {
        if !crate::actions::valid_player(player) {
            return Err("invalid player name".into());
        }
        if self.is_trusted(player) {
            return Ok(());
        }
        if self.persistent.trusted_players.len() >= MAX_ENTRIES {
            return Err("trusted memory limit exceeded".into());
        }
        self.persistent
            .trusted_players
            .push(player.to_ascii_lowercase());
        Ok(())
    }
    pub fn is_trusted(&self, player: &str) -> bool {
        self.persistent
            .trusted_players
            .iter()
            .any(|p| p.eq_ignore_ascii_case(player))
    }
    pub fn context(&self) -> serde_json::Value {
        // Imported preferences are untrusted data and never grant permissions.
        let preferences: BTreeMap<_, _> = self
            .persistent
            .preferences
            .iter()
            .take(16)
            .filter(|(key, value)| {
                !crate::safety::sensitive(key) && !crate::safety::sensitive(value)
            })
            .map(|(key, value)| (key, crate::safety::redact(value, &[])))
            .collect();
        serde_json::json!({"recentChat":self.conversation,"recentFailures":self.failures,"objective":self.objective,
            "locations":self.persistent.locations.iter().take(16).collect::<BTreeMap<_,_>>(),"preferences":preferences,
            "usefulCoordinates":self.persistent.useful_coordinates.iter().take(16).collect::<BTreeMap<_,_>>()})
    }
    pub async fn persist(&self) -> io::Result<()> {
        if let Some(path) = &self.file {
            self.persistent.validate().map_err(io::Error::other)?;
            let data = encoded(&self.persistent)?;
            if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                tokio::fs::create_dir_all(parent).await?;
            }
            let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
            write_new_private(&temp, &data).await?;
            if let Err(e) = tokio::fs::rename(&temp, path).await {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(e);
            }
        }
        Ok(())
    }
}
fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}
async fn read_bounded(path: &Path) -> io::Result<Vec<u8>> {
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::other("memory file exceeds size limit"));
    }
    Ok(bytes)
}
fn encoded(persistent: &Persistent) -> io::Result<Vec<u8>> {
    let bytes =
        serde_json::to_vec_pretty(&serde_json::json!({"version":VERSION,"persistent":persistent}))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(io::Error::other("memory exceeds size limit"));
    }
    Ok(bytes)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyFile {
    version: u32,
    persistent: LegacyPersistent,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPersistent {
    #[serde(rename = "namedLocations", default)]
    locations: BTreeMap<String, LegacyLocation>,
    #[serde(default)]
    preferences: BTreeMap<String, LegacyPreference>,
    #[serde(rename = "trustedPlayers", default)]
    trusted_players: Vec<String>,
    #[serde(rename = "usefulCoordinates", default)]
    useful_coordinates: BTreeMap<String, Point>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyLocation {
    #[serde(default)]
    name: String,
    position: Point,
    #[serde(default = "resolved_default")]
    resolved: bool,
    #[serde(rename = "createdAt", default)]
    created_at: u64,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyPreference {
    #[serde(default)]
    key: String,
    value: String,
    #[serde(rename = "updatedAt", default)]
    updated_at: u64,
}
#[derive(Debug, PartialEq, Eq)]
pub struct ImportReport {
    pub locations: usize,
    pub preferences: usize,
    pub coordinates: usize,
    pub trusted_players: usize,
}
/// The old schema did not record dimensions. The owner supplies one, and the
/// converter writes a new file without replacing the source or any destination.
pub async fn import_legacy(
    source: &Path,
    destination: &Path,
    dimension: &str,
) -> anyhow::Result<ImportReport> {
    dimension_name(dimension).map_err(anyhow::Error::msg)?;
    let legacy: LegacyFile = serde_json::from_slice(&read_bounded(source).await?)?;
    anyhow::ensure!(legacy.version == 1, "expected legacy memory version 1");
    let mut p = Persistent::default();
    for (key, location) in legacy.persistent.locations {
        let key = key.to_ascii_lowercase();
        let display_name = if location.name.is_empty() {
            key.clone()
        } else {
            location.name
        };
        anyhow::ensure!(
            p.locations
                .insert(
                    key,
                    Location {
                        position: location.position,
                        dimension: dimension.into(),
                        name: display_name,
                        resolved: location.resolved,
                        created_at: location.created_at
                    }
                )
                .is_none(),
            "duplicate normalized location name"
        );
    }
    for (key, preference) in legacy.persistent.preferences {
        let key = key.to_ascii_lowercase();
        anyhow::ensure!(
            preference.key.is_empty() || preference.key.eq_ignore_ascii_case(&key),
            "inconsistent preference key"
        );
        anyhow::ensure!(
            p.preferences
                .insert(key.clone(), preference.value)
                .is_none(),
            "duplicate normalized preference key"
        );
        p.preference_updated_at.insert(key, preference.updated_at);
    }
    for (key, point) in legacy.persistent.useful_coordinates {
        anyhow::ensure!(
            p.useful_coordinates
                .insert(key.to_ascii_lowercase(), point)
                .is_none(),
            "duplicate normalized coordinate name"
        );
    }
    for player in legacy.persistent.trusted_players {
        let player = player.to_ascii_lowercase();
        if !p.trusted_players.contains(&player) {
            p.trusted_players.push(player);
        }
    }
    p.validate().map_err(anyhow::Error::msg)?;
    let report = ImportReport {
        locations: p.locations.len(),
        preferences: p.preferences.len(),
        coordinates: p.useful_coordinates.len(),
        trusted_players: p.trusted_players.len(),
    };
    let bytes = encoded(&p)?;
    // Publish a complete, synced file atomically without replacing any path.
    // The temporary file is beside the destination so the link stays on one volume.
    let temp = destination.with_extension(format!("{}.import.tmp", uuid::Uuid::new_v4()));
    write_new_private(&temp, &bytes).await?;
    let published = tokio::fs::hard_link(&temp, destination).await;
    let _ = tokio::fs::remove_file(&temp).await;
    published?;
    Ok(report)
}
pub async fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    write_private_options(path, data, false).await
}
async fn write_new_private(path: &Path, data: &[u8]) -> io::Result<()> {
    write_private_options(path, data, true).await
}
async fn write_private_options(path: &Path, data: &[u8], create_new: bool) -> io::Result<()> {
    let mut options = tokio::fs::OpenOptions::new();
    options.write(true);
    if create_new {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).await?;
    file.write_all(data).await?;
    file.sync_all().await
}
