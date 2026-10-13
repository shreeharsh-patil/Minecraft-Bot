//! Mining rules for protocol 769. Registry hardness/tags come from the pinned
//! Azalea source. Unlike its mining helper, this checks tool family, enchantments
//! and server effect packets. Success is a server block update, never a timer.
use azalea::{
    blocks::{Block, BlockState},
    core::tier::get_item_tier,
    inventory::{components, ItemStack},
    registry::{self, Item},
};

#[derive(Debug, Clone, Copy)]
pub struct Environment {
    pub on_ground: bool,
    pub underwater: bool,
    pub aqua_affinity: bool,
    pub haste: Option<u32>,
    pub fatigue: Option<u32>,
    pub submerged_speed: f32,
    pub mining_efficiency: f32,
    pub block_break_speed: f32,
    pub efficiency_id: Option<u32>,
    pub silk_touch_id: Option<u32>,
}
impl Default for Environment {
    fn default() -> Self {
        Self {
            on_ground: true,
            underwater: false,
            aqua_affinity: false,
            haste: None,
            fatigue: None,
            submerged_speed: 0.2,
            mining_efficiency: 0.,
            block_break_speed: 1.,
            efficiency_id: None,
            silk_touch_id: None,
        }
    }
}
pub fn enchantment(stack: &ItemStack, id: Option<u32>) -> u32 {
    use azalea::registry::DataRegistry;
    if let ItemStack::Present(s) = stack {
        s.components
            .get::<components::Enchantments>()
            .and_then(|e2| {
                e2.levels
                    .iter()
                    .find(|(e, _)| Some(e.protocol_id()) == id)
                    .map(|(_, level)| *level)
            })
            .unwrap_or(0)
    } else {
        0
    }
}
pub fn correct_for_drops(state: BlockState, tool: Item) -> bool {
    use registry::{
        tags::{blocks as b, items as i},
        Block as B,
    };
    let block = Box::<dyn Block>::from(state);
    let kind = block.as_registry_block();
    if !block.behavior().requires_correct_tool_for_drops {
        return true;
    }
    if kind == B::Cobweb {
        return tool == Item::Shears || i::SWORDS.contains(&tool);
    }
    let family = i::PICKAXES.contains(&tool) && b::MINEABLE_PICKAXE.contains(&kind)
        || i::AXES.contains(&tool) && b::MINEABLE_AXE.contains(&kind)
        || i::SHOVELS.contains(&tool) && b::MINEABLE_SHOVEL.contains(&kind)
        || i::HOES.contains(&tool) && b::MINEABLE_HOE.contains(&kind);
    let Some(tier) = get_item_tier(tool) else {
        return false;
    };
    family
        && !(tier.level() < 3 && b::NEEDS_DIAMOND_TOOL.contains(&kind)
            || tier.level() < 2 && b::NEEDS_IRON_TOOL.contains(&kind)
            || tier.level() < 1 && b::NEEDS_STONE_TOOL.contains(&kind))
}
pub fn base_speed(state: BlockState, tool: Item) -> f32 {
    use registry::{
        tags::{blocks as b, items as i},
        Block as B,
    };
    let kind = Box::<dyn Block>::from(state).as_registry_block();
    if tool == Item::Shears {
        if kind == B::Cobweb || b::LEAVES.contains(&kind) {
            return 15.;
        }
        if b::WOOL.contains(&kind) {
            return 5.;
        }
        if matches!(kind, B::Vine | B::GlowLichen) {
            return 2.;
        }
    }
    if i::SWORDS.contains(&tool) {
        if kind == B::Cobweb {
            return 15.;
        }
        if b::SWORD_EFFICIENT.contains(&kind) {
            return 1.5;
        }
    }
    let efficient = i::PICKAXES.contains(&tool) && b::MINEABLE_PICKAXE.contains(&kind)
        || i::AXES.contains(&tool) && b::MINEABLE_AXE.contains(&kind)
        || i::SHOVELS.contains(&tool) && b::MINEABLE_SHOVEL.contains(&kind)
        || i::HOES.contains(&tool) && b::MINEABLE_HOE.contains(&kind);
    if efficient {
        get_item_tier(tool).map(|t| t.speed()).unwrap_or(1.)
    } else {
        1.
    }
}
pub fn progress_per_tick(state: BlockState, stack: &ItemStack, env: Environment) -> f32 {
    let block = Box::<dyn Block>::from(state);
    let hardness = block.behavior().destroy_time;
    if hardness < 0.
        || matches!(
            block.as_registry_block(),
            registry::Block::Water | registry::Block::Lava
        )
    {
        return 0.;
    }
    if hardness == 0. {
        return 1.;
    }
    let mut speed = base_speed(state, stack.kind());
    if speed > 1. {
        let e = enchantment(stack, env.efficiency_id).min(255);
        speed += env
            .mining_efficiency
            .max(if e > 0 { (e * e + 1) as f32 } else { 0. });
    }
    if let Some(amplifier) = env.haste {
        speed *= 1. + (amplifier + 1) as f32 * 0.2;
    }
    if let Some(amplifier) = env.fatigue {
        speed *= match amplifier {
            0 => 0.3,
            1 => 0.09,
            2 => 0.0027,
            _ => 0.00081,
        };
    }
    speed *= env.block_break_speed;
    if env.underwater {
        speed *= if env.aqua_affinity {
            1.
        } else {
            env.submerged_speed
        };
    }
    if !env.on_ground {
        speed /= 5.;
    }
    speed
        / hardness
        / if correct_for_drops(state, stack.kind()) {
            30.
        } else {
            100.
        }
}
pub fn expected_ticks(progress: f32) -> Option<u32> {
    if progress <= 0. || !progress.is_finite() {
        None
    } else {
        Some((1. / progress).ceil().max(1.) as u32)
    }
}
pub fn remaining_durability(stack: &ItemStack) -> Option<i32> {
    crate::items::remaining_durability(stack)
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropGoal {
    Break,
    Harvest,
    SilkTouch,
}
#[derive(Debug, Clone)]
pub struct ToolChoice {
    pub slot: usize,
    pub ticks: u32,
    pub score: f32,
}
pub fn select_tool(
    state: BlockState,
    slots: &[(usize, ItemStack)],
    current: usize,
    env: Environment,
    goal: DropGoal,
) -> Option<ToolChoice> {
    let mut best: Option<ToolChoice> = None;
    for (slot, stack) in slots {
        if goal != DropGoal::Break && !correct_for_drops(state, stack.kind()) {
            continue;
        }
        if goal == DropGoal::SilkTouch
            && !(enchantment(stack, env.silk_touch_id) > 0
                || stack.kind() == Item::Shears
                    && (Box::<dyn Block>::from(state).as_registry_block()
                        == registry::Block::Cobweb
                        || registry::tags::blocks::LEAVES
                            .contains(&Box::<dyn Block>::from(state).as_registry_block())))
        {
            continue;
        }
        let remaining = remaining_durability(stack);
        if remaining.is_some_and(|n| n <= 2) {
            continue;
        }
        let Some(ticks) = expected_ticks(progress_per_tick(state, stack, env)) else {
            continue;
        };
        let durability = remaining.map(|r| 20. / r as f32).unwrap_or(0.);
        let score = ticks as f32 + durability + if *slot == current { 0. } else { 2. };
        if best.as_ref().is_none_or(|b| score < b.score) {
            best = Some(ToolChoice {
                slot: *slot,
                ticks,
                score,
            });
        }
    }
    best
}
pub fn resource(resource: &str) -> (Vec<String>, Vec<String>) {
    let n = resource
        .to_ascii_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("_");
    let logs = || {
        [
            "oak", "birch", "spruce", "jungle", "acacia", "dark_oak", "mangrove", "cherry",
            "pale_oak",
        ]
        .iter()
        .map(|n| format!("{n}_log"))
        .collect::<Vec<_>>()
    };
    match n.as_str() {
        "wood" | "timber" | "logs" | "log" => {
            let n = logs();
            (n.clone(), n)
        }
        "coal" | "diamond" | "emerald" | "redstone" => (
            vec![format!("{n}_ore"), format!("deepslate_{n}_ore")],
            vec![n],
        ),
        "iron" | "gold" | "copper" => (
            vec![format!("{n}_ore"), format!("deepslate_{n}_ore")],
            vec![format!("raw_{n}")],
        ),
        "lapis" | "lapis_lazuli" => (
            vec!["lapis_ore".into(), "deepslate_lapis_ore".into()],
            vec!["lapis_lazuli".into()],
        ),
        "cobblestone" | "rocks" => (
            vec!["stone".into(), "cobblestone".into()],
            vec!["cobblestone".into()],
        ),
        "soil" | "earth" | "dirt" => (
            vec!["dirt".into(), "grass_block".into()],
            vec!["dirt".into()],
        ),
        _ => {
            let n = n
                .strip_suffix("_logs")
                .map(|s| format!("{s}_log"))
                .unwrap_or(n);
            (vec![n.clone()], vec![n])
        }
    }
}
