use azalea::{
    auth::game_profile::GameProfile,
    entity::Position as AzPosition,
    inventory::{Inventory, ItemStack, ItemStackData},
    protocol::packets::game::{
        c_set_cursor_item::ClientboundSetCursorItem,
        c_set_player_inventory::ClientboundSetPlayerInventory, ClientboundGamePacket,
    },
    world::{Instance, InstanceName, MinecraftEntityId},
    Account, Client, GameProfileComponent, Hunger, InstanceHolder, Vec3,
};
use minecraft_companion::{
    config::Config,
    minecraft::{
        game::{max_stack, same_stack, NativeGame},
        EcsRunner,
    },
    world::Game,
};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
};
fn stack(kind: azalea::registry::Item, count: i32) -> ItemStack {
    ItemStack::Present(ItemStackData {
        kind,
        count,
        components: Default::default(),
    })
}
#[tokio::test]
async fn native_snapshot_does_not_reenter_ecs_lock_and_applies_missing_inventory_packets() {
    let mut runner = EcsRunner::new();
    let profile = GameProfile::new(
        Account::offline("RustBot").uuid_or_offline(),
        "RustBot".into(),
    );
    let entity = runner.world.lock().spawn_empty().id();
    let world = Arc::new(parking_lot::RwLock::new(Instance::default()));
    runner.world.lock().entity_mut(entity).insert((
        GameProfileComponent(profile.clone()),
        Inventory::default(),
        AzPosition::new(Vec3 {
            x: 0.,
            y: 64.,
            z: 0.,
        }),
        InstanceName(azalea::ResourceLocation::new("minecraft:overworld")),
        MinecraftEntityId(1),
        Hunger::default(),
        InstanceHolder::new(entity, world),
    ));
    let bot = Client::new(profile, entity, runner.world.clone(), runner.sender.clone());
    let c = Arc::new(
        Config::from_env(&HashMap::from([
            ("MC_HOST".into(), "localhost".into()),
            ("MC_USERNAME".into(), "RustBot".into()),
            ("AUTHORIZED_PLAYERS".into(), "Steve".into()),
        ]))
        .unwrap(),
    );
    let game = NativeGame::new(bot, c);
    game.spawned.store(true, Ordering::Release);
    game.observe(&ClientboundGamePacket::SetCursorItem(
        ClientboundSetCursorItem {
            contents: stack(azalea::registry::Item::Dirt, 3),
        },
    ));
    assert_eq!(
        game.bot
            .get_component::<Inventory>()
            .unwrap()
            .carried
            .count(),
        3
    );
    game.observe(&ClientboundGamePacket::SetPlayerInventory(
        ClientboundSetPlayerInventory {
            slot: 0,
            contents: stack(azalea::registry::Item::IronPickaxe, 1),
        },
    ));
    assert_eq!(game.snapshot().count("iron_pickaxe"), 1);
    game.stop();
    game.connected.store(false, Ordering::Release);
    runner.shutdown().await;
}
#[test]
fn inventory_stacking_preserves_component_identity_and_caps() {
    let a = stack(azalea::registry::Item::Dirt, 10);
    let b = stack(azalea::registry::Item::Dirt, 64);
    assert!(same_stack(&a, &b));
    assert_eq!(max_stack(&a), 64);
    assert_eq!(max_stack(&stack(azalea::registry::Item::IronPickaxe, 1)), 1);
    assert_eq!(max_stack(&stack(azalea::registry::Item::EnderPearl, 1)), 16);
    assert!(!same_stack(&a, &stack(azalea::registry::Item::Stone, 10)));
}
#[tokio::test]
async fn stale_inventory_cleanup_after_disconnect_does_not_panic() {
    let mut runner = EcsRunner::new();
    let entity = runner.world.lock().spawn_empty().id();
    {
        let mut world = runner.world.lock();
        world.send_event(azalea::inventory::CloseContainerEvent { entity, id: 1 });
        world.send_event(azalea::inventory::ClientSideCloseContainerEvent { entity });
        world.run_schedule(azalea::app::Update);
    }
    runner.shutdown().await;
}
#[test]
fn inventory_cleanup_does_not_replay_valid_events() {
    use azalea::ecs::prelude::*;
    #[derive(Default)]
    struct Count(usize);
    impl Resource for Count {}
    fn count(
        mut reader: EventReader<azalea::inventory::CloseContainerEvent>,
        mut count: ResMut<Count>,
    ) {
        count.0 += reader.read().count();
    }
    let mut app = azalea::app::App::new();
    app.add_event::<azalea::inventory::CloseContainerEvent>()
        .add_event::<azalea::inventory::ClientSideCloseContainerEvent>()
        .init_resource::<Count>()
        .add_plugins(minecraft_companion::minecraft::inventory_cleanup::InventoryCleanupPlugin)
        .add_systems(
            azalea::app::Update,
            count.after(azalea::inventory::InventorySet),
        );
    let entity = app.world_mut().spawn(Inventory::default()).id();
    app.world_mut()
        .send_event(azalea::inventory::CloseContainerEvent { entity, id: 0 });
    for _ in 0..5 {
        app.update();
    }
    assert_eq!(app.world().resource::<Count>().0, 1);
}
