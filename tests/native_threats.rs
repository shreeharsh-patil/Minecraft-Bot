use azalea::{
    auth::game_profile::GameProfile,
    entity::{
        metadata::{Creepy, Health, IsActive},
        EntityKind, Position as AzPosition,
    },
    inventory::Inventory,
    protocol::packets::game::{
        c_damage_event::{ClientboundDamageEvent, OptionalEntityId},
        c_remove_entities::ClientboundRemoveEntities,
        ClientboundGamePacket,
    },
    world::{Instance, InstanceName, MinecraftEntityId},
    Account, Client, GameProfileComponent, Hunger, InstanceHolder, Vec3,
};
use minecraft_companion::{
    config::Config,
    intelligence::{decide, Reflex},
    minecraft::{
        game::NativeGame,
        path_safety::{threat_blocks_step, ThreatZone},
        EcsRunner,
    },
    world::{Game, Point},
};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};

fn fixture(pin: Option<uuid::Uuid>) -> (EcsRunner, NativeGame) {
    let runner = EcsRunner::new();
    let profile = GameProfile::new(
        Account::offline("RustBot").uuid_or_offline(),
        "RustBot".into(),
    );
    let entity = runner.world.lock().spawn_empty().id();
    let instance = Arc::new(parking_lot::RwLock::new(Instance::default()));
    runner.world.lock().entity_mut(entity).insert((
        GameProfileComponent(profile.clone()),
        Inventory::default(),
        AzPosition::new(Vec3 {
            x: 0.,
            y: 64.,
            z: 0.,
        }),
        EntityKind(azalea::registry::EntityKind::Player),
        InstanceName(azalea::ResourceLocation::new("minecraft:overworld")),
        MinecraftEntityId(1),
        Hunger::default(),
        Health(20.),
        InstanceHolder::new(entity, instance),
    ));
    let bot = Client::new(profile, entity, runner.world.clone(), runner.sender.clone());
    let mut env = HashMap::from([
        ("MC_HOST".into(), "localhost".into()),
        ("MC_USERNAME".into(), "RustBot".into()),
        ("AUTHORIZED_PLAYERS".into(), "Steve".into()),
    ]);
    if let Some(pin) = pin {
        env.insert("AUTHORIZED_UUIDS".into(), format!("Steve={pin}"));
    }
    let game = NativeGame::new(bot, Arc::new(Config::from_env(&env).unwrap()));
    game.spawned.store(true, Ordering::Release);
    (runner, game)
}
fn mob(
    game: &NativeGame,
    kind: azalea::registry::EntityKind,
    id: u32,
    x: f64,
) -> azalea::ecs::entity::Entity {
    game.bot
        .ecs
        .lock()
        .spawn((
            AzPosition::new(Vec3 { x, y: 64., z: 0. }),
            EntityKind(kind),
            MinecraftEntityId(id),
            Health(20.),
            InstanceName(azalea::ResourceLocation::new("minecraft:overworld")),
        ))
        .id()
}
fn damage(victim: u32, attacker: Option<u32>) -> ClientboundGamePacket {
    ClientboundGamePacket::DamageEvent(ClientboundDamageEvent {
        entity_id: victim,
        source_type_id: 0,
        source_cause_id: OptionalEntityId(attacker),
        source_direct_id: OptionalEntityId(None),
        source_position: None,
    })
}
#[tokio::test]
async fn neutral_mobs_require_confirmed_attack_and_players_never_become_combat_targets() {
    let (mut runner, game) = fixture(None);
    mob(&game, azalea::registry::EntityKind::Spider, 20, 2.);
    mob(&game, azalea::registry::EntityKind::Enderman, 21, 2.5);
    mob(&game, azalea::registry::EntityKind::Player, 22, 2.);
    assert!(game.snapshot().hostiles.is_empty());
    game.observe(&damage(1, Some(20)));
    game.observe(&damage(1, Some(21)));
    game.observe(&damage(1, Some(22)));
    let snapshot = game.snapshot();
    assert_eq!(snapshot.hostiles.len(), 2);
    assert!(snapshot.hostiles.iter().all(|e| e.name != "player"));
    assert_eq!(decide(&snapshot, false), Reflex::Defend);
    game.observe(&ClientboundGamePacket::RemoveEntities(
        ClientboundRemoveEntities {
            entity_ids: vec![20, 21],
        },
    ));
    assert!(game.snapshot().hostiles.is_empty());
    runner.shutdown().await;
    // A late observer or status request after teardown must remain harmless.
    assert!(game.snapshot().hostiles.is_empty());
}
#[tokio::test]
async fn only_authorized_teammate_identity_can_trigger_retaliation() {
    let pin = uuid::Uuid::new_v4();
    let (mut runner, game) = fixture(Some(pin));
    mob(&game, azalea::registry::EntityKind::Spider, 20, 2.);
    let player = mob(&game, azalea::registry::EntityKind::Player, 30, 2.);
    game.bot
        .ecs
        .lock()
        .entity_mut(player)
        .insert(GameProfileComponent(GameProfile::new(
            uuid::Uuid::new_v4(),
            "Steve".into(),
        )));
    game.observe(&damage(30, Some(20)));
    assert!(game.snapshot().hostiles.is_empty());
    game.bot
        .ecs
        .lock()
        .entity_mut(player)
        .insert(GameProfileComponent(GameProfile::new(pin, "Steve".into())));
    game.observe(&damage(30, Some(20)));
    assert_eq!(game.snapshot().hostiles.len(), 1);
    game.observed.lock().attackers.clear();
    game.bot
        .ecs
        .lock()
        .entity_mut(player)
        .insert(GameProfileComponent(GameProfile::new(
            pin,
            "Mallory".into(),
        )));
    game.observe(&damage(30, Some(20)));
    assert!(game.snapshot().hostiles.is_empty());
    runner.shutdown().await;
}
#[tokio::test]
async fn retaliation_expires_and_attack_tracking_stays_bounded() {
    let (mut runner, game) = fixture(None);
    mob(&game, azalea::registry::EntityKind::Spider, 20, 2.);
    game.observed
        .lock()
        .attackers
        .insert(20, Instant::now() - Duration::from_secs(1));
    assert!(game.snapshot().hostiles.is_empty());
    for id in 100..200 {
        game.observe(&damage(1, Some(id)));
    }
    assert_eq!(game.observed.lock().attackers.len(), 64);
    game.observe(&damage(999, Some(20)));
    assert!(!game.observed.lock().attackers.contains_key(&20));
    runner.shutdown().await;
}
#[tokio::test]
async fn dangerous_mob_metadata_triggers_retreat_and_refuses_destinations() {
    let (mut runner, game) = fixture(None);
    let enderman = mob(&game, azalea::registry::EntityKind::Enderman, 20, 2.);
    let creaking = mob(&game, azalea::registry::EntityKind::Creaking, 21, 4.);
    game.bot
        .ecs
        .lock()
        .entity_mut(enderman)
        .insert(Creepy(false));
    game.bot
        .ecs
        .lock()
        .entity_mut(creaking)
        .insert(IsActive(false));
    assert!(game.snapshot().avoid_mobs.is_empty());
    game.bot
        .ecs
        .lock()
        .entity_mut(enderman)
        .insert(Creepy(true));
    game.bot
        .ecs
        .lock()
        .entity_mut(creaking)
        .insert(IsActive(true));
    mob(&game, azalea::registry::EntityKind::Warden, 22, 6.);
    let snapshot = game.snapshot();
    assert_eq!(snapshot.avoid_mobs.len(), 3);
    assert!(snapshot.hostiles.is_empty());
    assert_eq!(decide(&snapshot, false), Reflex::Escape);
    assert_eq!(decide(&snapshot, true), Reflex::None);
    assert!(game
        .start_path(
            Point {
                x: 6.,
                y: 64.,
                z: 0.
            },
            1.
        )
        .is_err());
    runner.shutdown().await;
}
#[test]
fn danger_zone_blocks_approach_and_crossing_but_allows_retreat() {
    let zone = ThreatZone {
        position: Point {
            x: 0.,
            y: 64.,
            z: 0.,
        },
        radius: 8.,
    };
    let at = |x| Point { x, y: 64., z: 0. };
    assert!(threat_blocks_step(&zone, at(10.), at(7.)));
    assert!(threat_blocks_step(&zone, at(4.), at(3.)));
    assert!(threat_blocks_step(&zone, at(4.), at(4.)));
    assert!(!threat_blocks_step(&zone, at(4.), at(5.)));
    assert!(!threat_blocks_step(&zone, at(7.), at(9.)));
}
#[test]
fn movement_guard_stops_controls_before_physics_when_path_enters_a_danger_zone() {
    use azalea::{
        app::App,
        core::{position::ChunkPos, tick::GameTick},
        entity::{Jumping, LocalEntity},
        pathfinder::{
            astar::Movement, goals::RadiusGoal, moves::MoveData, ExecutingPath, Pathfinder,
        },
        world::Chunk,
        BlockPos, PhysicsState, WalkDirection,
    };
    use minecraft_companion::minecraft::path_safety::{PathSafetyPlugin, PathThreats};
    use std::collections::VecDeque;
    let mut app = App::new();
    app.add_plugins(PathSafetyPlugin);
    let entity = app.world_mut().spawn_empty().id();
    let instance = Arc::new(parking_lot::RwLock::new(Instance::default()));
    let chunk = Arc::new(parking_lot::RwLock::new(Chunk::default()));
    instance
        .write()
        .chunks
        .map
        .insert(ChunkPos::new(0, 0), Arc::downgrade(&chunk));
    instance.read().chunks.set_block_state(
        &BlockPos::new(1, 63, 0),
        azalea::registry::Block::Stone.into(),
    );
    let target = BlockPos::new(1, 64, 0);
    let path = ExecutingPath {
        path: VecDeque::from([Movement {
            target,
            data: MoveData {
                execute: &|_| {},
                is_reached: &|_| false,
            },
        }]),
        queued_path: None,
        last_reached_node: BlockPos::new(0, 64, 0),
        last_node_reached_at: Instant::now(),
        is_path_partial: false,
    };
    let finder = Pathfinder {
        goal: Some(Arc::new(RadiusGoal {
            pos: Vec3 {
                x: 10.,
                y: 64.,
                z: 0.,
            },
            radius: 1.,
        })),
        ..Default::default()
    };
    let generation = finder.goto_id.clone();
    let controls = PhysicsState {
        move_direction: WalkDirection::Forward,
        trying_to_sprint: true,
        forward_impulse: 1.,
        ..Default::default()
    };
    let mut jumping = Jumping::default();
    *jumping = true;
    app.world_mut().entity_mut(entity).insert((
        LocalEntity,
        InstanceHolder::new(entity, instance),
        path,
        finder,
        controls,
        jumping,
        AzPosition::new(Vec3 {
            x: 0.5,
            y: 64.,
            z: 0.5,
        }),
        PathThreats(vec![ThreatZone {
            position: Point {
                x: 4.,
                y: 64.,
                z: 0.5,
            },
            radius: 8.,
        }]),
    ));
    app.world_mut().run_schedule(GameTick);
    assert!(app.world().get::<ExecutingPath>(entity).is_none());
    assert!(app
        .world()
        .get::<Pathfinder>(entity)
        .unwrap()
        .goal
        .is_none());
    let controls = app.world().get::<PhysicsState>(entity).unwrap();
    assert_eq!(controls.move_direction, WalkDirection::None);
    assert!(!controls.trying_to_sprint);
    assert_eq!(controls.forward_impulse, 0.);
    assert!(!**app.world().get::<Jumping>(entity).unwrap());
    assert_eq!(generation.load(Ordering::SeqCst), 1);
}
#[tokio::test]
async fn late_callbacks_and_actions_after_teardown_return_errors_without_panicking() {
    use minecraft_companion::{actions::Position, mining::DropGoal, world::GameError};
    use tokio_util::sync::CancellationToken;
    let (mut runner, game) = fixture(None);
    runner.shutdown().await;
    assert!(!game.snapshot().spawned);
    assert!(!game.snapshot().connected);
    game.observe(&damage(1, Some(20)));
    assert!(game.block_name(Position { x: 1, y: 64, z: 0 }).is_none());
    assert!(game.blocks(&["oak_log".into()], 8, 10).is_empty());
    let token = CancellationToken::new();
    assert_eq!(game.tick(&token).await, Err(GameError::Disconnected));
    assert_eq!(
        game.equip("iron_pickaxe", &token).await,
        Err(GameError::Disconnected)
    );
    assert_eq!(
        game.dig(Position { x: 1, y: 64, z: 0 }, DropGoal::Break, &token)
            .await,
        Err(GameError::Disconnected)
    );
    assert_eq!(game.eat(None, &token).await, Err(GameError::Disconnected));
    assert_eq!(game.attack(20, &token).await, Err(GameError::Disconnected));
    game.stop();
    game.stop();
    game.drain_reply();
    runner.shutdown().await;
}
#[tokio::test]
async fn cancelled_container_reply_is_closed_and_stale_content_is_cleared() {
    use azalea::ecs::event::Events;
    use azalea::protocol::packets::game::c_open_screen::ClientboundOpenScreen;
    let (mut runner, game) = fixture(None);
    game.observed.lock().windows.insert(1, HashMap::new());
    game.pending_container.store(true, Ordering::Release);
    game.accept_container.store(true, Ordering::Release);
    game.stop();
    game.observe(&ClientboundGamePacket::OpenScreen(ClientboundOpenScreen {
        container_id: 1,
        menu_type: azalea::registry::MenuKind::Generic9x3,
        title: "Chest".into(),
    }));
    assert!(!game.pending_container.load(Ordering::Acquire));
    assert!(!game.observed.lock().windows.contains_key(&1));
    {
        let mut ecs = game.bot.ecs.lock();
        let mut events = ecs.resource_mut::<Events<azalea::inventory::CloseContainerEvent>>();
        assert!(events
            .drain()
            .any(|e| e.entity == game.bot.entity && e.id == 1));
    }
    runner.shutdown().await;
}
