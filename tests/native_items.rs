use azalea::{
    buf::{AzaleaRead, AzaleaWrite, AzaleaWriteVar},
    inventory::{components, DataComponentPatch, ItemStack, ItemStackData},
    registry::{DataComponentKind, Item, Registry},
};
use minecraft_companion::{items, mining};
use std::io::Cursor;

fn stack(kind: Item, components: DataComponentPatch) -> ItemStack {
    ItemStack::Present(ItemStackData {
        kind,
        count: 1,
        components,
    })
}
fn patch(
    added: &[(DataComponentKind, Vec<u8>)],
    removed: &[DataComponentKind],
) -> DataComponentPatch {
    let mut bytes = Vec::new();
    (added.len() as u32).azalea_write_var(&mut bytes).unwrap();
    (removed.len() as u32).azalea_write_var(&mut bytes).unwrap();
    for (kind, data) in added {
        kind.azalea_write(&mut bytes).unwrap();
        bytes.extend(data);
    }
    for kind in removed {
        kind.azalea_write(&mut bytes).unwrap();
    }
    DataComponentPatch::azalea_read(&mut Cursor::new(bytes.as_slice())).unwrap()
}
#[test]
fn every_vanilla_item_matches_the_official_report_and_pinned_protocol_id() {
    let expected: Vec<(String, u8, u16)> =
        serde_json::from_str(include_str!("../native/data/items-1.21.4.json")).unwrap();
    assert_eq!(expected.len(), 1385);
    for (id, (name, size, damage)) in expected.into_iter().enumerate() {
        let kind =
            Item::from_u32(id as u32).expect("report item missing in pinned protocol registry");
        assert_eq!(
            kind.to_string(),
            name,
            "protocol registry diverged at ID {id}"
        );
        assert_eq!(items::properties(kind).max_stack_size, size, "{name}");
        assert_eq!(items::properties(kind).max_damage, damage, "{name}");
        let stack = stack(kind, Default::default());
        assert_eq!(items::max_stack(&stack), size as u32, "{name}");
        assert_eq!(
            items::remaining_durability(&stack),
            (damage > 0).then_some(damage as i32),
            "{name}"
        );
    }
    assert!(Item::from_u32(1385).is_none());
}
#[test]
fn previously_misclassified_inventory_items_have_their_actual_limits() {
    for kind in [
        Item::Potion,
        Item::SplashPotion,
        Item::OakBoat,
        Item::Minecart,
        Item::EnchantedBook,
        Item::Cake,
        Item::Saddle,
        Item::RabbitStew,
        Item::Bundle,
    ] {
        assert_eq!(
            items::max_stack(&stack(kind, Default::default())),
            1,
            "{kind}"
        );
    }
    assert_eq!(
        items::max_stack(&stack(Item::ArmorStand, Default::default())),
        16
    );
    assert_eq!(
        items::remaining_durability(&stack(Item::Shield, Default::default())),
        Some(336)
    );
    assert_eq!(
        items::remaining_durability(&stack(Item::Elytra, Default::default())),
        Some(432)
    );
    assert_eq!(items::max_stack(&ItemStack::Empty), 0);
}
#[test]
fn component_overrides_and_removals_do_not_reapply_default_durability() {
    let mut max = Vec::new();
    components::MaxDamage { amount: 100 }
        .azalea_write(&mut max)
        .unwrap();
    let mut damage = Vec::new();
    components::Damage { amount: 98 }
        .azalea_write(&mut damage)
        .unwrap();
    let mut size = Vec::new();
    components::MaxStackSize { count: 7 }
        .azalea_write(&mut size)
        .unwrap();
    let item = stack(
        Item::IronPickaxe,
        patch(
            &[
                (DataComponentKind::MaxDamage, max.clone()),
                (DataComponentKind::Damage, damage),
                (DataComponentKind::MaxStackSize, size),
            ],
            &[],
        ),
    );
    assert_eq!(items::max_stack(&item), 7);
    assert_eq!(items::remaining_durability(&item), Some(2));
    for kind in [DataComponentKind::MaxDamage, DataComponentKind::Damage] {
        let item = stack(Item::IronPickaxe, patch(&[], &[kind]));
        assert_eq!(items::remaining_durability(&item), None);
    }
    let item = stack(
        Item::IronPickaxe,
        patch(
            &[(DataComponentKind::MaxDamage, max)],
            &[DataComponentKind::Damage],
        ),
    );
    assert_eq!(items::remaining_durability(&item), None);
    let item = stack(Item::Dirt, patch(&[], &[DataComponentKind::MaxStackSize]));
    assert_eq!(items::max_stack(&item), 1);
    // Default damageable swords still have a stack limit of 1 when unbreakable.
    let mut data = Vec::new();
    components::Unbreakable {
        show_in_tooltip: true,
    }
    .azalea_write(&mut data)
    .unwrap();
    let item = stack(
        Item::IronSword,
        patch(&[(DataComponentKind::Unbreakable, data)], &[]),
    );
    assert_eq!(items::remaining_durability(&item), None);
    assert_eq!(items::max_stack(&item), 1);
}
#[test]
fn worn_tools_are_avoided_using_server_damage_overrides() {
    let mut data = Vec::new();
    components::Damage { amount: 249 }
        .azalea_write(&mut data)
        .unwrap();
    let worn = stack(
        Item::IronPickaxe,
        patch(&[(DataComponentKind::Damage, data)], &[]),
    );
    let fresh = stack(Item::StonePickaxe, Default::default());
    let choice = mining::select_tool(
        azalea::registry::Block::Stone.into(),
        &[(36, worn), (9, fresh)],
        36,
        Default::default(),
        mining::DropGoal::Harvest,
    )
    .unwrap();
    assert_eq!(choice.slot, 9);
}
