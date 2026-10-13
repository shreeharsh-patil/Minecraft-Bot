use crate::{
    actions::Position,
    config::Config,
    mining::{self, DropGoal, Environment},
    safety::{self, RateLimit},
    world::{self, Game, GameError, GameResult, Point, Snapshot},
};
use async_trait::async_trait;
use azalea::physics::collision::BlockWithShape;
use azalea::{
    blocks::BlockState,
    core::direction::Direction,
    entity::{
        metadata::{Health, ItemItem},
        EntityKind, FluidOnEyes, Physics, Position as AzPosition,
    },
    inventory::{
        operations::{ClickOperation, PickupClick, SwapClick, ThrowClick},
        Inventory, ItemStack, SetSelectedHotbarSlotEvent,
    },
    pathfinder::{
        goals::RadiusGoal, moves, ExecutingPath, GotoEvent, Pathfinder, StopPathfindingEvent,
    },
    prelude::*,
    protocol::packets::{
        game::{
            self,
            s_interact::InteractionHand,
            s_player_action::{Action as DigAction, ServerboundPlayerAction},
            s_use_item::ServerboundUseItem,
            s_use_item_on::{BlockHit, ServerboundUseItemOn},
            ClientboundGamePacket,
        },
        Packet,
    },
    world::{InstanceName, MinecraftEntityId},
    BlockPos, Client, Vec3,
};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

pub fn blockpos(p: Position) -> BlockPos {
    BlockPos::new(p.x, p.y, p.z)
}
pub fn point(p: Vec3) -> Point {
    Point {
        x: p.x,
        y: p.y,
        z: p.z,
    }
}
pub fn vec3(p: Point) -> Vec3 {
    Vec3 {
        x: p.x,
        y: p.y,
        z: p.z,
    }
}
fn item_name(i: azalea::registry::Item) -> String {
    i.to_string().trim_start_matches("minecraft:").into()
}
fn block_name(b: BlockState) -> String {
    azalea::registry::Block::from(b)
        .to_string()
        .trim_start_matches("minecraft:")
        .into()
}
pub fn same_stack(a: &ItemStack, b: &ItemStack) -> bool {
    match (a, b) {
        (ItemStack::Present(a), ItemStack::Present(b)) => a.is_same_item_and_components(b),
        _ => false,
    }
}
pub fn max_stack(stack: &ItemStack) -> u32 {
    crate::items::max_stack(stack)
}
#[derive(Default)]
pub struct Observed {
    pub inventory_revision: u64,
    pub windows: HashMap<i32, HashMap<usize, ItemStack>>,
    pub effects: HashMap<azalea::registry::MobEffect, (u32, Instant)>,
    pub attributes: HashMap<azalea::registry::Attribute, f32>,
    pub last_health: f32,
    pub attackers: HashMap<u32, Instant>,
}
pub struct ScanCache {
    created: Instant,
    position: Position,
    dimension: String,
    radius: u32,
    names: Vec<String>,
    blocks: Vec<world::Block>,
}
pub struct NativeGame {
    pub bot: Client,
    pub config: Arc<Config>,
    pub connected: AtomicBool,
    pub spawned: AtomicBool,
    pub observed: Mutex<Observed>,
    pub digging: Mutex<Option<(Position, Direction)>>,
    pub eating: AtomicBool,
    pub accept_container: AtomicBool,
    pub pending_container: AtomicBool,
    pub scan_cache: Mutex<Option<ScanCache>>,
    pub protected: Mutex<HashSet<(String, Position)>>,
    pub replies: Mutex<VecDeque<String>>,
    pub action_rate: Mutex<RateLimit>,
    pub sequence: AtomicU64,
    pub signing: Mutex<Option<super::signing::SigningSession>>,
}
impl NativeGame {
    pub fn new(bot: Client, config: Arc<Config>) -> Self {
        Self {
            bot,
            action_rate: Mutex::new(RateLimit::new(config.max_actions)),
            config,
            connected: AtomicBool::new(true),
            spawned: AtomicBool::new(false),
            observed: Mutex::new(Observed::default()),
            digging: Mutex::new(None),
            eating: AtomicBool::new(false),
            accept_container: AtomicBool::new(false),
            pending_container: AtomicBool::new(false),
            scan_cache: Mutex::new(None),
            protected: Mutex::new(HashSet::new()),
            replies: Mutex::new(VecDeque::new()),
            sequence: AtomicU64::new(0),
            signing: Mutex::new(None),
        }
    }
    pub fn observe(&self, packet: &ClientboundGamePacket) {
        // These 1.21.4 inventory packets are decoded but not applied by the
        // pinned framework. Apply them before the next gameplay operation.
        match packet {
            ClientboundGamePacket::OpenScreen(p) => {
                self.pending_container.store(false, Ordering::Release);
                if !self.accept_container.load(Ordering::Acquire) {
                    self.close_container(p.container_id);
                }
            }
            ClientboundGamePacket::SetCursorItem(p) => {
                if let Some(mut inventory) =
                    self.bot.ecs.lock().get_mut::<Inventory>(self.bot.entity)
                {
                    inventory.carried = p.contents.clone();
                }
            }
            ClientboundGamePacket::SetPlayerInventory(p) => {
                let slot = if p.slot < 9 {
                    36 + p.slot as usize
                } else {
                    p.slot as usize
                };
                if let Some(mut inventory) =
                    self.bot.ecs.lock().get_mut::<Inventory>(self.bot.entity)
                {
                    if let Some(s) = inventory.inventory_menu.slot_mut(slot) {
                        *s = p.contents.clone();
                    }
                }
            }
            _ => {}
        }
        let my_id = self
            .bot
            .ecs
            .lock()
            .get::<MinecraftEntityId>(self.bot.entity)
            .map(|id| **id)
            .unwrap_or(u32::MAX);
        if let ClientboundGamePacket::PlayerChat(p) = packet {
            if let Some(sig) = &p.signature {
                if let Some(session) = self.signing.lock().as_mut() {
                    session.observe(sig);
                }
            }
        }
        let defended_victim = match packet {
            ClientboundGamePacket::DamageEvent(p) if p.entity_id == my_id => true,
            ClientboundGamePacket::DamageEvent(p) => {
                let mut ecs = self.bot.ecs.lock();
                let mut query = ecs.query::<(
                    &MinecraftEntityId,
                    &azalea::GameProfileComponent,
                    &InstanceName,
                )>();
                let my_dimension = ecs.get::<InstanceName>(self.bot.entity);
                query.iter(&ecs).any(|(id, profile, dimension)| {
                    **id == p.entity_id
                        && Some(dimension) == my_dimension
                        && self
                            .config
                            .authorized
                            .contains(&profile.name.to_ascii_lowercase())
                        && self
                            .config
                            .authorized_uuids
                            .get(&profile.name.to_ascii_lowercase())
                            .is_none_or(|pin| *pin == profile.uuid)
                })
            }
            _ => false,
        };
        let mut o = self.observed.lock();
        match packet {
            ClientboundGamePacket::OpenScreen(_) => {
                o.windows.retain(|id, _| *id == 0);
            }
            ClientboundGamePacket::ContainerSetContent(p) => {
                o.inventory_revision += 1;
                o.windows.retain(|id, _| *id == 0 || *id == p.container_id);
                o.windows.insert(
                    p.container_id,
                    p.items.iter().cloned().enumerate().collect(),
                );
            }
            ClientboundGamePacket::ContainerSetSlot(p) => {
                o.inventory_revision += 1;
                if p.container_id >= 0 || p.container_id == -2 {
                    o.windows
                        .entry(if p.container_id == -2 {
                            0
                        } else {
                            p.container_id
                        })
                        .or_default()
                        .insert(p.slot as usize, p.item_stack.clone());
                }
            }
            ClientboundGamePacket::SetPlayerInventory(p) => {
                o.inventory_revision += 1;
                let slot = if p.slot < 9 {
                    36 + p.slot as usize
                } else {
                    p.slot as usize
                };
                o.windows
                    .entry(0)
                    .or_default()
                    .insert(slot, p.contents.clone());
            }
            ClientboundGamePacket::UpdateMobEffect(p) if p.entity_id == my_id => {
                o.effects.insert(
                    p.mob_effect,
                    (
                        p.effect_amplifier,
                        Instant::now() + Duration::from_millis(p.effect_duration_ticks as u64 * 50),
                    ),
                );
            }
            ClientboundGamePacket::RemoveMobEffect(p) if p.entity_id == my_id => {
                o.effects.remove(&p.effect);
            }
            ClientboundGamePacket::UpdateAttributes(p) if p.entity_id == my_id => {
                for a in &p.values {
                    let mut base = a.base;
                    let mut sum = 0.;
                    let mut mul = 1.;
                    for m in &a.modifiers {
                        use azalea::entity::attributes::AttributeModifierOperation::*;
                        match m.operation {
                            Addition => base += m.amount,
                            MultiplyBase => sum += m.amount,
                            MultiplyTotal => mul *= 1. + m.amount,
                        }
                    }
                    let value = (base * (1. + sum) * mul) as f32;
                    o.attributes.insert(a.attribute, value);
                }
            }
            ClientboundGamePacket::SetHealth(p) => o.last_health = p.health,
            ClientboundGamePacket::DamageEvent(p) if defended_victim => {
                let now = Instant::now();
                o.attackers.retain(|_, deadline| *deadline > now);
                if let Some(attacker) = p.source_cause_id.0.or(p.source_direct_id.0) {
                    if o.attackers.len() >= 64 {
                        if let Some(oldest) = o
                            .attackers
                            .iter()
                            .min_by_key(|(_, deadline)| **deadline)
                            .map(|(id, _)| *id)
                        {
                            o.attackers.remove(&oldest);
                        }
                    }
                    o.attackers.insert(attacker, now + Duration::from_secs(30));
                }
            }
            ClientboundGamePacket::RemoveEntities(p) => {
                for id in &p.entity_ids {
                    o.attackers.remove(id);
                }
            }
            ClientboundGamePacket::Respawn(_) => {
                o.effects.clear();
                o.attributes.clear();
                o.attackers.clear();
            }
            _ => {}
        }
    }
    fn check(&self) -> GameResult<()> {
        if !self.connected.load(Ordering::Acquire) {
            Err(GameError::Disconnected)
        } else if !self.spawned.load(Ordering::Acquire) {
            Err(GameError::Unloaded)
        } else {
            let ecs = self.bot.ecs.lock();
            if ecs.get_entity(self.bot.entity).is_err() {
                return Err(GameError::Disconnected);
            }
            if ecs.get::<azalea::InstanceHolder>(self.bot.entity).is_none()
                || ecs.get::<AzPosition>(self.bot.entity).is_none()
            {
                return Err(GameError::Unloaded);
            }
            Ok(())
        }
    }
    fn rate(&self) -> GameResult<()> {
        if self.action_rate.lock().acquire(Instant::now()) {
            Ok(())
        } else {
            Err(GameError::Unsafe(
                "gameplay action rate limit reached".into(),
            ))
        }
    }
    fn write(&self, p: impl Packet<game::ServerboundGamePacket>) -> GameResult<()> {
        if !self.connected.load(Ordering::Acquire) {
            return Err(GameError::Disconnected);
        }
        self.bot
            .ecs
            .lock()
            .get::<azalea::raw_connection::RawConnection>(self.bot.entity)
            .ok_or(GameError::Disconnected)?
            .write_packet(p)
            .map_err(|_| GameError::Disconnected)
    }
    fn next_sequence(&self) -> u32 {
        let mut ecs = self.bot.ecs.lock();
        if let Some(mut seq) =
            ecs.get_mut::<azalea::interact::CurrentSequenceNumber>(self.bot.entity)
        {
            *seq += 1;
            **seq
        } else {
            self.sequence.fetch_add(1, Ordering::Relaxed) as u32 + 1
        }
    }
    fn dig_packet(&self, p: Position, direction: Direction, action: DigAction) -> GameResult<()> {
        self.write(ServerboundPlayerAction {
            action,
            pos: blockpos(p),
            direction,
            sequence: self.next_sequence(),
        })
    }
    fn inventory(&self) -> Option<Inventory> {
        self.bot
            .ecs
            .lock()
            .get::<Inventory>(self.bot.entity)
            .cloned()
    }
    fn instance(&self) -> Option<Arc<parking_lot::RwLock<azalea::world::Instance>>> {
        self.bot
            .ecs
            .lock()
            .get::<azalea::InstanceHolder>(self.bot.entity)
            .map(|holder| holder.instance.clone())
    }
    fn eye_position(&self) -> GameResult<Vec3> {
        let ecs = self.bot.ecs.lock();
        let position = ecs
            .get::<AzPosition>(self.bot.entity)
            .ok_or(GameError::Unloaded)?;
        let height = ecs
            .get::<azalea::entity::EyeHeight>(self.bot.entity)
            .ok_or(GameError::Unloaded)?;
        Ok((**position).up(**height as f64))
    }
    fn close_container(&self, window: i32) {
        self.accept_container.store(false, Ordering::Release);
        let mut ecs = self.bot.ecs.lock();
        if ecs.get::<Inventory>(self.bot.entity).is_some() {
            ecs.send_event(azalea::inventory::CloseContainerEvent {
                entity: self.bot.entity,
                id: window,
            });
        }
    }
    async fn open_container(&self, p: Position, cancel: &CancellationToken) -> GameResult<i32> {
        self.check()?;
        if cancel.is_cancelled() {
            return Err(GameError::Cancelled);
        }
        if self.pending_container.load(Ordering::Acquire) {
            return Err(GameError::Failed(
                "previous container request has no server reply; wait for it or rejoin manually"
                    .into(),
            ));
        }
        if self.inventory().ok_or(GameError::Unloaded)?.id != 0 {
            return Err(GameError::Failed(
                "close the previous container before opening another".into(),
            ));
        }
        let direction = self.face(p)?;
        let location = self.visible_face(p, direction)?;
        self.accept_container.store(true, Ordering::Release);
        self.pending_container.store(true, Ordering::Release);
        if let Err(e) = self.write(ServerboundUseItemOn {
            hand: InteractionHand::MainHand,
            block_hit: BlockHit {
                block_pos: blockpos(p),
                direction,
                location,
                inside: false,
                world_border: false,
            },
            sequence: self.next_sequence(),
        }) {
            self.pending_container.store(false, Ordering::Release);
            self.accept_container.store(false, Ordering::Release);
            return Err(e);
        }
        let result = async {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                self.tick(cancel).await?;
                let inventory = self.inventory().ok_or(GameError::Unloaded)?;
                if inventory.id != 0 && self.observed.lock().windows.contains_key(&inventory.id) {
                    self.pending_container.store(false, Ordering::Release);
                    return Ok(inventory.id);
                }
                if Instant::now() >= deadline {
                    return Err(GameError::Timeout("server container content".into()));
                }
            }
        }
        .await;
        if result.is_err() {
            self.accept_container.store(false, Ordering::Release);
            if let Some(inventory) = self.inventory().filter(|i| i.id != 0) {
                self.close_container(inventory.id);
            }
        }
        result
    }
    fn stack_in_hand(&self) -> GameResult<ItemStack> {
        self.inventory()
            .map(|i| i.held_item())
            .ok_or(GameError::Unloaded)
    }
    fn env(&self) -> GameResult<Environment> {
        let world = self.instance().ok_or(GameError::Unloaded)?;
        let world = world.read();
        let registry = world
            .registries
            .map
            .get(&azalea::ResourceLocation::new("minecraft:enchantment"));
        let id = |name: &str| {
            registry
                .and_then(|r| r.get_index_of(&azalea::ResourceLocation::new(name)))
                .map(|i| i as u32)
        };
        let mut env = Environment {
            efficiency_id: id("minecraft:efficiency"),
            silk_touch_id: id("minecraft:silk_touch"),
            ..Environment::default()
        };
        let aqua = id("minecraft:aqua_affinity");
        drop(world);
        let ecs = self.bot.ecs.lock();
        env.on_ground = ecs
            .get::<Physics>(self.bot.entity)
            .is_some_and(|p| p.on_ground());
        env.underwater = ecs
            .get::<FluidOnEyes>(self.bot.entity)
            .is_some_and(|p| **p == azalea::blocks::fluid_state::FluidKind::Water);
        if let Some(i) = ecs.get::<Inventory>(self.bot.entity) {
            let slots = i.inventory_menu.slots();
            env.aqua_affinity = slots
                .get(5)
                .is_some_and(|s| mining::enchantment(s, aqua) > 0);
        }
        drop(ecs);
        let o = self.observed.lock();
        let effect = |e| {
            o.effects
                .get(&e)
                .filter(|(_, end)| *end > Instant::now())
                .map(|(a, _)| *a)
        };
        env.haste = effect(azalea::registry::MobEffect::Haste)
            .into_iter()
            .chain(effect(azalea::registry::MobEffect::ConduitPower))
            .max();
        env.fatigue = effect(azalea::registry::MobEffect::MiningFatigue);
        env.submerged_speed = o
            .attributes
            .get(&azalea::registry::Attribute::SubmergedMiningSpeed)
            .copied()
            .unwrap_or(0.2);
        env.mining_efficiency = o
            .attributes
            .get(&azalea::registry::Attribute::MiningEfficiency)
            .copied()
            .unwrap_or(0.);
        env.block_break_speed = o
            .attributes
            .get(&azalea::registry::Attribute::BlockBreakSpeed)
            .copied()
            .unwrap_or(1.);
        Ok(env)
    }
    fn authoritative(
        &self,
        id: i32,
        range: std::ops::RangeInclusive<usize>,
        name: Option<&str>,
    ) -> u32 {
        let o = self.observed.lock();
        o.windows
            .get(&id)
            .map(|slots| {
                range
                    .filter_map(|i| slots.get(&i))
                    .filter(|s| name.is_none_or(|n| item_name(s.kind()) == n))
                    .map(|s| s.count().max(0) as u32)
                    .sum()
            })
            .unwrap_or(0)
    }
    async fn acknowledged(&self, revision: u64, cancel: &CancellationToken) -> GameResult<()> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.tick(cancel).await?;
            if self.observed.lock().inventory_revision > revision {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(GameError::Timeout(
                    "server inventory acknowledgement".into(),
                ));
            }
        }
    }
    async fn click(
        &self,
        window: i32,
        op: impl Into<ClickOperation>,
        cancel: &CancellationToken,
    ) -> GameResult<()> {
        self.check()?;
        if cancel.is_cancelled() {
            return Err(GameError::Cancelled);
        }
        let revision = self.observed.lock().inventory_revision;
        let operation = op.into();
        let inventory = self.inventory().ok_or(GameError::Unloaded)?;
        if inventory.id != window {
            return Err(GameError::Failed("inventory window changed".into()));
        }
        // Disable client prediction. The server sees unchanged remote slots,
        // executes the actual click and sends its resulting slot/cursor changes.
        // Azalea's predictive click event can suppress those echoes on vanilla,
        // so it cannot establish the acknowledgement this transaction requires.
        self.write(game::s_container_click::ServerboundContainerClick {
            container_id: window,
            state_id: inventory.state_id,
            slot_num: operation.slot_num().map(|n| n as i16).unwrap_or(-999),
            button_num: operation.button_num(),
            click_type: operation.click_type(),
            changed_slots: HashMap::new(),
            carried_item: inventory.carried,
        })?;
        self.acknowledged(revision, cancel).await
    }
    async fn equip_slot(&self, slot: usize, cancel: &CancellationToken) -> GameResult<()> {
        let inv = self.inventory().ok_or(GameError::Unloaded)?;
        if inv.id != 0 {
            return Err(GameError::Failed(
                "close the container before equipping".into(),
            ));
        }
        let slots = inv.inventory_menu.slots();
        let expected = slots.get(slot).cloned().ok_or(GameError::Unloaded)?;
        let target = if (36..45).contains(&slot) {
            (slot - 36) as u8
        } else {
            let target = inv.selected_hotbar_slot;
            self.click(
                0,
                SwapClick {
                    source_slot: slot as u16,
                    target_slot: target,
                },
                cancel,
            )
            .await?;
            target
        };
        self.bot.ecs.lock().send_event(SetSelectedHotbarSlotEvent {
            entity: self.bot.entity,
            slot: target,
        });
        self.tick(cancel).await?;
        if self.stack_in_hand()?.kind() != expected.kind() {
            return Err(GameError::Failed(
                "server inventory does not contain the equipped item".into(),
            ));
        }
        Ok(())
    }
    fn block_state(&self, p: Position) -> Option<BlockState> {
        self.instance()?.read().get_block_state(&blockpos(p))
    }
    fn reach(&self, p: Position) -> GameResult<()> {
        let eye = self.eye_position()?;
        let center = blockpos(p).center();
        if point(eye).distance(point(center)) > 4.5 {
            return Err(GameError::Unsafe("target outside interaction reach".into()));
        }
        Ok(())
    }
    fn face(&self, p: Position) -> GameResult<Direction> {
        let eye = self.eye_position()?;
        Ok(Direction::nearest(eye - blockpos(p).center()))
    }
    fn visible_face(&self, p: Position, d: Direction) -> GameResult<Vec3> {
        let location = blockpos(p).center() + d.normal_vec3().scale(0.5);
        // Check the actual ray to the clicked surface using Azalea's collision API.
        let eye = self.eye_position()?;
        let world = self.instance().ok_or(GameError::Unloaded)?;
        let world = world.read();
        let result = azalea::physics::clip::clip(
            &world.chunks,
            azalea::physics::clip::ClipContext {
                from: eye,
                to: location,
                block_shape_type: azalea::physics::clip::BlockShapeType::Outline,
                fluid_pick_type: azalea::physics::clip::FluidPickType::None,
            },
        );
        if !result.miss && result.block_pos != blockpos(p) {
            return Err(GameError::Unsafe(
                "another block obstructs interaction".into(),
            ));
        }
        Ok(location)
    }
    fn scan(&self, names: &[String], radius: u32, limit: usize) -> Vec<world::Block> {
        let snapshot = self.snapshot();
        if !snapshot.connected || !snapshot.spawned {
            return Vec::new();
        }
        let origin = snapshot.position.block();
        if let Some(cache) = &*self.scan_cache.lock() {
            if cache.created.elapsed() < Duration::from_secs(1)
                && cache.position == origin
                && cache.dimension == snapshot.dimension
                && cache.radius == radius
                && cache.names == names
            {
                return cache.blocks.iter().take(limit).cloned().collect();
            }
        }
        let wanted: HashSet<azalea::registry::Block> = names
            .iter()
            .filter_map(|n| format!("minecraft:{n}").parse().ok())
            .collect();
        if wanted.is_empty() {
            return Vec::new();
        }
        let range = radius.min(24) as i32;
        let Some(world) = self.instance() else {
            return Vec::new();
        };
        let world = world.read();
        let mut candidates = Vec::new();
        for x in -range..=range {
            for z in -range..=range {
                for y in -range.min(16)..=range.min(16) {
                    let p = origin.offset(x, y, z);
                    let distance = snapshot.position.distance(p.into());
                    if distance > range as f64 {
                        continue;
                    }
                    if let Some(b) = world.get_block_state(&blockpos(p)) {
                        if wanted.contains(&azalea::registry::Block::from(b)) {
                            candidates.push((p, distance, b));
                        }
                    }
                }
            }
        }
        candidates.sort_by(|a, b| a.1.total_cmp(&b.1));
        let blocks: Vec<_> = candidates
            .into_iter()
            .take(128)
            .map(|(position, distance, b)| world::Block {
                name: block_name(b),
                position,
                distance,
            })
            .collect();
        drop(world);
        *self.scan_cache.lock() = Some(ScanCache {
            created: Instant::now(),
            position: origin,
            dimension: snapshot.dimension,
            radius,
            names: names.to_vec(),
            blocks: blocks.clone(),
        });
        blocks.into_iter().take(limit).collect()
    }
    pub fn drain_reply(&self) {
        {
            let mut s = self.signing.lock();
            if let Some(s) = s.as_mut() {
                if let Some(p) = s.initialize() {
                    let _ = self.write(p);
                }
                if let Some(p) = s.pending_ack() {
                    let _ = self.write(p);
                }
            }
        }
        if let Some(reply) = self.replies.lock().pop_front() {
            let mut session = self.signing.lock();
            if let Some(session) = session.as_mut() {
                if let Some(packet) = session.initialize() {
                    let _ = self.write(packet);
                }
                match session.sign(reply) {
                    Ok(packet) => {
                        let _ = self.write(packet);
                    }
                    Err(_) => {
                        tracing::warn!("signed chat unavailable; manual reauthentication required")
                    }
                }
            } else {
                self.bot.send_chat_packet(&reply);
            }
        }
    }
}
#[async_trait]
impl Game for NativeGame {
    fn snapshot(&self) -> Snapshot {
        let mut s = Snapshot {
            connected: self.connected.load(Ordering::Acquire),
            spawned: self.spawned.load(Ordering::Acquire),
            ..Snapshot::default()
        };
        if !s.spawned {
            return s;
        }
        let attackers: HashSet<_> = self
            .observed
            .lock()
            .attackers
            .iter()
            .filter(|(_, deadline)| **deadline > Instant::now())
            .map(|(id, _)| *id)
            .collect();
        let mut ecs = self.bot.ecs.lock();
        if ecs.get::<AzPosition>(self.bot.entity).is_none()
            || ecs.get::<azalea::InstanceHolder>(self.bot.entity).is_none()
        {
            s.spawned = false;
            s.connected = ecs.get_entity(self.bot.entity).is_ok() && s.connected;
            return s;
        }
        s.position = ecs
            .get::<AzPosition>(self.bot.entity)
            .map(|p| point(**p))
            .unwrap_or_default();
        s.dimension = ecs
            .get::<InstanceName>(self.bot.entity)
            .map(|d| d.to_string())
            .unwrap_or_else(|| "unknown".into());
        s.health = ecs
            .get::<Health>(self.bot.entity)
            .map(|h| **h)
            .unwrap_or(0.);
        s.hunger = ecs
            .get::<azalea::Hunger>(self.bot.entity)
            .map(|h| h.food)
            .unwrap_or(20);
        let self_uuid = ecs
            .get::<azalea::GameProfileComponent>(self.bot.entity)
            .map(|p| p.uuid);
        let tab = ecs
            .get::<azalea::TabList>(self.bot.entity)
            .cloned()
            .unwrap_or_default();
        s.online = tab
            .iter()
            .filter(|(id, _)| Some(**id) != self_uuid)
            .map(|(id, p)| world::Player {
                name: p.profile.name.clone(),
                uuid: *id,
                position: None,
            })
            .collect();
        if let Some(i) = ecs.get::<Inventory>(self.bot.entity) {
            s.inventory = i
                .inventory_menu
                .slots()
                .into_iter()
                .enumerate()
                .filter(|(slot, s)| (9..=44).contains(slot) && s.is_present())
                .map(|(slot, s)| world::Item {
                    name: item_name(s.kind()),
                    count: s.count().max(0) as u32,
                    slot,
                })
                .collect();
        }
        let mut q = ecs.query::<(
            &AzPosition,
            &EntityKind,
            &MinecraftEntityId,
            Option<&azalea::GameProfileComponent>,
            Option<&ItemItem>,
            Option<&Health>,
            &InstanceName,
            Option<&azalea::entity::metadata::Creepy>,
            Option<&azalea::entity::metadata::IsActive>,
        )>();
        for (p, k, id, profile, item, h, d, angry, active) in q.iter(&ecs) {
            if d.to_string() != s.dimension {
                continue;
            }
            let p = point(**p);
            if let Some(profile) = profile {
                if let Some(player) = s.online.iter_mut().find(|p| p.uuid == profile.uuid) {
                    player.position = Some(p);
                }
            }
            let name = k.0.to_string().trim_start_matches("minecraft:").to_string();
            let distance = s.position.distance(p);
            if distance > 64. {
                continue;
            }
            let e = world::Entity {
                id: **id,
                name: name.clone(),
                position: p,
                distance,
                health: h.map(|h| **h),
                item: item.map(|i| item_name(i.kind())),
                count: item.map(|i| i.count().max(0) as u32).unwrap_or(0),
            };
            let alive = e.health.is_none_or(|h| h > 0.);
            if alive
                && safety::avoid_mob(
                    &name,
                    angry.is_some_and(|a| **a),
                    active.is_some_and(|a| **a),
                )
            {
                s.avoid_mobs.push(e.clone());
            }
            if (safety::hostile(&name)
                || safety::reactive_hostile(&name) && attackers.contains(&**id))
                && alive
            {
                s.hostiles.push(e.clone());
            }
            if e.item.is_some() {
                s.drops.push(e);
            }
        }
        s.hostiles.sort_by(|a, b| a.distance.total_cmp(&b.distance));
        s.avoid_mobs
            .sort_by(|a, b| a.distance.total_cmp(&b.distance));
        s.hostiles.truncate(64);
        s.avoid_mobs.truncate(64);
        let zones = s
            .avoid_mobs
            .iter()
            .map(|e| super::path_safety::ThreatZone {
                position: e.position,
                radius: safety::avoid_radius(&e.name),
            })
            .collect();
        if let Ok(mut bot) = ecs.get_entity_mut(self.bot.entity) {
            bot.insert(super::path_safety::PathThreats(zones));
        }
        drop(ecs);
        s.drops.sort_by(|a, b| a.distance.total_cmp(&b.distance));
        s.has_food = s
            .inventory
            .iter()
            .any(|i| safety::FOODS.contains(&i.name.as_str()));
        let p = s.position.block();
        s.in_hazard = [p, p.offset(0, -1, 0)]
            .iter()
            .filter_map(|p| self.block_name(*p))
            .any(|n| safety::dangerous(&n));
        s
    }
    fn stop(&self) {
        self.accept_container.store(false, Ordering::Release);
        if !self.connected.load(Ordering::Acquire) {
            self.digging.lock().take();
            self.eating.store(false, Ordering::Release);
            return;
        }
        let mut ecs = self.bot.ecs.lock();
        if ecs.get_entity(self.bot.entity).is_err() {
            self.connected.store(false, Ordering::Release);
            self.spawned.store(false, Ordering::Release);
            drop(ecs);
            self.digging.lock().take();
            self.eating.store(false, Ordering::Release);
            return;
        }
        if let Some(mut path) = ecs.get_mut::<Pathfinder>(self.bot.entity) {
            path.goal = None;
            path.goto_id.fetch_add(1, Ordering::SeqCst);
        }
        ecs.entity_mut(self.bot.entity).remove::<ExecutingPath>();
        ecs.send_event(StopPathfindingEvent {
            entity: self.bot.entity,
            force: true,
        });
        ecs.send_event(azalea::StartWalkEvent {
            entity: self.bot.entity,
            direction: azalea::WalkDirection::None,
        });
        if let Some(mut j) = ecs.get_mut::<azalea::entity::Jumping>(self.bot.entity) {
            **j = false;
        }
        if let Some(id) = ecs
            .get::<Inventory>(self.bot.entity)
            .map(|inventory| inventory.id)
            .filter(|id| *id != 0)
        {
            ecs.send_event(azalea::inventory::CloseContainerEvent {
                entity: self.bot.entity,
                id,
            });
        }
        drop(ecs);
        let aborted = self.digging.lock().take();
        if let Some((p, d)) = aborted {
            let _ = self.dig_packet(p, d, DigAction::AbortDestroyBlock);
        }
        if self.eating.swap(false, Ordering::AcqRel) {
            let _ = self.dig_packet(
                Position { x: 0, y: 0, z: 0 },
                Direction::Down,
                DigAction::ReleaseUseItem,
            );
        }
    }
    fn start_path(&self, target: Point, distance: f32) -> GameResult<()> {
        self.check()?;
        if !target.x.is_finite() || !target.y.is_finite() || !target.z.is_finite() {
            return Err(GameError::Unsafe("invalid path target".into()));
        }
        if self
            .snapshot()
            .avoid_mobs
            .iter()
            .any(|e| e.position.distance(target) < safety::avoid_radius(&e.name))
        {
            return Err(GameError::Unsafe(
                "path destination is too close to a dangerous mob".into(),
            ));
        }
        self.rate()?;
        self.bot.ecs.lock().send_event(GotoEvent {
            entity: self.bot.entity,
            goal: Arc::new(RadiusGoal {
                pos: vec3(target),
                radius: distance,
            }),
            successors_fn: safe_moves,
            allow_mining: false,
            min_timeout: azalea::pathfinder::astar::PathfinderTimeout::Nodes(10_000),
            max_timeout: azalea::pathfinder::astar::PathfinderTimeout::Nodes(50_000),
        });
        Ok(())
    }
    async fn tick(&self, cancel: &CancellationToken) -> GameResult<()> {
        if cancel.is_cancelled() {
            return Err(GameError::Cancelled);
        }
        self.check()?;
        let mut ticks = self.bot.get_tick_broadcaster();
        tokio::select! {biased;_=cancel.cancelled()=>Err(GameError::Cancelled),r=tokio::time::timeout(Duration::from_secs(2),ticks.recv())=>match r{Ok(Ok(_))=>{self.check()?;Ok(())},_=>Err(GameError::Disconnected)}}
    }
    fn blocks(&self, names: &[String], radius: u32, limit: usize) -> Vec<world::Block> {
        self.scan(names, radius, limit)
    }
    fn block_name(&self, p: Position) -> Option<String> {
        self.block_state(p).map(block_name)
    }
    fn safe_break(&self, p: Position) -> GameResult<()> {
        let s = self.snapshot();
        let name = self.block_name(p).ok_or(GameError::Unloaded)?;
        if safety::protected(&name)
            || safety::dangerous(&name)
            || safety::region_protected(&self.config, &s.dimension, p)
            || self.protected.lock().contains(&(s.dimension.clone(), p))
        {
            return Err(GameError::Unsafe("protected or dangerous block".into()));
        }
        if p == s.position.block().offset(0, -1, 0) {
            return Err(GameError::Unsafe(
                "cannot mine the block supporting the bot".into(),
            ));
        }
        if s.online
            .iter()
            .filter_map(|p| p.position)
            .any(|player| player.distance(p.into()) < 1.5)
        {
            return Err(GameError::Unsafe(
                "player is too close to the mining target".into(),
            ));
        }
        for dx in -3..=3 {
            for dz in -3..=3 {
                if [0, 1]
                    .iter()
                    .filter_map(|dy| self.block_name(p.offset(dx, *dy, dz)))
                    .any(|n| {
                        matches!(
                            n.as_str(),
                            "chest" | "barrel" | "crafting_table" | "furnace" | "torch"
                        )
                    })
                {
                    return Err(GameError::Unsafe(
                        "resource is near a player structure".into(),
                    ));
                }
            }
        }
        for d in [
            Direction::Up,
            Direction::North,
            Direction::South,
            Direction::East,
            Direction::West,
        ] {
            let n = d.normal();
            let neighbor = self
                .block_name(p.offset(n.x, n.y, n.z))
                .ok_or(GameError::Unloaded)?;
            if ["lava", "water", "gravel", "sand"].contains(&neighbor.as_str()) {
                return Err(GameError::Unsafe(
                    "mining could release fluids or falling blocks".into(),
                ));
            }
        }
        Ok(())
    }
    fn look(&self, p: Point) {
        if self.spawned.load(Ordering::Acquire) {
            let mut bot = self.bot.clone();
            bot.look_at(vec3(p));
        }
    }
    async fn equip(&self, name: &str, cancel: &CancellationToken) -> GameResult<()> {
        self.check()?;
        let s = self.snapshot();
        let slot = s
            .inventory
            .iter()
            .find(|i| i.name == name)
            .ok_or_else(|| GameError::Failed(format!("not carrying {name}")))?
            .slot;
        self.equip_slot(slot, cancel).await
    }
    async fn dig(&self, p: Position, goal: DropGoal, cancel: &CancellationToken) -> GameResult<()> {
        self.check()?;
        self.rate()?;
        self.safe_break(p)?;
        self.reach(p)?;
        let state = self.block_state(p).ok_or(GameError::Unloaded)?;
        let inv = self.inventory().ok_or(GameError::Unloaded)?;
        let slots: Vec<_> = inv
            .inventory_menu
            .slots()
            .into_iter()
            .enumerate()
            .filter(|(slot, _)| (9..=44).contains(slot))
            .collect();
        let choice = mining::select_tool(
            state,
            &slots,
            36 + inv.selected_hotbar_slot as usize,
            self.env()?,
            goal,
        )
        .ok_or_else(|| {
            GameError::Failed("no suitable tool with sufficient harvest tier and durability".into())
        })?;
        self.equip_slot(choice.slot, cancel).await?;
        let held = self.stack_in_hand()?;
        let direction = self.face(p)?;
        let location = self.visible_face(p, direction)?;
        self.look(point(location));
        self.tick(cancel).await?;
        let expected = Duration::from_millis(choice.ticks as u64 * 50);
        let deadline = Instant::now() + expected.saturating_mul(3) + Duration::from_secs(10);
        *self.digging.lock() = Some((p, direction));
        self.dig_packet(p, direction, DigAction::StartDestroyBlock)?;
        let result = async {
            let mut progress = 0.;
            let mut sent_finish = false;
            let mut finish_at = None;
            loop {
                self.tick(cancel).await?;
                let current = self.block_state(p).ok_or(GameError::Unloaded)?;
                if current.is_air() {
                    return Ok(());
                }
                if current != state {
                    return Err(GameError::Failed(
                        "target block changed during mining".into(),
                    ));
                }
                if self.stack_in_hand()?.kind() != held.kind() {
                    return Err(GameError::Failed(
                        "held tool changed or broke during mining".into(),
                    ));
                }
                self.safe_break(p)?;
                self.reach(p)?;
                progress += mining::progress_per_tick(state, &self.stack_in_hand()?, self.env()?);
                self.write(game::s_swing::ServerboundSwing {
                    hand: InteractionHand::MainHand,
                })?;
                if progress >= 1. && !sent_finish {
                    self.dig_packet(p, direction, DigAction::StopDestroyBlock)?;
                    sent_finish = true;
                    finish_at = Some(Instant::now());
                }
                if Instant::now() >= deadline
                    || finish_at.is_some_and(|t| t.elapsed() > Duration::from_secs(8))
                {
                    return Err(GameError::Timeout("server block removal".into()));
                }
            }
        }
        .await;
        self.digging.lock().take();
        if result.is_err() {
            let _ = self.dig_packet(p, direction, DigAction::AbortDestroyBlock);
        }
        *self.scan_cache.lock() = None;
        result
    }
    async fn place(
        &self,
        p: Position,
        name: &str,
        face: Option<&str>,
        cancel: &CancellationToken,
    ) -> GameResult<()> {
        self.check()?;
        self.rate()?;
        let s = self.snapshot();
        if self.protected.lock().len() >= 4096 {
            return Err(GameError::Unsafe(
                "placed-block protection capacity reached".into(),
            ));
        }
        if safety::region_protected(&self.config, &s.dimension, p) {
            return Err(GameError::Unsafe("protected build region".into()));
        }
        if self.block_state(p).is_none_or(|b| !b.is_air()) {
            return Err(GameError::Unsafe(
                "placement target must be loaded air".into(),
            ));
        }
        if s.position.block() == p
            || s.online
                .iter()
                .filter_map(|p| p.position)
                .any(|pos| pos.distance(p.into()) < 1.5)
        {
            return Err(GameError::Unsafe("player occupies placement target".into()));
        }
        let directions = match face {
            Some("top") => vec![Direction::Up],
            Some("side") | Some("front") => Direction::HORIZONTAL.to_vec(),
            _ => vec![
                Direction::Up,
                Direction::North,
                Direction::South,
                Direction::East,
                Direction::West,
                Direction::Down,
            ],
        };
        let support = directions
            .into_iter()
            .find_map(|d| {
                let n = d.normal();
                let support = p.offset(-n.x, -n.y, -n.z);
                self.block_state(support)
                    .filter(|b| {
                        b.is_collision_shape_full()
                            && !["chest", "trapped_chest", "barrel", "ender_chest"]
                                .contains(&block_name(*b).as_str())
                            && !safety::dangerous(&block_name(*b))
                    })
                    .map(|_| (support, d))
            })
            .ok_or_else(|| GameError::Failed("no solid support face for placement".into()))?;
        self.reach(support.0)?;
        let location = self.visible_face(support.0, support.1)?;
        self.equip(name, cancel).await?;
        self.look(point(location));
        self.tick(cancel).await?;
        self.write(ServerboundUseItemOn {
            hand: InteractionHand::MainHand,
            block_hit: BlockHit {
                block_pos: blockpos(support.0),
                direction: support.1,
                location,
                inside: false,
                world_border: false,
            },
            sequence: self.next_sequence(),
        })?;
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            self.tick(cancel).await?;
            let actual = self.block_name(p).ok_or(GameError::Unloaded)?;
            if actual == name {
                self.protected.lock().insert((s.dimension, p));
                *self.scan_cache.lock() = None;
                return Ok(());
            }
            if actual != "air" {
                return Err(GameError::Failed("server placed a different block".into()));
            }
            if Instant::now() >= end {
                return Err(GameError::Timeout("server placement confirmation".into()));
            }
        }
    }
    async fn drop_items(
        &self,
        name: &str,
        count: u32,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        self.check()?;
        self.rate()?;
        let mut moved = 0;
        let desired = count.min(self.snapshot().count(name));
        if desired == 0 {
            return Err(GameError::Failed("requested item is not carried".into()));
        }
        while moved < desired {
            let s = self.snapshot();
            let item = s
                .inventory
                .iter()
                .find(|i| i.name == name)
                .ok_or_else(|| GameError::Failed("inventory changed during dropping".into()))?;
            let before = self.authoritative(0, 9..=44, Some(name));
            let n = desired - moved;
            if n >= item.count {
                self.click(
                    0,
                    ThrowClick::All {
                        slot: item.slot as u16,
                    },
                    cancel,
                )
                .await?;
            } else {
                self.click(
                    0,
                    ThrowClick::Single {
                        slot: item.slot as u16,
                    },
                    cancel,
                )
                .await?;
            }
            let after = self.authoritative(0, 9..=44, Some(name));
            let delta = before.saturating_sub(after);
            if delta == 0 {
                return Err(GameError::Failed(
                    "server did not confirm dropped items".into(),
                ));
            }
            moved += delta;
        }
        Ok(moved)
    }
    async fn transfer(
        &self,
        p: Position,
        name: Option<&str>,
        count: Option<u32>,
        deposit: bool,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        self.check()?;
        self.rate()?;
        let dimension = self.snapshot().dimension;
        if !self
            .config
            .allow_containers
            .contains(&safety::container_key(&dimension, p))
        {
            return Err(GameError::Unsafe(
                "container is not explicitly authorized".into(),
            ));
        }
        if self
            .block_name(p)
            .is_none_or(|n| !["chest", "trapped_chest", "barrel"].contains(&n.as_str()))
        {
            return Err(GameError::Failed(
                "location is not a supported container".into(),
            ));
        }
        self.reach(p)?;
        self.look(p.into());
        self.tick(cancel).await?;
        let window = self.open_container(p, cancel).await?;
        let result = async {
            let mut transferred = 0;
            let mut actions = 0;
            loop {
                if cancel.is_cancelled() {
                    return Err(GameError::Cancelled);
                }
                let menu = self
                    .inventory()
                    .filter(|inventory| inventory.id == window)
                    .map(|inventory| inventory.menu().clone())
                    .ok_or_else(|| GameError::Failed("container closed during transfer".into()))?;
                let player_range = menu.player_slots_range();
                let end = *player_range.start() - 1;
                let source_range = if deposit {
                    player_range.clone()
                } else {
                    0..=end
                };
                let dest_range = if deposit {
                    0..=end
                } else {
                    player_range.clone()
                };
                let slots = menu.slots();
                let Some(source) = source_range.clone().find(|i| {
                    slots[*i].is_present() && name.is_none_or(|n| item_name(slots[*i].kind()) == n)
                }) else {
                    break;
                };
                let stack = &slots[source];
                let kind = stack.kind();
                let item = item_name(kind);
                let desired = count
                    .map(|n| n.saturating_sub(transferred))
                    .unwrap_or(u32::MAX);
                if desired == 0 {
                    break;
                }
                let destination = dest_range
                    .clone()
                    .find(|i| {
                        slots[*i].is_present()
                            && slots[*i].kind() == kind
                            && same_stack(&slots[*i], stack)
                            && slots[*i].count() < max_stack(stack) as i32
                    })
                    .or_else(|| dest_range.clone().find(|i| slots[*i].is_empty()));
                let Some(destination) = destination else {
                    break;
                };
                let capacity =
                    max_stack(stack).saturating_sub(slots[destination].count().max(0) as u32);
                let n = (stack.count().max(0) as u32).min(desired).min(capacity);
                let before_source = self.authoritative(window, source_range.clone(), Some(&item));
                let before_destination =
                    self.authoritative(window, dest_range.clone(), Some(&item));
                self.click(
                    window,
                    PickupClick::Left {
                        slot: Some(source as u16),
                    },
                    cancel,
                )
                .await?;
                if n == stack.count() as u32 {
                    self.click(
                        window,
                        PickupClick::Left {
                            slot: Some(destination as u16),
                        },
                        cancel,
                    )
                    .await?;
                } else {
                    for _ in 0..n {
                        self.click(
                            window,
                            PickupClick::Right {
                                slot: Some(destination as u16),
                            },
                            cancel,
                        )
                        .await?;
                    }
                }
                // Return any cursor remainder to its original slot before closing.
                if self.inventory().is_some_and(|i| i.carried.is_present()) {
                    self.click(
                        window,
                        PickupClick::Left {
                            slot: Some(source as u16),
                        },
                        cancel,
                    )
                    .await?;
                }
                let source_after = self.authoritative(window, source_range, Some(&item));
                let dest_after = self.authoritative(window, dest_range, Some(&item));
                let removed = before_source.saturating_sub(source_after);
                let added = dest_after.saturating_sub(before_destination);
                if removed != added || added != n {
                    return Err(GameError::Failed(
                        "inventory transfer did not conserve server-confirmed item counts".into(),
                    ));
                }
                transferred += added;
                actions += 1;
                if actions >= 128 {
                    break;
                }
            }
            if transferred == 0 {
                return Err(GameError::Failed(
                    "no items transferred (missing item or destination full)".into(),
                ));
            }
            if count.is_some_and(|n| transferred < n) {
                return Err(GameError::Failed(format!(
                    "transferred only {transferred}; source empty or destination full"
                )));
            }
            Ok(transferred)
        }
        .await;
        self.close_container(window);
        result
    }
    async fn eat(&self, name: Option<&str>, cancel: &CancellationToken) -> GameResult<()> {
        self.check()?;
        self.rate()?;
        let s = self.snapshot();
        if s.hunger >= 20 {
            return Ok(());
        }
        let food = name
            .filter(|n| safety::FOODS.contains(n))
            .or_else(|| safety::FOODS.iter().copied().find(|n| s.count(n) > 0))
            .ok_or_else(|| GameError::Failed("no safe edible food in inventory".into()))?;
        self.stop();
        self.equip(food, cancel).await?;
        let before = self.snapshot();
        self.eating.store(true, Ordering::Release);
        let look = self
            .bot
            .ecs
            .lock()
            .get::<azalea::entity::LookDirection>(self.bot.entity)
            .copied()
            .unwrap_or_default();
        self.write(ServerboundUseItem {
            hand: InteractionHand::MainHand,
            sequence: self.next_sequence(),
            yaw: look.y_rot,
            pitch: look.x_rot,
        })?;
        let result = async {
            let end = Instant::now() + Duration::from_secs(8);
            loop {
                self.tick(cancel).await?;
                let after = self.snapshot();
                if after.hunger > before.hunger && after.count(food) < before.count(food) {
                    return Ok(());
                }
                if Instant::now() > end {
                    return Err(GameError::Timeout("food consumption".into()));
                }
            }
        }
        .await;
        self.eating.store(false, Ordering::Release);
        let _ = self.dig_packet(
            Position { x: 0, y: 0, z: 0 },
            Direction::Down,
            DigAction::ReleaseUseItem,
        );
        result
    }
    async fn attack(&self, id: u32, cancel: &CancellationToken) -> GameResult<()> {
        self.check()?;
        self.rate()?;
        let end = Instant::now() + Duration::from_secs(5);
        while self
            .bot
            .ecs
            .lock()
            .get::<azalea::attack::AttackStrengthScale>(self.bot.entity)
            .is_some_and(|scale| scale.0 < 1.)
        {
            self.tick(cancel).await?;
            if Instant::now() >= end {
                return Err(GameError::Timeout("weapon cooldown".into()));
            }
        }
        let s = self.snapshot();
        let e = s
            .hostiles
            .iter()
            .find(|e| e.id == id && e.distance <= 3.)
            .ok_or_else(|| {
                GameError::Unsafe("combat target is not a hostile within reach".into())
            })?;
        self.look(e.position);
        self.tick(cancel).await?;
        let mut bot = self.bot.clone();
        bot.attack(MinecraftEntityId(id));
        let end = Instant::now() + Duration::from_secs(3);
        loop {
            self.tick(cancel).await?;
            let now = self.snapshot();
            let target = now.hostiles.iter().find(|e| e.id == id);
            if target.is_none()
                || target.is_some_and(|n| match (e.health, n.health) {
                    (Some(before), Some(after)) => after < before,
                    _ => false,
                })
            {
                return Ok(());
            }
            if Instant::now() >= end {
                return Err(GameError::Failed(
                    "attack sent; server damage could not be verified".into(),
                ));
            }
        }
    }
    fn say(&self, owner: &str, message: &str) {
        let secrets: Vec<_> = self
            .config
            .providers
            .iter()
            .map(|p| p.key.clone())
            .collect();
        let reply = safety::chat_reply(&format!("{owner}: {message}"), &secrets);
        let mut queue = self.replies.lock();
        if queue.len() < 16 && !reply.is_empty() {
            queue.push_back(reply);
        }
    }
}

fn safe_moves(
    ctx: &mut moves::PathfinderCtx,
    node: azalea::pathfinder::rel_block_pos::RelBlockPos,
) {
    let start = ctx.edges.len();
    moves::basic::basic_move(ctx, node);
    // No parkour, bridge placement or unbounded falls. Unloaded blocks are never passable.
    let edges = ctx.edges.split_off(start);
    ctx.edges.extend(edges.into_iter().filter(|e| {
        let p = e.movement.target;
        p.y >= node.y - 3 && ctx.world.is_passable(p) && ctx.world.is_block_solid(p.down(1))
    }));
}
