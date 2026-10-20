use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Position {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}
impl Position {
    pub fn validate(self) -> Result<(), String> {
        if self.x.unsigned_abs() > 29_999_984
            || self.z.unsigned_abs() > 29_999_984
            || !(-64..=319).contains(&self.y)
        {
            return Err("position is outside the 1.21.4 overworld bounds".into());
        }
        Ok(())
    }
    pub fn offset(self, x: i32, y: i32, z: i32) -> Self {
        Self {
            x: self.x + x,
            y: self.y + y,
            z: self.z + z,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Structure {
    Wall,
    Platform,
    SimpleHouse,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Action {
    MoveToPlayer {
        player: String,
        #[serde(rename = "maxDistance", default)]
        max_distance: Option<f32>,
    },
    MoveToPosition {
        position: Position,
        #[serde(rename = "maxDistance", default)]
        max_distance: Option<f32>,
    },
    FollowPlayer {
        player: String,
        #[serde(default)]
        distance: Option<f32>,
    },
    Stop,
    MineBlock {
        #[serde(rename = "blockName")]
        block_name: String,
        count: u32,
    },
    CollectResource {
        resource: String,
        count: u32,
        #[serde(default)]
        from: Option<String>,
    },
    PlaceBlock {
        #[serde(rename = "blockName")]
        block_name: String,
        position: Position,
        #[serde(default)]
        face: Option<String>,
    },
    BuildStructure {
        structure: Structure,
        position: Position,
        dimensions: BTreeMap<String, u32>,
        #[serde(default)]
        material: Option<String>,
    },
    EquipItem {
        item: String,
    },
    DropItem {
        item: String,
        #[serde(default)]
        count: Option<u32>,
        #[serde(default, rename = "where")]
        destination: Option<String>,
    },
    DepositItems {
        #[serde(default)]
        item: Option<String>,
        #[serde(default)]
        location: Option<String>,
    },
    WithdrawItems {
        #[serde(default)]
        item: Option<String>,
        #[serde(default)]
        count: Option<u32>,
        #[serde(default)]
        location: Option<String>,
    },
    PickupItems {
        #[serde(default)]
        item: Option<String>,
        #[serde(default)]
        count: Option<u32>,
        #[serde(default)]
        radius: Option<f32>,
    },
    Eat {
        #[serde(default)]
        item: Option<String>,
    },
    AttackHostile {
        #[serde(default)]
        target: Option<String>,
        #[serde(default)]
        radius: Option<f32>,
    },
    DefendPlayer {
        player: String,
        #[serde(default)]
        radius: Option<f32>,
        #[serde(rename = "durationMs", default)]
        duration_ms: Option<u64>,
    },
    LookAt {
        position: Position,
        #[serde(rename = "durationMs", default)]
        duration_ms: Option<u64>,
    },
    Wait {
        #[serde(rename = "durationMs")]
        duration_ms: u64,
    },
}
pub const ACTION_NAMES: &[&str] = &[
    "move_to_player",
    "move_to_position",
    "follow_player",
    "stop",
    "mine_block",
    "collect_resource",
    "place_block",
    "build_structure",
    "equip_item",
    "drop_item",
    "deposit_items",
    "withdraw_items",
    "pickup_items",
    "eat",
    "attack_hostile",
    "defend_player",
    "look_at",
    "wait",
];
pub fn valid_player(s: &str) -> bool {
    !s.is_empty() && s.len() <= 16 && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
}
pub fn valid_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_')
}
fn range(value: Option<f32>, min: f32, max: f32) -> Result<(), String> {
    if value.is_some_and(|v| !v.is_finite() || v < min || v > max) {
        Err("distance or radius outside safety bounds".into())
    } else {
        Ok(())
    }
}
fn name(s: &str) -> Result<(), String> {
    if valid_name(s) {
        Ok(())
    } else {
        Err("invalid item, block or location name".into())
    }
}
fn player(s: &str) -> Result<(), String> {
    if valid_player(s) {
        Ok(())
    } else {
        Err("invalid player name".into())
    }
}
fn count(n: u32, max: u32) -> Result<(), String> {
    if n == 0 || n > max {
        Err(format!("count must be 1..{max}"))
    } else {
        Ok(())
    }
}
impl Action {
    pub fn name(&self) -> &'static str {
        match self {
            Self::MoveToPlayer { .. } => ACTION_NAMES[0],
            Self::MoveToPosition { .. } => ACTION_NAMES[1],
            Self::FollowPlayer { .. } => ACTION_NAMES[2],
            Self::Stop => ACTION_NAMES[3],
            Self::MineBlock { .. } => ACTION_NAMES[4],
            Self::CollectResource { .. } => ACTION_NAMES[5],
            Self::PlaceBlock { .. } => ACTION_NAMES[6],
            Self::BuildStructure { .. } => ACTION_NAMES[7],
            Self::EquipItem { .. } => ACTION_NAMES[8],
            Self::DropItem { .. } => ACTION_NAMES[9],
            Self::DepositItems { .. } => ACTION_NAMES[10],
            Self::WithdrawItems { .. } => ACTION_NAMES[11],
            Self::PickupItems { .. } => ACTION_NAMES[12],
            Self::Eat { .. } => ACTION_NAMES[13],
            Self::AttackHostile { .. } => ACTION_NAMES[14],
            Self::DefendPlayer { .. } => ACTION_NAMES[15],
            Self::LookAt { .. } => ACTION_NAMES[16],
            Self::Wait { .. } => ACTION_NAMES[17],
        }
    }
    pub fn validate(&self, max_mine: u32, max_build: u32) -> Result<(), String> {
        match self {
            Self::MoveToPlayer {
                player: p,
                max_distance,
            } => {
                player(p)?;
                range(*max_distance, 0.5, 512.)?;
            }
            Self::MoveToPosition {
                position,
                max_distance,
            } => {
                position.validate()?;
                range(*max_distance, 0.5, 512.)?;
            }
            Self::FollowPlayer {
                player: p,
                distance,
            } => {
                player(p)?;
                range(*distance, 2., 12.)?;
            }
            Self::MineBlock {
                block_name,
                count: n,
            } => {
                name(block_name)?;
                count(*n, max_mine.min(512))?;
            }
            Self::CollectResource {
                resource,
                count: n,
                from,
            } => {
                if resource.is_empty()
                    || resource.len() > 64
                    || resource.chars().any(char::is_control)
                {
                    return Err("invalid resource".into());
                }
                count(*n, max_mine.min(512))?;
                if let Some(s) = from {
                    name(s)?;
                }
            }
            Self::PlaceBlock {
                block_name,
                position,
                face,
            } => {
                name(block_name)?;
                position.validate()?;
                if face
                    .as_deref()
                    .is_some_and(|f| !["top", "side", "front", "auto"].contains(&f))
                {
                    return Err("invalid face".into());
                }
            }
            Self::BuildStructure {
                structure,
                position,
                dimensions,
                material,
            } => {
                position.validate()?;
                if let Some(s) = material {
                    name(s)?;
                }
                if dimensions.values().any(|n| *n == 0 || *n > 32) {
                    return Err("dimensions must be 1..32".into());
                }
                let plan = build_plan(*structure, *position, dimensions);
                if plan.len() > max_build.min(256) as usize {
                    return Err("structure exceeds block budget".into());
                }
                for p in plan {
                    p.validate()?;
                }
            }
            Self::EquipItem { item } => name(item)?,
            Self::DropItem {
                item,
                count: n,
                destination,
            } => {
                name(item)?;
                if let Some(n) = n {
                    count(*n, 2304)?;
                }
                if destination
                    .as_deref()
                    .is_some_and(|s| !["floor", "chest"].contains(&s))
                {
                    return Err("invalid drop destination".into());
                }
            }
            Self::DepositItems { item, location } | Self::WithdrawItems { item, location, .. } => {
                if let Some(s) = item {
                    name(s)?;
                }
                if let Some(s) = location {
                    name(s)?;
                }
                if let Self::WithdrawItems { count: Some(n), .. } = self {
                    count(*n, 2304)?;
                }
            }
            Self::PickupItems {
                item,
                count: n,
                radius,
            } => {
                if let Some(s) = item {
                    name(s)?;
                }
                if let Some(n) = n {
                    count(*n, 2304)?;
                }
                range(*radius, 1., 64.)?;
            }
            Self::Eat { item } => {
                if let Some(s) = item {
                    name(s)?;
                }
            }
            Self::AttackHostile { target, radius } => {
                if let Some(s) = target {
                    name(s)?;
                }
                range(*radius, 1., 24.)?;
            }
            Self::DefendPlayer {
                player: p,
                radius,
                duration_ms,
            } => {
                player(p)?;
                range(*radius, 2., 24.)?;
                if duration_ms.is_some_and(|n| n > 3_600_000) {
                    return Err("guard duration exceeds one hour".into());
                }
            }
            Self::LookAt {
                position,
                duration_ms,
            } => {
                position.validate()?;
                if duration_ms.is_some_and(|n| n > 30_000) {
                    return Err("look duration exceeds 30 seconds".into());
                }
            }
            Self::Wait { duration_ms } => {
                if *duration_ms > 30_000 {
                    return Err("wait exceeds 30 seconds".into());
                }
            }
            Self::Stop => {}
        }
        Ok(())
    }
}
pub fn build_plan(
    structure: Structure,
    origin: Position,
    d: &BTreeMap<String, u32>,
) -> Vec<Position> {
    let dim = |key: &str, default: u32, max: u32| {
        d.get(key).copied().unwrap_or(default).clamp(1, max) as i32
    };
    let mut out = Vec::new();
    match structure {
        Structure::Wall => {
            for x in 0..dim("length", 5, 32) {
                for y in 0..dim("height", 3, 16) {
                    out.push(origin.offset(x, y, 0));
                }
            }
        }
        Structure::Platform => {
            for x in 0..dim("width", 5, 16) {
                for z in 0..dim("length", 5, 16) {
                    out.push(origin.offset(x, 0, z));
                }
            }
        }
        Structure::SimpleHouse => {
            let size = dim("size", 5, 12);
            let height = dim("height", 4, 8);
            for x in 0..size {
                for z in 0..size {
                    out.push(origin.offset(x, 0, z));
                }
            }
            for y in 1..height {
                for x in 0..size {
                    for z in 0..size {
                        if (x == 0 || z == 0 || x == size - 1 || z == size - 1)
                            && !(x == size / 2 && z == size - 1 && y <= 2)
                        {
                            out.push(origin.offset(x, y, z));
                        }
                    }
                }
            }
            for x in 0..size {
                for z in 0..size {
                    out.push(origin.offset(x, height, z));
                }
            }
        }
    }
    out
}

/// Legacy parity: locate a balanced JSON object/array embedded in prose.
/// Mirrors the TypeScript `extractBalancedJson` behaviour so a plan wrapped in
/// commentary still parses, while everything outside the envelope is ignored
/// (and can never execute).
fn extract_balanced_json(raw: &str) -> Option<&str> {
    let bytes = raw.as_bytes();
    let start = bytes.iter().position(|b| matches!(b, b'{' | b'['))?;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for (i, b) in bytes.iter().enumerate().skip(start) {
        if escaped {
            escaped = false;
            continue;
        }
        match b {
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' | b'[' if !in_string => depth += 1,
            b'}' | b']' if !in_string => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return raw.get(start..=i);
                }
            }
            _ => {}
        }
    }
    None
}
pub fn parse_plan(raw: &str, max_mine: u32, max_build: u32) -> Result<Vec<Action>, String> {
    if raw.len() > 65_536 {
        return Err("AI response too large".into());
    }
    let trimmed = raw.trim();
    let trimmed = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .unwrap_or(trimmed)
        .trim()
        .trim_end_matches("```")
        .trim();
    let value: serde_json::Value = serde_json::from_str(trimmed)
        .or_else(|_| {
            extract_balanced_json(trimmed)
                .ok_or(())
                .and_then(|slice| serde_json::from_str(slice).map_err(|_| ()))
        })
        .map_err(|_| "AI returned invalid JSON")?;
    let items = value
        .as_array()
        .or_else(|| value.get("actions").and_then(|v| v.as_array()))
        .ok_or("AI must return an actions array")?;
    if items.is_empty() || items.len() > 8 {
        return Err("plans must contain 1..8 actions".into());
    }
    let mut actions = Vec::with_capacity(items.len());
    for v in items {
        let mut v = v.clone();
        if let Some(obj) = v.as_object_mut() {
            if let Some(note) = obj.remove("note") {
                if note.as_str().is_none_or(|n| n.len() > 120) {
                    return Err("invalid note".into());
                }
            }
            if obj.get("type").and_then(|v| v.as_str()) == Some("stop") && obj.len() != 1 {
                return Err("stop action has unknown fields".into());
            }
        }
        let a: Action = serde_json::from_value(v)
            .map_err(|_| "AI action contains unknown or invalid fields")?;
        a.validate(max_mine, max_build)?;
        actions.push(a);
    }
    Ok(actions)
}
