use crate::{
    actions::{valid_player, Position},
    config::Config,
};
use regex::Regex;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::LazyLock,
    time::{Duration, Instant},
};
use uuid::Uuid;

pub struct Authorization {
    names: HashSet<String>,
    uuids: HashMap<String, Uuid>,
    windows: HashMap<String, VecDeque<Instant>>,
}
impl Authorization {
    pub fn new(c: &Config) -> Self {
        Self {
            names: c.authorized.clone(),
            uuids: c.authorized_uuids.clone(),
            windows: HashMap::new(),
        }
    }
    pub fn identity(&self, name: &str, uuid: Option<Uuid>) -> bool {
        valid_player(name)
            && self.names.contains(&name.to_ascii_lowercase())
            && self
                .uuids
                .get(&name.to_ascii_lowercase())
                .is_none_or(|id| Some(*id) == uuid)
    }
    pub fn command(&mut self, name: &str, uuid: Option<Uuid>, stop: bool, now: Instant) -> bool {
        if !self.identity(name, uuid) {
            return false;
        }
        if stop {
            return true;
        }
        let w = self.windows.entry(name.to_ascii_lowercase()).or_default();
        while w
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(10))
        {
            w.pop_front();
        }
        if w.len() >= 8 {
            return false;
        }
        w.push_back(now);
        true
    }
}
#[derive(Debug)]
pub struct RateLimit {
    max: u32,
    window: VecDeque<Instant>,
}
impl RateLimit {
    pub fn new(max: u32) -> Self {
        Self {
            max,
            window: VecDeque::new(),
        }
    }
    pub fn acquire(&mut self, now: Instant) -> bool {
        if self.max == 0 {
            return true;
        }
        while self
            .window
            .front()
            .is_some_and(|t| now.saturating_duration_since(*t) >= Duration::from_secs(60))
        {
            self.window.pop_front();
        }
        if self.window.len() >= self.max as usize {
            return false;
        }
        self.window.push_back(now);
        true
    }
}
pub const FOODS: &[&str] = &[
    "golden_carrot",
    "cooked_beef",
    "cooked_porkchop",
    "cooked_chicken",
    "cooked_mutton",
    "cooked_rabbit",
    "cooked_salmon",
    "cooked_cod",
    "bread",
    "apple",
    "baked_potato",
    "carrot",
    "beetroot",
    "melon_slice",
    "sweet_berries",
    "cookie",
    "dried_kelp",
];
pub fn hostile(name: &str) -> bool {
    matches!(
        name,
        "zombie"
            | "skeleton"
            | "creeper"
            | "cave_spider"
            | "witch"
            | "husk"
            | "stray"
            | "wither_skeleton"
            | "slime"
            | "magma_cube"
            | "blaze"
            | "silverfish"
            | "endermite"
            | "guardian"
            | "elder_guardian"
            | "phantom"
            | "piglin_brute"
            | "drowned"
            | "zoglin"
            | "hoglin"
            | "evoker"
            | "vex"
            | "ravager"
            | "pillager"
            | "vindicator"
            | "breeze"
            | "bogged"
    )
}
pub fn reactive_hostile(name: &str) -> bool {
    matches!(
        name,
        "spider" | "enderman" | "piglin" | "zombified_piglin" | "bee" | "polar_bear" | "iron_golem"
    )
}
pub fn avoid_radius(name: &str) -> f64 {
    match name {
        "warden" => 8.,
        "wither" | "ender_dragon" => 12.,
        "creaking" => 6.,
        "enderman" => 3.,
        _ => 0.,
    }
}
pub fn avoid_mob(name: &str, angry: bool, active: bool) -> bool {
    matches!(name, "warden" | "wither" | "ender_dragon")
        || name == "enderman" && angry
        || name == "creaking" && active
}
pub fn dangerous(name: &str) -> bool {
    matches!(
        name,
        "lava"
            | "fire"
            | "soul_fire"
            | "magma_block"
            | "campfire"
            | "soul_campfire"
            | "cactus"
            | "powder_snow"
            | "sweet_berry_bush"
            | "wither_rose"
            | "tnt"
    )
}
pub fn protected(name: &str) -> bool {
    name.ends_with("_planks")
        || name.ends_with("_bed")
        || name.ends_with("_sign")
        || name.ends_with("_banner")
        || name.ends_with("shulker_box")
        || name.ends_with("_wall")
        || matches!(
            name,
            "chest"
                | "trapped_chest"
                | "ender_chest"
                | "barrel"
                | "crafting_table"
                | "furnace"
                | "blast_furnace"
                | "smoker"
                | "anvil"
                | "enchanting_table"
                | "hopper"
                | "note_block"
                | "jukebox"
                | "beacon"
                | "conduit"
                | "lectern"
                | "smithing_table"
                | "loom"
                | "grindstone"
                | "stonecutter"
                | "brewing_stand"
                | "cauldron"
                | "composter"
                | "cartography_table"
                | "flower_pot"
                | "lantern"
                | "torch"
                | "soul_torch"
                | "ladder"
                | "farmland"
                | "beetroots"
                | "wheat"
                | "carrots"
                | "potatoes"
                | "nether_wart"
                | "sugar_cane"
                | "bamboo"
                | "cocoa"
                | "melon_stem"
                | "pumpkin_stem"
                | "glass"
                | "glass_pane"
                | "stone_bricks"
                | "bricks"
        )
}
pub fn region_protected(c: &Config, dimension: &str, p: Position) -> bool {
    c.protected_regions.iter().any(|r| {
        r.dimension == dimension
            && (0..3).all(|i| [p.x, p.y, p.z][i] >= r.min[i] && [p.x, p.y, p.z][i] <= r.max[i])
    })
}
pub fn container_key(dimension: &str, p: Position) -> String {
    format!("{dimension}@{},{},{}", p.x, p.y, p.z)
}
pub fn sensitive(s: &str) -> bool {
    let s = s.to_ascii_lowercase();
    [
        "api_key",
        "api key",
        "token",
        "password",
        "credential",
        "secret",
        ".env",
        "system prompt",
        "ignore previous",
        "ignore all",
        "system instruction",
        "developer message",
        "powershell",
        "bash",
        "shell",
        "filesystem",
        "local file",
        "/op ",
        "/stop",
        "server admin",
        "reveal",
        "printenv",
        "process.env",
        "<system",
        "[inst]",
    ]
    .iter()
    .any(|x| s.contains(x))
}
static KEYS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:sk-[a-z0-9_-]{8,}|gsk_[a-z0-9_-]{8,}|AIza[a-z0-9_-]{12,}|(?:[a-z0-9_-]*(?:key|token|secret|password)[a-z0-9_-]*)\s*[:=]\s*[^\s,;]+)").unwrap()
});
static PATHS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)(?:[a-z]:[\\/][^\s]+|/(?:home|users|etc|var|tmp)/[^\s]+|(?:\d{1,3}\.){3}\d{1,3})",
    )
    .unwrap()
});
pub fn redact(s: &str, secrets: &[String]) -> String {
    let mut s = s.to_string();
    for secret in secrets {
        if !secret.is_empty() {
            s = s.replace(secret, "[REDACTED]");
        }
    }
    let s = KEYS.replace_all(&s, "[REDACTED]");
    PATHS.replace_all(&s, "[PRIVATE]").into_owned()
}
pub fn chat_reply(s: &str, secrets: &[String]) -> String {
    redact(s, secrets)
        .chars()
        .filter(|c| !c.is_control() && *c != '§')
        .take(220)
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
