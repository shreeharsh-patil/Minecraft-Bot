use crate::world::Snapshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    Idle,
    Background,
    Cooperative,
    Instruction,
    Defense,
    Stop,
    Emergency,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Reflex {
    None,
    Eat,
    Escape,
    Defend,
}
pub fn decide(s: &Snapshot, stopped: bool) -> Reflex {
    if stopped || s.health <= 0. {
        return Reflex::None;
    }
    if s.in_hazard
        || s.health < 6. && !s.hostiles.is_empty()
        || s.avoid_mobs
            .iter()
            .any(|e| e.distance < crate::safety::avoid_radius(&e.name) + 2.)
    {
        Reflex::Escape
    } else if s.hunger <= 14 && s.has_food {
        Reflex::Eat
    } else if s.hostiles.iter().any(|e| e.distance < 3.) {
        Reflex::Defend
    } else {
        Reflex::None
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatherPhase {
    Validate,
    Inventory,
    Search,
    Assess,
    Equip,
    Navigate,
    Dig,
    Collect,
    Verify,
    Complete,
}
pub fn gather_transition(phase: GatherPhase, inventory: u32, requested: u32) -> GatherPhase {
    use GatherPhase::*;
    if inventory >= requested {
        return Complete;
    }
    match phase {
        Validate => Inventory,
        Inventory => Search,
        Search => Assess,
        Assess => Equip,
        Equip => Navigate,
        Navigate => Dig,
        Dig => Collect,
        Collect => Verify,
        Verify => Search,
        Complete => Complete,
    }
}
