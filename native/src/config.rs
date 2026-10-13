use crate::actions::valid_player;
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    time::Duration,
};
use uuid::Uuid;

pub const MINECRAFT_VERSION: &str = "1.21.4";
pub const PROTOCOL_VERSION: i32 = 769;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Auth {
    Microsoft,
    Offline,
}
#[derive(Clone)]
pub struct ProviderConfig {
    pub name: String,
    pub key: String,
    pub model: String,
}
impl std::fmt::Debug for ProviderConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderConfig")
            .field("name", &self.name)
            .field("model", &self.model)
            .field("key", &"[REDACTED]")
            .finish()
    }
}
#[derive(Debug, Clone)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: Auth,
    pub microsoft_email: Option<String>,
    pub auth_cache: PathBuf,
    pub spawn_timeout: Duration,
    pub authorized: HashSet<String>,
    pub authorized_uuids: HashMap<String, Uuid>,
    pub prefix: String,
    pub providers: Vec<ProviderConfig>,
    pub ai_timeout: Duration,
    pub planning_model: Option<String>,
    pub circuit_threshold: u32,
    pub circuit_cooldown: Duration,
    pub ai_concurrency: usize,
    pub human_timeout: Duration,
    pub memory_file: Option<PathBuf>,
    pub reconnect_attempts: u32,
    pub reconnect_delay: Duration,
    pub max_actions: u32,
    pub max_mine: u32,
    pub max_build: u32,
    pub follow_distance: f32,
    pub task_timeout: Duration,
    pub log_level: String,
    pub log_format: String,
    pub allow_containers: HashSet<String>,
    pub protected_regions: Vec<Region>,
    pub server_tab_trusted: bool,
}
#[derive(Debug, Clone)]
pub struct Region {
    pub dimension: String,
    pub min: [i32; 3],
    pub max: [i32; 3],
}
impl Config {
    pub fn load() -> Result<Self, String> {
        dotenvy::dotenv().ok();
        Self::from_env(&std::env::vars().collect())
    }
    pub fn from_env(env: &HashMap<String, String>) -> Result<Self, String> {
        let get = |k: &str| env.get(k).map(|s| s.trim()).filter(|s| !s.is_empty());
        let required = |k: &str| -> Result<String, String> {
            get(k)
                .map(str::to_string)
                .ok_or_else(|| format!("{k} is required"))
        };
        let num = |k: &str, d: u64, min: u64, max: u64| -> Result<u64, String> {
            let n = get(k)
                .map(str::parse::<u64>)
                .transpose()
                .map_err(|_| format!("{k} must be an integer"))?
                .unwrap_or(d);
            if n < min || n > max {
                Err(format!("{k} must be {min}..{max}"))
            } else {
                Ok(n)
            }
        };
        let host = required("MC_HOST")?;
        if host.contains(['/', '\\', ' ', '\n', '\r']) || host.len() > 253 {
            return Err("MC_HOST must be a hostname or IP address".into());
        }
        if host.to_ascii_lowercase().ends_with(".aternos.me")
            && num("MAX_RECONNECT_ATTEMPTS", 0, 0, 5)? != 0
        {
            return Err(
                "Aternos policy prohibits automatic reconnects; MAX_RECONNECT_ATTEMPTS must be 0"
                    .into(),
            );
        }
        let username = required("MC_USERNAME")?;
        if !valid_player(&username) {
            return Err("invalid MC_USERNAME".into());
        }
        if get("MC_VERSION").is_some_and(|v| v != MINECRAFT_VERSION) {
            return Err(format!("this executable only supports Minecraft {MINECRAFT_VERSION}; choose a matching framework revision"));
        }
        let auth = match get("MC_AUTH").unwrap_or("microsoft") {
            "microsoft" => Auth::Microsoft,
            "offline" => Auth::Offline,
            _ => return Err("MC_AUTH must be microsoft or offline".into()),
        };
        let authorized: HashSet<_> = required("AUTHORIZED_PLAYERS")?
            .split(',')
            .map(|s| s.trim().to_ascii_lowercase())
            .collect();
        if authorized.is_empty()
            || authorized.iter().any(|n| !valid_player(n))
            || authorized.contains(&username.to_ascii_lowercase())
        {
            return Err("AUTHORIZED_PLAYERS must be valid usernames and exclude the bot".into());
        }
        let mut authorized_uuids = HashMap::new();
        if let Some(s) = get("AUTHORIZED_UUIDS") {
            for pair in s.split(',') {
                let (name, id) = pair
                    .trim()
                    .split_once('=')
                    .ok_or("AUTHORIZED_UUIDS must use name=uuid entries")?;
                let name = name.to_ascii_lowercase();
                if !authorized.contains(&name) {
                    return Err("UUID names must be authorized".into());
                }
                authorized_uuids.insert(
                    name,
                    Uuid::parse_str(id).map_err(|_| "invalid authorized UUID")?,
                );
            }
        }
        let priority = get("AI_PROVIDER_PRIORITY").unwrap_or("groq,gemini,openai,openrouter");
        let mut providers = Vec::new();
        let mut seen = HashSet::new();
        for name in priority.split(',').map(str::trim) {
            if !["groq", "gemini", "openai", "openrouter"].contains(&name) {
                return Err("invalid AI_PROVIDER_PRIORITY".into());
            }
            if !seen.insert(name) {
                continue;
            }
            let pre = name.to_ascii_uppercase();
            let model_key = format!("{pre}_MODEL");
            let model = get(&model_key).unwrap_or(match name {
                "groq" => "llama-3.3-70b-versatile",
                "gemini" => "gemini-2.5-flash",
                "openai" => "gpt-4o-mini",
                _ => "openai/gpt-4o-mini",
            });
            if model.len() > 120 || model.chars().any(char::is_control) {
                return Err("invalid model name".into());
            }
            let keys_key = format!("{pre}_API_KEYS");
            let key_key = format!("{pre}_API_KEY");
            if let Some(keys) = get(&keys_key).or_else(|| get(&key_key)) {
                for key in keys.split(',').map(str::trim).filter(|s| !s.is_empty()) {
                    providers.push(ProviderConfig {
                        name: name.into(),
                        key: key.into(),
                        model: model.into(),
                    });
                }
            }
        }
        let prefix = get("BOT_PREFIX").unwrap_or("!").to_string();
        if !["debug", "info", "warn", "error", "silent"]
            .contains(&get("LOG_LEVEL").unwrap_or("info"))
        {
            return Err("LOG_LEVEL must be debug, info, warn, error or silent".into());
        }
        if !["pretty", "json"].contains(&get("LOG_FORMAT").unwrap_or("pretty")) {
            return Err("LOG_FORMAT must be pretty or json".into());
        }
        if prefix.is_empty() || prefix.len() > 8 || prefix.chars().any(char::is_whitespace) {
            return Err("invalid BOT_PREFIX".into());
        }
        // Aternos safety is mandatory; the legacy false setting is refused explicitly.
        if get("DISCONNECT_WITHOUT_HUMANS")
            .is_some_and(|v| !["true", "1", "yes", "on"].contains(&v.to_ascii_lowercase().as_str()))
        {
            return Err("DISCONNECT_WITHOUT_HUMANS must remain enabled".into());
        }
        let follow_distance = get("FOLLOW_DISTANCE")
            .map(str::parse::<f32>)
            .transpose()
            .map_err(|_| "invalid FOLLOW_DISTANCE")?
            .unwrap_or(3.);
        if !follow_distance.is_finite() || !(2.0..=12.0).contains(&follow_distance) {
            return Err("FOLLOW_DISTANCE must be 2..12".into());
        }
        let allow_containers = get("AUTHORIZED_CONTAINERS")
            .unwrap_or("")
            .split(';')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        let mut protected_regions = Vec::new();
        if let Some(regions) = get("PROTECTED_REGIONS") {
            for region in regions.split(';') {
                let (dimension, coords) = region
                    .split_once('@')
                    .ok_or("PROTECTED_REGIONS needs dimension@x,y,z,x,y,z")?;
                let coords: Vec<i32> = coords
                    .split(',')
                    .map(str::parse)
                    .collect::<Result<_, _>>()
                    .map_err(|_| "invalid protected region coordinates")?;
                if coords.len() != 6 {
                    return Err("protected region needs six coordinates".into());
                }
                if (0..3).any(|i| coords[i] > coords[i + 3]) {
                    return Err("region minimum exceeds maximum".into());
                }
                protected_regions.push(Region {
                    dimension: dimension.into(),
                    min: [coords[0], coords[1], coords[2]],
                    max: [coords[3], coords[4], coords[5]],
                });
            }
        }
        Ok(Self {
            host,
            port: num("MC_PORT", 25565, 1, 65535)? as u16,
            username,
            auth,
            microsoft_email: get("MC_MICROSOFT_EMAIL").map(str::to_string),
            auth_cache: get("MC_PROFILES_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("data/auth")),
            spawn_timeout: Duration::from_millis(num(
                "MC_SPAWN_TIMEOUT_MS",
                60_000,
                1000,
                180_000,
            )?),
            authorized,
            authorized_uuids,
            prefix,
            providers,
            ai_timeout: Duration::from_millis(num("AI_REQUEST_TIMEOUT_MS", 20_000, 100, 120_000)?),
            planning_model: get("AI_PLANNING_MODEL").map(str::to_string),
            circuit_threshold: num("AI_CIRCUIT_FAILURE_THRESHOLD", 3, 1, 100)? as u32,
            circuit_cooldown: Duration::from_millis(num(
                "AI_CIRCUIT_COOLDOWN_MS",
                60_000,
                100,
                600_000,
            )?),
            ai_concurrency: num("AI_MAX_CONCURRENT_REQUESTS", 2, 1, 8)? as usize,
            human_timeout: Duration::from_secs(num("HUMAN_TIMEOUT_SECONDS", 60, 1, 120)?),
            memory_file: get("MEMORY_FILE").map(PathBuf::from),
            reconnect_attempts: num("MAX_RECONNECT_ATTEMPTS", 0, 0, 5)? as u32,
            reconnect_delay: Duration::from_millis(num(
                "RECONNECT_BASE_DELAY_MS",
                5000,
                1000,
                60_000,
            )?),
            max_actions: num("MAX_ACTIONS_PER_MINUTE", 120, 0, 1000)? as u32,
            max_mine: num("MAX_MINING_BLOCKS_PER_TASK", 512, 1, 512)? as u32,
            max_build: num("MAX_BUILD_BLOCKS_PER_TASK", 256, 1, 256)? as u32,
            follow_distance,
            task_timeout: Duration::from_secs(num("TASK_TIMEOUT_SECONDS", 600, 1, 3600)?),
            log_level: get("LOG_LEVEL").unwrap_or("info").into(),
            log_format: get("LOG_FORMAT").unwrap_or("pretty").into(),
            allow_containers,
            protected_regions,
            server_tab_trusted: get("TRUST_SERVER_TAB_LIST").unwrap_or("true") == "true",
        })
    }
    pub fn address(&self) -> String {
        if self.port == 25565 {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}
