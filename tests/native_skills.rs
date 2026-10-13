use async_trait::async_trait;
use minecraft_companion::{
    actions::{Action, Position},
    config::Config,
    executor::{Scheduler, Work},
    intelligence::{Priority, Reflex},
    memory::Memory,
    mining::DropGoal,
    skills::Skills,
    world::{delay, Block, Entity, Game, GameError, GameResult, Item, Player, Point, Snapshot},
};
use parking_lot::Mutex;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio_util::sync::CancellationToken;

struct MockGame {
    state: Mutex<Snapshot>,
    blocks: Mutex<HashMap<Position, String>>,
    calls: Mutex<Vec<String>>,
    stops: AtomicU32,
    slow: AtomicBool,
    fail: AtomicBool,
}
impl MockGame {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(Snapshot {
                health: 20.,
                hunger: 14,
                connected: true,
                spawned: true,
                dimension: "minecraft:overworld".into(),
                position: Point {
                    x: 0.,
                    y: 64.,
                    z: 0.,
                },
                online: vec![Player {
                    name: "Steve".into(),
                    uuid: uuid::Uuid::new_v4(),
                    position: Some(Point {
                        x: 4.,
                        y: 64.,
                        z: 0.,
                    }),
                }],
                inventory: vec![
                    Item {
                        name: "dirt".into(),
                        count: 64,
                        slot: 9,
                    },
                    Item {
                        name: "bread".into(),
                        count: 4,
                        slot: 10,
                    },
                    Item {
                        name: "iron_pickaxe".into(),
                        count: 1,
                        slot: 11,
                    },
                ],
                ..Default::default()
            }),
            blocks: Mutex::new(HashMap::from([
                (Position { x: 3, y: 64, z: 0 }, "oak_log".into()),
                (Position { x: 4, y: 64, z: 0 }, "oak_log".into()),
                (Position { x: 2, y: 64, z: 2 }, "chest".into()),
            ])),
            calls: Mutex::new(Vec::new()),
            stops: AtomicU32::new(0),
            slow: AtomicBool::new(false),
            fail: AtomicBool::new(false),
        })
    }
    fn record(&self, call: &str) {
        self.calls.lock().push(call.into());
    }
}
#[async_trait]
impl Game for MockGame {
    fn snapshot(&self) -> Snapshot {
        self.state.lock().clone()
    }
    fn stop(&self) {
        self.stops.fetch_add(1, Ordering::SeqCst);
    }
    fn start_path(&self, p: Point, _: f32) -> GameResult<()> {
        self.record("path");
        self.state.lock().position = p;
        Ok(())
    }
    async fn tick(&self, cancel: &CancellationToken) -> GameResult<()> {
        delay(Duration::from_millis(1), cancel).await?;
        if !self.state.lock().connected {
            return Err(GameError::Disconnected);
        }
        Ok(())
    }
    fn blocks(&self, names: &[String], _: u32, _: usize) -> Vec<Block> {
        let state = self.state.lock();
        self.blocks
            .lock()
            .iter()
            .filter(|(_, n)| names.contains(n))
            .map(|(p, n)| Block {
                name: n.clone(),
                position: *p,
                distance: state.position.distance((*p).into()),
            })
            .collect()
    }
    fn block_name(&self, p: Position) -> Option<String> {
        Some(
            self.blocks
                .lock()
                .get(&p)
                .cloned()
                .unwrap_or_else(|| "air".into()),
        )
    }
    fn safe_break(&self, p: Position) -> GameResult<()> {
        if self
            .block_name(p)
            .is_some_and(|n| minecraft_companion::safety::protected(&n))
        {
            Err(GameError::Unsafe("protected".into()))
        } else {
            Ok(())
        }
    }
    fn look(&self, _: Point) {
        self.record("look");
    }
    async fn equip(&self, item: &str, cancel: &CancellationToken) -> GameResult<()> {
        self.tick(cancel).await?;
        if self.state.lock().count(item) == 0 {
            return Err(GameError::Failed("missing item".into()));
        }
        self.record("equip");
        Ok(())
    }
    async fn dig(&self, p: Position, _: DropGoal, cancel: &CancellationToken) -> GameResult<()> {
        self.record("dig_start");
        if self.slow.load(Ordering::Acquire) {
            delay(Duration::from_secs(100), cancel).await?;
        }
        self.tick(cancel).await?;
        if self.fail.load(Ordering::Acquire) {
            return Err(GameError::Failed("block changed or tool broke".into()));
        }
        self.safe_break(p)?;
        self.blocks.lock().remove(&p);
        let mut state = self.state.lock();
        state.drops.push(Entity {
            id: 100 + p.x as u32,
            name: "item".into(),
            position: p.into(),
            distance: 1.,
            health: None,
            item: Some("oak_log".into()),
            count: 1,
        });
        Ok(())
    }
    async fn place(
        &self,
        p: Position,
        name: &str,
        _: Option<&str>,
        cancel: &CancellationToken,
    ) -> GameResult<()> {
        self.tick(cancel).await?;
        if self.block_name(p).as_deref() != Some("air") {
            return Err(GameError::Unsafe("occupied".into()));
        }
        let mut s = self.state.lock();
        let item = s
            .inventory
            .iter_mut()
            .find(|i| i.name == name && i.count > 0)
            .ok_or_else(|| GameError::Failed("missing material".into()))?;
        item.count -= 1;
        self.blocks.lock().insert(p, name.into());
        Ok(())
    }
    async fn drop_items(
        &self,
        name: &str,
        count: u32,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        self.tick(cancel).await?;
        let mut s = self.state.lock();
        let i = s.inventory.iter_mut().find(|i| i.name == name).unwrap();
        let n = count.min(i.count);
        i.count -= n;
        Ok(n)
    }
    async fn transfer(
        &self,
        _: Position,
        name: Option<&str>,
        count: Option<u32>,
        deposit: bool,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        self.tick(cancel).await?;
        if deposit {
            self.drop_items(name.unwrap_or("dirt"), count.unwrap_or(64), cancel)
                .await
        } else {
            let mut s = self.state.lock();
            s.inventory[0].count += count.unwrap_or(1);
            Ok(count.unwrap_or(1))
        }
    }
    async fn eat(&self, _: Option<&str>, cancel: &CancellationToken) -> GameResult<()> {
        self.tick(cancel).await?;
        let mut s = self.state.lock();
        s.hunger = 20;
        s.inventory[1].count -= 1;
        Ok(())
    }
    async fn attack(&self, id: u32, cancel: &CancellationToken) -> GameResult<()> {
        self.tick(cancel).await?;
        let mut s = self.state.lock();
        let e = s
            .hostiles
            .iter_mut()
            .find(|e| e.id == id)
            .ok_or_else(|| GameError::Unsafe("not hostile".into()))?;
        e.health = Some(0.);
        Ok(())
    }
    fn say(&self, _: &str, message: &str) {
        self.record(message);
    }
}
fn skills(game: Arc<MockGame>) -> Arc<Skills> {
    let mut c = Config::from_env(&HashMap::from([
        ("MC_HOST".into(), "localhost".into()),
        ("MC_USERNAME".into(), "RustBot".into()),
        ("MC_AUTH".into(), "offline".into()),
        ("AUTHORIZED_PLAYERS".into(), "Steve".into()),
    ]))
    .unwrap();
    c.allow_containers
        .insert("minecraft:overworld@2,64,2".into());
    Arc::new(Skills {
        game,
        config: Arc::new(c),
        memory: Arc::new(tokio::sync::Mutex::new(Memory::default())),
        progress: Arc::new(Mutex::new(Default::default())),
    })
}
#[tokio::test]
async fn movement_and_local_skills() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let t = CancellationToken::new();
    for a in [
        Action::MoveToPlayer {
            player: "Steve".into(),
            max_distance: None,
        },
        Action::MoveToPosition {
            position: Position { x: 10, y: 64, z: 0 },
            max_distance: None,
        },
        Action::EquipItem {
            item: "iron_pickaxe".into(),
        },
        Action::LookAt {
            position: Position { x: 0, y: 64, z: 0 },
            duration_ms: None,
        },
        Action::Wait { duration_ms: 0 },
        Action::Stop,
        Action::Eat { item: None },
    ] {
        s.execute("Steve", &a, &t).await.unwrap();
    }
    assert_eq!(g.snapshot().hunger, 20);
    assert!(g.stops.load(Ordering::Acquire) > 0);
}
#[tokio::test]
async fn mining_counts_server_removals() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let t = CancellationToken::new();
    assert_eq!(
        s.execute(
            "Steve",
            &Action::MineBlock {
                block_name: "oak_log".into(),
                count: 2
            },
            &t
        )
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        g.calls.lock().iter().filter(|c| *c == "dig_start").count(),
        2
    );
    assert!(s
        .execute(
            "Steve",
            &Action::MineBlock {
                block_name: "oak_log".into(),
                count: 1
            },
            &t
        )
        .await
        .is_err());
}
#[tokio::test]
async fn collect_inventory_target_already_satisfied() {
    let g = MockGame::new();
    g.state.lock().inventory.push(Item {
        name: "oak_log".into(),
        count: 20,
        slot: 12,
    });
    let s = skills(g.clone());
    let t = CancellationToken::new();
    let a = Action::CollectResource {
        resource: "oak logs".into(),
        count: 20,
        from: None,
    };
    assert_eq!(s.execute("Steve", &a, &t).await.unwrap(), 20);
    assert!(!g.calls.lock().iter().any(|c| c == "dig_start"));
}
#[tokio::test]
async fn slow_dig_cancels_without_counting_success() {
    let g = MockGame::new();
    g.slow.store(true, Ordering::Release);
    let s = skills(g.clone());
    let t = CancellationToken::new();
    let cancel = t.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();
    });
    assert_eq!(
        s.execute(
            "Steve",
            &Action::MineBlock {
                block_name: "oak_log".into(),
                count: 2
            },
            &t
        )
        .await,
        Err(GameError::Cancelled)
    );
    assert_eq!(
        g.blocks.lock().values().filter(|n| *n == "oak_log").count(),
        2
    );
}
#[tokio::test]
async fn dig_block_change_and_tool_break_are_failures() {
    let g = MockGame::new();
    g.fail.store(true, Ordering::Release);
    let s = skills(g);
    assert!(s
        .execute(
            "Steve",
            &Action::MineBlock {
                block_name: "oak_log".into(),
                count: 1
            },
            &CancellationToken::new()
        )
        .await
        .is_err());
}
#[tokio::test]
async fn cancelled_follow_holds_when_entity_unloaded() {
    let g = MockGame::new();
    g.state.lock().online[0].position = None;
    let s = skills(g.clone());
    let t = CancellationToken::new();
    let cancel = t.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        cancel.cancel();
    });
    assert_eq!(
        s.execute(
            "Steve",
            &Action::FollowPlayer {
                player: "Steve".into(),
                distance: None
            },
            &t
        )
        .await,
        Err(GameError::Cancelled)
    );
    assert!(g.snapshot().player("Steve").is_some());
    assert!(!g.calls.lock().iter().any(|c| c == "path"));
    assert!(g.stops.load(Ordering::Acquire) > 0);
}
#[tokio::test(start_paused = true)]
async fn dynamic_follow_repaths_and_stops_at_distance() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let t = CancellationToken::new();
    let cancel = t.clone();
    let change = g.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(20)).await;
        change.state.lock().online[0].position = Some(Point {
            x: 20.,
            y: 64.,
            z: 0.,
        });
        tokio::time::sleep(Duration::from_millis(25)).await;
        cancel.cancel();
    });
    assert_eq!(
        s.execute(
            "Steve",
            &Action::FollowPlayer {
                player: "Steve".into(),
                distance: Some(3.)
            },
            &t
        )
        .await,
        Err(GameError::Cancelled)
    );
    assert!(g.calls.lock().iter().filter(|c| *c == "path").count() >= 2);
}
#[tokio::test]
async fn follow_reports_disconnection_separately() {
    let g = MockGame::new();
    g.state.lock().connected = false;
    let s = skills(g);
    assert_eq!(
        s.execute(
            "Steve",
            &Action::FollowPlayer {
                player: "Steve".into(),
                distance: None
            },
            &CancellationToken::new()
        )
        .await,
        Err(GameError::Disconnected)
    );
}
#[tokio::test]
async fn build_and_place_preserve_occupied_blocks() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let t = CancellationToken::new();
    let p = Position {
        x: 10,
        y: 64,
        z: 10,
    };
    s.execute(
        "Steve",
        &Action::PlaceBlock {
            block_name: "dirt".into(),
            position: p,
            face: None,
        },
        &t,
    )
    .await
    .unwrap();
    assert!(s
        .execute(
            "Steve",
            &Action::PlaceBlock {
                block_name: "dirt".into(),
                position: p,
                face: None
            },
            &t
        )
        .await
        .is_err());
    s.execute(
        "Steve",
        &Action::BuildStructure {
            structure: minecraft_companion::actions::Structure::Platform,
            position: p.offset(1, 0, 0),
            dimensions: std::collections::BTreeMap::from([
                ("width".into(), 2),
                ("length".into(), 2),
            ]),
            material: Some("dirt".into()),
        },
        &t,
    )
    .await
    .unwrap();
    assert_eq!(g.snapshot().count("dirt"), 59);
}
#[tokio::test]
async fn drop_deposit_withdraw_counts() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let t = CancellationToken::new();
    assert_eq!(
        s.execute(
            "Steve",
            &Action::DropItem {
                item: "dirt".into(),
                count: Some(2),
                destination: None
            },
            &t
        )
        .await
        .unwrap(),
        2
    );
    assert_eq!(
        s.execute(
            "Steve",
            &Action::DropItem {
                item: "dirt".into(),
                count: Some(3),
                destination: Some("chest".into())
            },
            &t
        )
        .await
        .unwrap(),
        3
    );
    s.execute(
        "Steve",
        &Action::WithdrawItems {
            item: Some("dirt".into()),
            count: Some(5),
            location: None,
        },
        &t,
    )
    .await
    .unwrap();
    assert_eq!(g.snapshot().count("dirt"), 64);
    assert_eq!(
        s.execute(
            "Steve",
            &Action::DepositItems {
                item: Some("dirt".into()),
                location: None
            },
            &t
        )
        .await
        .unwrap(),
        64
    );
}
#[tokio::test]
async fn pickup_does_not_report_unverified_collection() {
    let g = MockGame::new();
    g.state.lock().drops.push(Entity {
        id: 7,
        name: "item".into(),
        position: Point {
            x: 1.,
            y: 64.,
            z: 0.,
        },
        distance: 1.,
        health: None,
        item: Some("dirt".into()),
        count: 1,
    });
    let s = skills(g);
    let t = CancellationToken::new();
    let cancel = t.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(10)).await;
        cancel.cancel();
    });
    assert_eq!(
        s.execute(
            "Steve",
            &Action::PickupItems {
                item: Some("dirt".into()),
                count: Some(1),
                radius: None
            },
            &t
        )
        .await,
        Err(GameError::Cancelled)
    );
}
#[tokio::test]
async fn attack_and_guard_only_hostiles() {
    let g = MockGame::new();
    g.state.lock().hostiles.push(Entity {
        id: 5,
        name: "zombie".into(),
        position: Point {
            x: 1.,
            y: 64.,
            z: 0.,
        },
        distance: 1.,
        health: Some(20.),
        item: None,
        count: 0,
    });
    let s = skills(g);
    let t = CancellationToken::new();
    s.execute(
        "Steve",
        &Action::AttackHostile {
            target: Some("zombie".into()),
            radius: Some(4.),
        },
        &t,
    )
    .await
    .unwrap();
    s.execute(
        "Steve",
        &Action::DefendPlayer {
            player: "Steve".into(),
            radius: Some(8.),
            duration_ms: Some(0),
        },
        &t,
    )
    .await
    .unwrap();
    assert!(s
        .execute(
            "Steve",
            &Action::FollowPlayer {
                player: "Griefer".into(),
                distance: None
            },
            &t
        )
        .await
        .is_err());
}
#[tokio::test]
async fn scheduler_preempts_follow_and_explicit_stop_blocks_reflexes() {
    let g = MockGame::new();
    let s = skills(g.clone());
    let end = CancellationToken::new();
    let scheduler = Scheduler::new(100, end.clone());
    let worker = tokio::spawn(scheduler.clone().run(s));
    scheduler
        .submit(
            "Steve",
            Priority::Instruction,
            Work::Plan(vec![Action::FollowPlayer {
                player: "Steve".into(),
                distance: None,
            }]),
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(15)).await;
    scheduler
        .submit(
            "Steve",
            Priority::Instruction,
            Work::Plan(vec![Action::Wait { duration_ms: 0 }]),
        )
        .unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    assert!(scheduler.status().contains("active=none"));
    scheduler.stop();
    scheduler.stop();
    assert!(scheduler
        .submit("bot", Priority::Emergency, Work::Reflex(Reflex::Escape))
        .is_err());
    end.cancel();
    worker.await.unwrap();
    assert!(g.stops.load(Ordering::Acquire) > 0);
}
