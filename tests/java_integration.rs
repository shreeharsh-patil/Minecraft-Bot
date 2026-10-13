//! Opt-in tests against a disposable, locally owned Java 1.21.4 server.
//! The owner must accept its EULA. Never point these tests at Aternos or a real world.
use minecraft_companion::{
    actions::{Action, Position},
    config::Config,
    memory::Memory,
    minecraft::{self, game::NativeGame, EcsRunner},
    skills::Skills,
    world::{Game, GameError},
};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tokio_util::sync::CancellationToken;

struct Fixture {
    game: Arc<NativeGame>,
    ecs: EcsRunner,
    observe: tokio::task::JoinHandle<()>,
    end: CancellationToken,
}
impl Fixture {
    async fn new() -> Self {
        assert_eq!(
            std::env::var("MC_TEST_DISPOSABLE").as_deref(),
            Ok("yes"),
            "test server must be explicitly marked disposable"
        );
        let port = std::env::var("MC_TEST_PORT").unwrap_or_else(|_| "25575".into());
        let config = Arc::new(
            Config::from_env(&HashMap::from([
                ("MC_HOST".into(), "127.0.0.1".into()),
                ("MC_PORT".into(), port),
                ("MC_USERNAME".into(), "RustTestBot".into()),
                ("MC_AUTH".into(), "offline".into()),
                ("AUTHORIZED_PLAYERS".into(), "TestPlayer".into()),
                (
                    "AUTHORIZED_CONTAINERS".into(),
                    "minecraft:overworld@3,64,3".into(),
                ),
                ("MAX_ACTIONS_PER_MINUTE".into(), "0".into()),
            ]))
            .unwrap(),
        );
        let (game, mut events, ecs) =
            minecraft::connect_with_config(&azalea::Account::offline("RustTestBot"), config)
                .await
                .unwrap();
        let end = CancellationToken::new();
        let stop = end.clone();
        let g = game.clone();
        let observe = tokio::spawn(async move {
            loop {
                tokio::select! {_=stop.cancelled()=>break,event=events.recv()=>match event{Some(azalea::Event::Packet(p))=>g.observe(&p),Some(azalea::Event::Disconnect(_))|None=>{g.connected.store(false,Ordering::Release);break;},_=>{}}}
            }
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let ready = {
                let w = game.bot.ecs.lock();
                w.get::<azalea::entity::InLoadedChunk>(game.bot.entity)
                    .is_some()
            };
            if ready {
                game.spawned.store(true, Ordering::Release);
                break;
            }
            assert!(Instant::now() < deadline, "spawn timeout");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Self {
            game,
            ecs,
            observe,
            end,
        }
    }
    fn skills(&self) -> Skills {
        Skills {
            game: self.game.clone(),
            config: self.game.config.clone(),
            memory: Arc::new(tokio::sync::Mutex::new(Memory::default())),
            progress: Arc::new(parking_lot::Mutex::new(Default::default())),
        }
    }
    async fn close(mut self) {
        self.game.stop();
        self.game.bot.disconnect();
        tokio::time::sleep(Duration::from_millis(200)).await;
        self.end.cancel();
        self.observe.await.unwrap();
        self.ecs.shutdown().await;
        self.ecs.shutdown().await;
    }
}
async fn rcon(command: &str) -> String {
    let port = std::env::var("MC_TEST_RCON_PORT").unwrap_or_else(|_| "25576".into());
    let password =
        std::env::var("MC_TEST_RCON_PASSWORD").expect("MC_TEST_RCON_PASSWORD must be set");
    let mut tcp = TcpStream::connect(format!("127.0.0.1:{port}"))
        .await
        .unwrap();
    async fn send(tcp: &mut TcpStream, id: i32, kind: i32, body: &str) {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(body.len() as i32 + 10).to_le_bytes());
        bytes.extend_from_slice(&id.to_le_bytes());
        bytes.extend_from_slice(&kind.to_le_bytes());
        bytes.extend_from_slice(body.as_bytes());
        bytes.extend_from_slice(&[0, 0]);
        tcp.write_all(&bytes).await.unwrap();
    }
    async fn read(tcp: &mut TcpStream) -> (i32, i32, String) {
        let size = tcp.read_i32_le().await.unwrap();
        assert!((10..=65536).contains(&size));
        let mut bytes = vec![0; size as usize];
        tcp.read_exact(&mut bytes).await.unwrap();
        let id = i32::from_le_bytes(bytes[..4].try_into().unwrap());
        (
            id,
            i32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            String::from_utf8_lossy(&bytes[8..bytes.len() - 2]).into_owned(),
        )
    }
    send(&mut tcp, 1, 3, &password).await;
    loop {
        let auth = tokio::time::timeout(Duration::from_secs(5), read(&mut tcp))
            .await
            .unwrap();
        assert_ne!(auth.0, -1, "RCON authentication failed");
        if auth.0 == 1 && auth.1 == 2 {
            break;
        }
    }
    send(&mut tcp, 2, 2, command).await;
    let response = tokio::time::timeout(Duration::from_secs(5), read(&mut tcp))
        .await
        .unwrap();
    assert_eq!(response.0, 2);
    response.2
}
async fn setup(f: &Fixture) {
    for cmd in [
        "fill -16 63 -16 32 63 32 stone",
        "fill -16 64 -16 32 76 32 air",
        "tp RustTestBot 0.5 64 0.5",
        "gamemode survival RustTestBot",
        "clear RustTestBot",
        "give RustTestBot minecraft:diamond_pickaxe",
        "give RustTestBot minecraft:iron_axe",
        "give RustTestBot minecraft:dirt 64",
        "give RustTestBot minecraft:bread 8",
    ] {
        let _ = rcon(cmd).await;
    }
    tokio::time::sleep(Duration::from_secs(1)).await;
    assert!(f.game.snapshot().count("diamond_pickaxe") > 0);
}
#[tokio::test]
#[ignore = "requires explicitly accepted EULA and a disposable local Java 1.21.4 server"]
async fn real_protocol_spawn_movement_mining_inventory_building_and_cancellation() {
    let fixture = Fixture::new().await;
    setup(&fixture).await;
    let skills = fixture.skills();
    let token = CancellationToken::new();
    skills
        .execute(
            "TestPlayer",
            &Action::MoveToPosition {
                position: Position { x: 6, y: 64, z: 0 },
                max_distance: Some(1.),
            },
            &token,
        )
        .await
        .unwrap();
    assert!(fixture.game.snapshot().position.x > 4.);
    let _ = rcon("tp RustTestBot 0.5 64 0.5").await;
    let _ = rcon("setblock 3 64 0 oak_log").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    skills
        .execute(
            "TestPlayer",
            &Action::MineBlock {
                block_name: "oak_log".into(),
                count: 1,
            },
            &token,
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .game
            .block_name(Position { x: 3, y: 64, z: 0 })
            .as_deref(),
        Some("air")
    );
    skills
        .execute(
            "TestPlayer",
            &Action::EquipItem {
                item: "dirt".into(),
            },
            &token,
        )
        .await
        .unwrap();
    skills
        .execute(
            "TestPlayer",
            &Action::PlaceBlock {
                block_name: "dirt".into(),
                position: Position { x: 2, y: 64, z: 0 },
                face: Some("top".into()),
            },
            &token,
        )
        .await
        .unwrap();
    assert_eq!(
        fixture
            .game
            .block_name(Position { x: 2, y: 64, z: 0 })
            .as_deref(),
        Some("dirt")
    );
    let _ = rcon("setblock 3 64 3 chest").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let before = fixture.game.snapshot().count("dirt");
    skills
        .execute(
            "TestPlayer",
            &Action::DropItem {
                item: "dirt".into(),
                count: Some(2),
                destination: None,
            },
            &token,
        )
        .await
        .unwrap();
    assert_eq!(fixture.game.snapshot().count("dirt"), before - 2);
    skills
        .execute(
            "TestPlayer",
            &Action::DepositItems {
                item: Some("dirt".into()),
                location: None,
            },
            &token,
        )
        .await
        .unwrap();
    assert_eq!(fixture.game.snapshot().count("dirt"), 0);
    skills
        .execute(
            "TestPlayer",
            &Action::WithdrawItems {
                item: Some("dirt".into()),
                count: Some(3),
                location: None,
            },
            &token,
        )
        .await
        .unwrap();
    assert_eq!(fixture.game.snapshot().count("dirt"), 3);
    let _ = rcon("setblock 3 64 3 air").await;
    let _ = rcon("setblock 3 64 0 obsidian").await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let cancel = CancellationToken::new();
    let c = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        c.cancel();
    });
    let result = skills
        .execute(
            "TestPlayer",
            &Action::MineBlock {
                block_name: "obsidian".into(),
                count: 1,
            },
            &cancel,
        )
        .await;
    assert!(matches!(result, Err(GameError::Cancelled)));
    fixture.game.stop();
    assert_eq!(
        fixture
            .game
            .block_name(Position { x: 3, y: 64, z: 0 })
            .as_deref(),
        Some("obsidian")
    );
    fixture.close().await;
}
