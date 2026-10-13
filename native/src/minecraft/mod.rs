pub mod game;
pub mod inventory_cleanup;
pub mod lifecycle;
pub mod path_safety;
pub mod signing;
use crate::{
    actions::Action,
    ai::Manager,
    chat::{self, Input},
    config::{Auth, Config, PROTOCOL_VERSION},
    executor::{Scheduler, Work},
    intelligence::{self, Priority, Reflex},
    memory::Memory,
    safety::Authorization,
    skills::Skills,
    world::Game,
};
use azalea::{
    app::App,
    core::tick::GameTick,
    ecs::world::World,
    protocol::{resolver, ServerAddress},
    Account, AccountOpts, Client, Event, StartClientOpts,
};
use game::NativeGame;
use lifecycle::{DisconnectReason, Presence, State};
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, Mutex as AsyncMutex},
    task::JoinSet,
};
use tokio_util::sync::CancellationToken;

pub struct EcsRunner {
    pub world: Arc<Mutex<World>>,
    pub sender: mpsc::UnboundedSender<()>,
    cancel: CancellationToken,
    task: Option<tokio::task::JoinHandle<()>>,
}
impl EcsRunner {
    pub fn new() -> Self {
        let mut app = App::new();
        app.add_plugins(azalea::DefaultPlugins);
        app.add_plugins(azalea::DefaultBotPlugins);
        app.add_plugins(path_safety::PathSafetyPlugin);
        app.add_plugins(inventory_cleanup::InventoryCleanupPlugin);
        app.finish();
        app.cleanup();
        let label = *app.main().update_schedule.as_ref().unwrap();
        let world = Arc::new(Mutex::new(std::mem::take(app.world_mut())));
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let cancel = CancellationToken::new();
        let c = cancel.clone();
        let ecs = world.clone();
        let task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(50));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                let tick = tokio::select! {biased;_=c.cancelled()=>break,_=interval.tick()=>true,r=receiver.recv()=>{if r.is_none(){break;}false}};
                for _ in 0..4096 {
                    if receiver.try_recv().is_err() {
                        break;
                    }
                }
                let mut w = ecs.lock();
                if tick {
                    w.run_schedule(GameTick);
                }
                w.run_schedule(label);
                w.clear_trackers();
            }
        });
        Self {
            world,
            sender,
            cancel,
            task: Some(task),
        }
    }
    pub async fn shutdown(&mut self) {
        self.cancel.cancel();
        if let Some(task) = self.task.take() {
            let _ = task.await;
        }
        self.world.lock().clear_entities();
    }
}
impl Default for EcsRunner {
    fn default() -> Self {
        Self::new()
    }
}
impl Drop for EcsRunner {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

pub async fn authenticate(c: &Config) -> anyhow::Result<Account> {
    if c.auth == Auth::Offline {
        return Ok(Account::offline(&c.username));
    }
    tokio::fs::create_dir_all(&c.auth_cache).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&c.auth_cache, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let cache = c.auth_cache.join("azalea-auth.json");
    if !cache.exists() {
        crate::memory::write_private(&cache, b"[]").await?;
    }
    let cache_key = c.microsoft_email.as_deref().unwrap_or(&c.username);
    let result = azalea::auth::auth(
        cache_key,
        azalea::auth::AuthOpts {
            cache_file: Some(cache.clone()),
            ..Default::default()
        },
    )
    .await
    .map_err(|_| {
        anyhow::anyhow!(
            "Microsoft authentication failed; authenticate manually before trying again"
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(cache, std::fs::Permissions::from_mode(0o600)).await?;
    }
    if !result.profile.name.eq_ignore_ascii_case(&c.username) {
        anyhow::bail!("authenticated account username differs from MC_USERNAME");
    }
    let mut account = Account {
        username: result.profile.name,
        access_token: Some(Arc::new(Mutex::new(result.access_token))),
        uuid: Some(result.profile.id),
        account_opts: AccountOpts::Offline {
            username: c.username.clone(),
        },
        certs: None,
    };
    account
        .request_certs()
        .await
        .map_err(|_| anyhow::anyhow!("failed to fetch Microsoft chat-signing certificates"))?;
    Ok(account)
}
pub async fn connect_with_config(
    account: &Account,
    c: Arc<Config>,
) -> anyhow::Result<(Arc<NativeGame>, mpsc::UnboundedReceiver<Event>, EcsRunner)> {
    let address: ServerAddress = c
        .address()
        .as_str()
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid server address"))?;
    let resolved =
        tokio::time::timeout(c.spawn_timeout, resolver::resolve_address(&address)).await??;
    let mut ecs = EcsRunner::new();
    let result = tokio::time::timeout(
        c.spawn_timeout,
        Client::start_client(StartClientOpts {
            ecs_lock: ecs.world.clone(),
            account,
            address: &address,
            resolved_address: &resolved,
            proxy: None,
            run_schedule_sender: ecs.sender.clone(),
        }),
    )
    .await;
    match result {
        Ok(Ok((bot, events))) => Ok((Arc::new(NativeGame::new(bot, c)), events, ecs)),
        _ => {
            ecs.shutdown().await;
            Err(anyhow::anyhow!(
                "connection handshake failed or timed out; manual activation required"
            ))
        }
    }
}
async fn session(
    c: Arc<Config>,
    account: &Account,
    memory: Arc<AsyncMutex<Memory>>,
    manager: Arc<Manager>,
    shutdown: CancellationToken,
    signals: &mut mpsc::Receiver<Signal>,
) -> anyhow::Result<DisconnectReason> {
    let (game, mut events, mut ecs) = connect_with_config(account, c.clone()).await?;
    if let (Some(uuid), Some(certs)) = (account.uuid, account.certs.clone()) {
        *game.signing.lock() = Some(signing::SigningSession::new(uuid, certs));
    }
    let end = CancellationToken::new();
    let skills = Arc::new(Skills {
        game: game.clone(),
        config: c.clone(),
        memory: memory.clone(),
        progress: Arc::new(Mutex::new(Default::default())),
    });
    let scheduler = Scheduler::new(c.max_actions, end.clone());
    let worker = tokio::spawn(scheduler.clone().run(skills));
    let mut auth = Authorization::new(&c);
    let mut presence = Presence::new(c.human_timeout, Instant::now());
    let mut plans = JoinSet::new();
    let mut planning_cancel = CancellationToken::new();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    let mut replies = tokio::time::interval(Duration::from_millis(450));
    let mut spawned = false;
    let mut last_reflex = Instant::now() - Duration::from_secs(10);
    let spawn_deadline = Instant::now() + c.spawn_timeout;
    tracing::info!(state=?State::Spawned,"waiting for server spawn and chunks");
    let reason = loop {
        tokio::select! {biased;
                    _=shutdown.cancelled()=>break DisconnectReason::Shutdown,
                    signal=signals.recv()=>match signal {Some(Signal::Quit)=>{shutdown.cancel();break DisconnectReason::Shutdown},Some(Signal::Leave)=>break DisconnectReason::Manual,Some(Signal::Stop)=>{scheduler.stop();game.stop();planning_cancel.cancel();planning_cancel=CancellationToken::new();},Some(Signal::Join)|None=>{}},
                    event=events.recv()=>match event {
                        None=>break DisconnectReason::Transient,
                        Some(Event::Disconnect(reason))=>{game.connected.store(false,Ordering::Release);let reason=reason.map(|r|r.to_string());break lifecycle::classify_disconnect(reason.as_deref());},
                        Some(Event::Packet(p))=> {game.observe(&p);},
                        Some(Event::Death(_))=>{scheduler.stop();game.stop();planning_cancel.cancel();planning_cancel=CancellationToken::new();memory.lock().await.failure("death: tasks cancelled; respawn handled by Azalea");},
                        Some(Event::Chat(chat)) if spawned=>{
                            // Only protocol PlayerChat carries a trustworthy sender UUID. System and
                            // disguised chat text cannot impersonate a trusted player.
                            let Some(uuid)=chat.uuid()else{continue;};let snapshot=game.snapshot();let Some(sender)=snapshot.online.iter().find(|p|p.uuid==uuid)else{continue;};let owner=sender.name.clone();let text=chat.content();
                            let parsed=chat::parse(&text,&c.prefix,&owner);let stop=matches!(&parsed,Ok(Input::Action(Action::Stop)));
                            if !auth.command(&owner,Some(uuid),stop,Instant::now()){continue;}
                            match parsed {
                                Ok(Input::Action(Action::Stop))=>{scheduler.stop();game.stop();planning_cancel.cancel();planning_cancel=CancellationToken::new();game.say(&owner,"Stopped.");},
                                Ok(Input::Action(action))=>{if let Err(e)=scheduler.submit(&owner,Priority::Instruction,Work::Plan(vec![action])){game.say(&owner,&e.to_string());}},
                                Ok(Input::Local{name,args})=>{
                                    match name.as_str(){
                                        "help"=>game.say(&owner,chat::HELP),
                                        "status"=>{let p=game.snapshot();game.say(&owner,&format!("{}; health={}, hunger={}, AI providers={}",scheduler.status(),p.health,p.hunger,manager.count()));},
                                        "inventory"=>{let inventory=game.snapshot().inventory;let reply=inventory.iter().map(|i|format!("{}:{}",i.name,i.count)).collect::<Vec<_>>().join(", ");game.say(&owner,if reply.is_empty(){"Inventory is empty."}else{&reply});},
                                        "remember"=>{let name=args.first().map(|s|s.to_ascii_lowercase()).unwrap_or_default();let s=game.snapshot();let mut m=memory.lock().await;match m.remember_point(&name,s.position,&s.dimension){Ok(())=>{if m.persist().await.is_ok(){game.say(&owner,"Location remembered.");}else{game.say(&owner,"Location remembered for this session; persistence failed.");}},Err(e)=>game.say(&owner,&e)}},
                                        "home"=>{let m=memory.lock().await;match m.location("home",&game.snapshot().dimension){Ok(l)=>{if let Err(e)=scheduler.submit(&owner,Priority::Instruction,Work::Plan(vec![Action::MoveToPosition{position:l.position.block(),max_distance:None}])){game.say(&owner,&e.to_string());}},Err(e)=>game.say(&owner,&e)}},
                                        _=>{},
                                    }
                                },
                                Ok(Input::Natural(text))=>{if crate::safety::sensitive(&text){game.say(&owner,"I can help with gameplay; that request is refused.");continue;}
        if plans.len()>=c.ai_concurrency{game.say(&owner,"AI is busy; deterministic commands remain available.");continue;}let snapshot=game.snapshot();let mut m=memory.lock().await;m.conversation(&owner,&text);let mut context=snapshot.context();if let Some(fields)=m.context().as_object(){for (key,value) in fields{context[key]=value.clone();}}drop(m);let manager=manager.clone();let scheduler=scheduler.clone();let game=game.clone();let token=planning_cancel.child_token();plans.spawn(async move {match manager.plan(&text,&owner,context,&token).await{Ok(actions) if !token.is_cancelled()=>{if let Err(e)=scheduler.submit(&owner,Priority::Instruction,Work::Plan(actions)){game.say(&owner,&e.to_string());}},Err(e) if e.kind!=crate::ai::ErrorKind::Cancelled=>game.say(&owner,"AI unavailable or invalid plan; use !help for local commands."),_=>{}}});},
                                Ok(Input::Empty)=>{},Err(e)=>game.say(&owner,&e),
                            }
                        },
                        _=>{},
                    },
                    _=replies.tick(),if spawned=>game.drain_reply(),
                    _=heartbeat.tick()=>{
                        if !spawned{let ready={let w=game.bot.ecs.lock();w.get::<azalea::entity::InLoadedChunk>(game.bot.entity).is_some() && w.get::<azalea::inventory::Inventory>(game.bot.entity).is_some()};if ready{spawned=true;game.spawned.store(true,Ordering::Release);tracing::info!(state=?State::Active,"spawn verified");}else if Instant::now()>spawn_deadline{break DisconnectReason::SpawnTimeout;}}
                        if spawned {let s=game.snapshot();let online=s.online.iter().filter(|p|auth.identity(&p.name,Some(p.uuid))).map(|p|p.uuid).collect();if c.server_tab_trusted{presence.reconcile(online,Instant::now());}
        if presence.expired(Instant::now()){break DisconnectReason::NoHumans;}
                            if last_reflex.elapsed()>=Duration::from_secs(3){let reflex=intelligence::decide(&s,scheduler.stopped());if reflex!=Reflex::None {let priority=if reflex==Reflex::Escape{Priority::Emergency}else{Priority::Defense};let _=scheduler.submit(&c.username,priority,Work::Reflex(reflex));last_reflex=Instant::now();}}
                        }
                    },
                    _=plans.join_next(),if !plans.is_empty()=>{},
                }
    };
    tracing::info!(state=?State::Leaving,reason=?reason,"ending gameplay session");
    planning_cancel.cancel();
    plans.abort_all();
    while plans.join_next().await.is_some() {}
    end.cancel();
    scheduler.stop();
    game.stop();
    let _ = worker.await;
    game.bot.disconnect();
    // Give the disconnect event one scheduler turn, then drop network tasks and ECS.
    tokio::time::sleep(Duration::from_millis(100)).await;
    game.connected.store(false, Ordering::Release);
    ecs.shutdown().await;
    memory.lock().await.persist().await?;
    Ok(reason)
}
#[derive(Debug)]
enum Signal {
    Join,
    Leave,
    Stop,
    Quit,
}
fn console(tx: mpsc::Sender<Signal>) -> std::io::Result<std::thread::JoinHandle<()>> {
    // Tokio stdin uses an uncancellable blocking-pool read; aborting its task
    // can hang runtime shutdown until another line/EOF arrives. A dedicated
    // input thread is independent of runtime teardown. It exits on explicit quit;
    // a blocked reader on signal shutdown is released by normal process exit.
    std::thread::Builder::new()
        .name("console-input".into())
        .spawn(move || {
            use std::io::{BufRead, Read};
            let stdin = std::io::stdin();
            let mut input = stdin.lock();
            let mut line = Vec::with_capacity(129);
            loop {
                line.clear();
                match (&mut input).take(129).read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    _ => {}
                }
                if line.len() > 128 {
                    if line.last() != Some(&b'\n') && input.skip_until(b'\n').is_err() {
                        break;
                    }
                    continue;
                }
                let Ok(text) = std::str::from_utf8(&line) else {
                    continue;
                };
                let signal = match text.trim() {
                    "join" => Signal::Join,
                    "leave" => Signal::Leave,
                    "stop" => Signal::Stop,
                    "quit" => Signal::Quit,
                    _ => continue,
                };
                let quit = matches!(signal, Signal::Quit);
                if tx.blocking_send(signal).is_err() || quit {
                    break;
                }
            }
        })
}
pub async fn run() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--help") {
        println!("minecraft-companion [--connect] [--check-config] [--ping] [--activation-file PATH]\nOffline conversion: --import-memory LEGACY_FILE --memory-output NEW_FILE --memory-dimension minecraft:overworld\nDefault: wait for local console 'join'; 'leave', 'stop', 'quit' control the supervisor.\nOnly Minecraft Java 1.21.4 / protocol 769 is supported.");
        return Ok(());
    }
    if args.iter().any(|a| a == "--import-memory") {
        let value = |flag: &str| -> anyhow::Result<&str> {
            args.iter()
                .position(|a| a == flag)
                .and_then(|i| args.get(i + 1))
                .filter(|v| !v.starts_with("--"))
                .map(String::as_str)
                .ok_or_else(|| anyhow::anyhow!("missing value for {flag}"))
        };
        let source = PathBuf::from(value("--import-memory")?);
        let destination = PathBuf::from(value("--memory-output")?);
        let report =
            crate::memory::import_legacy(&source, &destination, value("--memory-dimension")?)
                .await?;
        println!("Imported {} locations, {} preferences, {} useful coordinates and {} remembered players into a new file. Set MEMORY_FILE to that file. Command authorization still uses AUTHORIZED_PLAYERS.", report.locations, report.preferences, report.coordinates, report.trusted_players);
        return Ok(());
    }
    let c = Arc::new(Config::load().map_err(anyhow::Error::msg)?);
    let level = if c.log_level == "silent" {
        "off"
    } else {
        c.log_level.as_str()
    };
    // Upstream auth debug/trace logs include access tokens. Never enable them,
    // even when the owner requests application debug logging.
    let filter = tracing_subscriber::EnvFilter::new(format!(
        "warn,minecraft_companion={level},azalea_auth=off,reqwest=off,azalea_protocol=warn"
    ));
    if c.log_format == "json" {
        tracing_subscriber::fmt()
            .with_env_filter(filter)
            .json()
            .init();
    } else {
        tracing_subscriber::fmt().with_env_filter(filter).init();
    }
    if args.iter().any(|a| a == "--check-config") {
        println!(
            "Configuration valid; Minecraft 1.21.4 / protocol 769; AI providers={}",
            c.providers.len()
        );
        return Ok(());
    }
    if args.iter().any(|a| a == "--ping") {
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            azalea::ping::ping_server(c.address().as_str()),
        )
        .await??;
        println!(
            "server={}, protocol={}, player count={} (sample is not a complete roster)",
            status.version.name, status.version.protocol, status.players.online
        );
        if status.version.protocol != PROTOCOL_VERSION {
            anyhow::bail!("server protocol incompatible with this executable");
        }
        return Ok(());
    }
    let activation_file = args
        .iter()
        .position(|a| a == "--activation-file")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from);
    let shutdown = CancellationToken::new();
    let global = shutdown.clone();
    let ctrl = tokio::spawn(async move {
        #[cfg(unix)]
        {
            if let Ok(mut terminate) =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            {
                tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
            } else {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
        #[cfg(not(unix))]
        {
            let _ = tokio::signal::ctrl_c().await;
        }
        global.cancel();
    });
    let (tx, mut rx) = mpsc::channel(8);
    let console_thread = console(tx.clone())?;
    let memory = Arc::new(AsyncMutex::new(Memory::load(c.memory_file.clone()).await));
    let manager = Arc::new(Manager::new(&c)?);
    let mut activate = args.iter().any(|a| a == "--connect");
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_activation = None;
    tracing::info!(state=?State::Waiting,"use local console 'join' after an authorized real player joins the running server");
    while !shutdown.is_cancelled() {
        if !activate {
            tokio::select! {_=shutdown.cancelled()=>break,signal=rx.recv()=>match signal{Some(Signal::Join)=>activate=true,Some(Signal::Quit)=>break,_=>{}},_=interval.tick()=>{if let Some(path)=&activation_file {if let Some(lease)=lifecycle::read_activation(path,&c).await{if Some(lease.session_id)!=last_activation{last_activation=Some(lease.session_id);activate=true;}}}}}
            if !activate {
                continue;
            }
        }
        activate = false;
        if let Some(path) = &activation_file {
            if let Some(lease) = lifecycle::read_activation(path, &c).await {
                last_activation = Some(lease.session_id);
            }
        }
        tracing::info!(state=?State::Connecting,"checking protocol before joining");
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            azalea::ping::ping_server(c.address().as_str()),
        )
        .await;
        if !matches!(status,Ok(Ok(ref s)) if s.version.protocol==PROTOCOL_VERSION) {
            tracing::warn!(state=?State::Error,"server offline or incompatible; return to manual waiting");
            continue;
        }
        tracing::info!(state=?State::Authenticating,"authenticating account");
        let account = tokio::select! {_=shutdown.cancelled()=>break,result=authenticate(&c)=>match result{Ok(a)=>a,Err(_)=>{tracing::error!(state=?State::Error,"authentication failed; retry only after manual activation");continue;}}};
        let mut attempts = 0;
        loop {
            let result = session(
                c.clone(),
                &account,
                memory.clone(),
                manager.clone(),
                shutdown.clone(),
                &mut rx,
            )
            .await;
            if shutdown.is_cancelled() {
                break;
            }
            let transient = matches!(result, Ok(DisconnectReason::Transient));
            // Reconnection needs a CURRENT, explicitly supplied external presence lease.
            // A previous tab list or incomplete ping sample is not evidence of presence.
            let lease = if let Some(path) = &activation_file {
                lifecycle::read_activation(path, &c).await
            } else {
                None
            };
            if !transient || lease.is_none() || attempts >= c.reconnect_attempts {
                break;
            }
            attempts += 1;
            tracing::info!(state=?State::Cooldown,attempts,"bounded transient gameplay recovery");
            tokio::select! {_=shutdown.cancelled()=>break,_=tokio::time::sleep(c.reconnect_delay.saturating_mul(1u32<<attempts.min(4)))=>{}}
            let status = tokio::time::timeout(
                Duration::from_secs(5),
                azalea::ping::ping_server(c.address().as_str()),
            )
            .await;
            if !matches!(status,Ok(Ok(ref s)) if s.version.protocol==PROTOCOL_VERSION) {
                break;
            }
            if let Some(path) = &activation_file {
                if lifecycle::read_activation(path, &c).await.is_none() {
                    break;
                }
            }
        }
        tracing::info!(state=?State::Waiting,"session ended; waiting for a fresh authorized activation");
    }
    shutdown.cancel();
    if console_thread.is_finished() {
        let _ = console_thread.join();
    }
    ctrl.abort();
    memory.lock().await.persist().await?;
    tracing::info!(state=?State::Stopped,"supervisor stopped");
    Ok(())
}
