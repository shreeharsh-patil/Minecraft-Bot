//! Vanilla protocol-769 item properties, with per-stack component overrides.
//! Azalea's DataComponentPatch contains changes only, not vanilla defaults.
use azalea::{
    buf::{AzaleaRead, AzaleaReadVar, AzaleaWrite},
    inventory::{components, DataComponentPatch, ItemStack},
    registry::{DataComponentKind, Item, Registry},
};
use std::io::Cursor;

#[path = "item_defaults.rs"]
mod defaults;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Properties {
    pub max_stack_size: u8,
    /// Zero means the item has no default max_damage component.
    pub max_damage: u16,
}
impl Properties {
    const fn new(max_stack_size: u8, max_damage: u16) -> Self {
        Self {
            max_stack_size,
            max_damage,
        }
    }
}
pub fn properties(item: Item) -> Properties {
    defaults::ITEM_PROPERTIES[item.to_u32() as usize]
}

/// The pinned framework has no public removal-query API. Use its verified
/// component codec to distinguish an absent override from explicit removal.
/// No item mutation or inventory prediction is performed.
pub fn removed<T: components::DataComponent>(patch: &DataComponentPatch) -> bool {
    fn check(patch: &DataComponentPatch, wanted: DataComponentKind) -> Option<bool> {
        let mut bytes = Vec::new();
        patch.azalea_write(&mut bytes).ok()?;
        let mut input = Cursor::new(bytes.as_slice());
        let added = u32::azalea_read_var(&mut input).ok()?;
        let deleted = u32::azalea_read_var(&mut input).ok()?;
        if deleted == 0 {
            return Some(false);
        }
        for _ in 0..added {
            let kind = DataComponentKind::azalea_read(&mut input).ok()?;
            components::from_kind(kind, &mut input).ok()?;
        }
        for _ in 0..deleted {
            if DataComponentKind::azalea_read(&mut input).ok()? == wanted {
                return Some(true);
            }
        }
        Some(false)
    }
    // A failed codec must not silently apply permissive defaults.
    check(patch, T::KIND).unwrap_or(true)
}
pub fn max_stack(stack: &ItemStack) -> u32 {
    let ItemStack::Present(s) = stack else {
        return 0;
    };
    if let Some(size) = s.components.get::<components::MaxStackSize>() {
        return size.count.clamp(1, 99) as u32;
    }
    if removed::<components::MaxStackSize>(&s.components) {
        return 1;
    }
    properties(s.kind).max_stack_size as u32
}
pub fn remaining_durability(stack: &ItemStack) -> Option<i32> {
    let ItemStack::Present(s) = stack else {
        return None;
    };
    if s.components.has::<components::Unbreakable>()
        || removed::<components::MaxDamage>(&s.components)
        || removed::<components::Damage>(&s.components)
    {
        return None;
    }
    let max = s
        .components
        .get::<components::MaxDamage>()
        .map(|m| m.amount)
        .unwrap_or(properties(s.kind).max_damage as i32);
    if max <= 0 {
        return None;
    }
    let damage = s
        .components
        .get::<components::Damage>()
        .map(|d| d.amount)
        .unwrap_or(0);
    Some(max.saturating_sub(damage))
}
