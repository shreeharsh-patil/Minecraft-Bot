use crate::{
    actions::{build_plan, Action, Position},
    config::Config,
    memory::Memory,
    mining::{self, DropGoal},
    safety,
    world::{delay, Game, GameError, GameResult, Point},
};
use parking_lot::Mutex;
use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default, Clone)]
pub struct Progress {
    pub action: String,
    pub current: u32,
    pub total: Option<u32>,
}
pub struct Skills {
    pub game: Arc<dyn Game>,
    pub config: Arc<Config>,
    pub memory: Arc<tokio::sync::Mutex<Memory>>,
    pub progress: Arc<Mutex<Progress>>,
}
impl Skills {
    fn report(&self, owner: &str, current: u32, total: Option<u32>) {
        let mut p = self.progress.lock();
        p.current = current;
        p.total = total;
        if current > 0 && (current % 5 == 0 || Some(current) == total) {
            self.game.say(
                owner,
                &format!(
                    "{}: {current}/{}",
                    p.action,
                    total
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "ongoing".into())
                ),
            );
        }
    }
    pub async fn execute(
        &self,
        owner: &str,
        action: &Action,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        action
            .validate(self.config.max_mine, self.config.max_build)
            .map_err(GameError::Unsafe)?;
        if cancel.is_cancelled() {
            return Err(GameError::Cancelled);
        }
        *self.progress.lock() = Progress {
            action: action.name().into(),
            ..Progress::default()
        };
        match action {
            Action::Stop => {
                self.game.stop();
                Ok(0)
            }
            Action::MoveToPosition {
                position,
                max_distance,
            } => {
                self.navigate((*position).into(), max_distance.unwrap_or(1.5), cancel)
                    .await?;
                Ok(1)
            }
            Action::MoveToPlayer {
                player,
                max_distance,
            } => {
                self.player_target(player)?;
                let p = self
                    .game
                    .snapshot()
                    .player(player)
                    .and_then(|p| p.position)
                    .ok_or(GameError::Unloaded)?;
                self.navigate(p, max_distance.unwrap_or(2.5), cancel)
                    .await?;
                Ok(1)
            }
            Action::FollowPlayer { player, distance } => {
                self.player_target(player)?;
                self.follow(
                    player,
                    distance.unwrap_or(self.config.follow_distance),
                    cancel,
                    None,
                )
                .await
            }
            Action::MineBlock { block_name, count } => {
                self.gather(owner, &[block_name.clone()], None, *count, cancel)
                    .await
            }
            Action::CollectResource {
                resource,
                count,
                from,
            } => {
                if let Some(name) = from {
                    let m = self.memory.lock().await;
                    let l = m
                        .location(name, &self.game.snapshot().dimension)
                        .map_err(GameError::Unsafe)?;
                    let p = l.position;
                    drop(m);
                    self.navigate(p, 3., cancel).await?;
                }
                let (blocks, drops) = mining::resource(resource);
                self.gather(owner, &blocks, Some(&drops), *count, cancel)
                    .await
            }
            Action::PlaceBlock {
                block_name,
                position,
                face,
            } => {
                self.approach(*position, cancel).await?;
                self.game
                    .place(*position, block_name, face.as_deref(), cancel)
                    .await?;
                Ok(1)
            }
            Action::BuildStructure {
                structure,
                position,
                dimensions,
                material,
            } => {
                let name = material.as_deref().unwrap_or("cobblestone");
                let plan = build_plan(*structure, *position, dimensions);
                if self.game.snapshot().count(name) < plan.len() as u32 {
                    return Err(GameError::Failed(format!("need {} {name}", plan.len())));
                }
                let mut placed = 0;
                for p in &plan {
                    if cancel.is_cancelled() {
                        return Err(GameError::Cancelled);
                    }
                    self.approach(*p, cancel).await?;
                    self.game.place(*p, name, None, cancel).await?;
                    placed += 1;
                    self.report(owner, placed, Some(plan.len() as u32));
                }
                Ok(placed)
            }
            Action::EquipItem { item } => {
                self.game.equip(item, cancel).await?;
                Ok(1)
            }
            Action::DropItem {
                item,
                count,
                destination,
            } => {
                let n = count.unwrap_or(self.game.snapshot().count(item));
                if destination.as_deref() == Some("chest") {
                    let p = self.container(None).await?;
                    self.approach(p, cancel).await?;
                    self.game
                        .transfer(p, Some(item), Some(n), true, cancel)
                        .await
                } else {
                    self.game.drop_items(item, n, cancel).await
                }
            }
            Action::DepositItems { item, location } => {
                let p = self.container(location.as_deref()).await?;
                self.approach(p, cancel).await?;
                self.game
                    .transfer(p, item.as_deref(), None, true, cancel)
                    .await
            }
            Action::WithdrawItems {
                item,
                count,
                location,
            } => {
                let p = self.container(location.as_deref()).await?;
                self.approach(p, cancel).await?;
                self.game
                    .transfer(p, item.as_deref(), *count, false, cancel)
                    .await
            }
            Action::PickupItems {
                item,
                count,
                radius,
            } => {
                self.pickup(item.as_deref(), *count, radius.unwrap_or(16.), cancel)
                    .await
            }
            Action::Eat { item } => {
                self.game.eat(item.as_deref(), cancel).await?;
                Ok(1)
            }
            Action::AttackHostile { target, radius } => {
                self.combat(target.as_deref(), radius.unwrap_or(8.), None, cancel)
                    .await
            }
            Action::DefendPlayer {
                player,
                radius,
                duration_ms,
            } => {
                self.player_target(player)?;
                let end = duration_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
                self.follow(
                    player,
                    self.config.follow_distance,
                    cancel,
                    Some((radius.unwrap_or(8.), end)),
                )
                .await
            }
            Action::LookAt {
                position,
                duration_ms,
            } => {
                self.game.stop();
                self.game.look((*position).into());
                delay(Duration::from_millis(duration_ms.unwrap_or(0)), cancel).await?;
                Ok(1)
            }
            Action::Wait { duration_ms } => {
                self.game.stop();
                delay(Duration::from_millis(*duration_ms), cancel).await?;
                Ok(1)
            }
        }
    }
    fn player_target(&self, player: &str) -> GameResult<()> {
        if !self
            .config
            .authorized
            .contains(&player.to_ascii_lowercase())
        {
            return Err(GameError::Unsafe("target player is not authorized".into()));
        }
        Ok(())
    }
    pub async fn navigate(
        &self,
        p: Point,
        distance: f32,
        cancel: &CancellationToken,
    ) -> GameResult<()> {
        if cancel.is_cancelled() {
            return Err(GameError::Cancelled);
        }
        let dimension = self.game.snapshot().dimension;
        self.game.start_path(p, distance)?;
        let result = async {
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut last = self.game.snapshot().position;
            let mut moved = Instant::now();
            let mut replans = 0;
            loop {
                self.game.tick(cancel).await?;
                let s = self.game.snapshot();
                if s.dimension != dimension {
                    return Err(GameError::Unloaded);
                }
                if s.position.distance(p) <= distance as f64 + 0.5 {
                    return Ok(());
                }
                if !s.connected {
                    return Err(GameError::Disconnected);
                }
                if Instant::now() >= deadline {
                    return Err(GameError::Timeout("pathfinding".into()));
                }
                if s.position.distance(last) > 0.3 {
                    last = s.position;
                    moved = Instant::now();
                }
                if moved.elapsed() >= Duration::from_secs(5) {
                    replans += 1;
                    if replans > 3 {
                        return Err(GameError::Failed("stuck after three path replans".into()));
                    }
                    self.game.stop();
                    self.game.start_path(p, distance)?;
                    moved = Instant::now();
                }
            }
        }
        .await;
        self.game.stop();
        result
    }
    async fn approach(&self, p: Position, cancel: &CancellationToken) -> GameResult<()> {
        if self.game.snapshot().position.distance(p.into()) > 3.5 {
            self.navigate(p.into(), 3., cancel).await?;
        }
        Ok(())
    }
    async fn follow(
        &self,
        player: &str,
        distance: f32,
        cancel: &CancellationToken,
        guard: Option<(f32, Option<Instant>)>,
    ) -> GameResult<u32> {
        let mut goal: Option<Point> = None;
        let mut tick = 0;
        let mut lost: Option<Instant> = None;
        let mut last = self.game.snapshot().position;
        let mut moved = Instant::now();
        let mut replans = 0;
        let mut dimension = self.game.snapshot().dimension;
        let result = async {
            loop {
                self.game.tick(cancel).await?;
                tick += 1;
                if tick % 5 != 0 {
                    continue;
                }
                let s = self.game.snapshot();
                if !s.connected {
                    return Err(GameError::Disconnected);
                }
                if guard.is_some_and(|(_, end)| end.is_some_and(|e| Instant::now() >= e)) {
                    return Ok(0);
                }
                if s.dimension != dimension {
                    self.game.stop();
                    goal = None;
                    dimension = s.dimension.clone();
                }
                let Some(p) = s.player(player) else {
                    return Err(GameError::Failed("target left the online roster".into()));
                };
                let Some(target) = p.position else {
                    self.game.stop();
                    goal = None;
                    let start = *lost.get_or_insert_with(Instant::now);
                    if start.elapsed() > Duration::from_secs(90) {
                        return Err(GameError::Unloaded);
                    }
                    continue;
                };
                lost = None;
                if let Some((radius, _)) = guard {
                    if s.hostiles
                        .iter()
                        .any(|e| e.position.distance(target) < radius as f64)
                    {
                        self.combat(None, radius, Some(target), cancel).await?;
                        goal = None;
                        continue;
                    }
                }
                let d = s.position.distance(target);
                if d < 1.5 {
                    let dx = s.position.x - target.x;
                    let dz = s.position.z - target.z;
                    let len = dx.hypot(dz);
                    let away = Point {
                        x: target.x
                            + if len < 0.01 {
                                distance as f64
                            } else {
                                dx / len * distance as f64
                            },
                        y: s.position.y,
                        z: target.z
                            + if len < 0.01 {
                                0.
                            } else {
                                dz / len * distance as f64
                            },
                    };
                    if goal.is_none_or(|g| g.distance(away) > 0.5) {
                        self.game.start_path(away, 0.5)?;
                        goal = Some(away);
                    }
                    continue;
                }
                if d <= distance as f64 {
                    self.game.stop();
                    goal = None;
                    replans = 0;
                    moved = Instant::now();
                    continue;
                }
                if s.position.distance(last) > 0.3 {
                    last = s.position;
                    moved = Instant::now();
                    replans = 0;
                }
                let stuck = moved.elapsed() > Duration::from_secs(5);
                if stuck {
                    replans += 1;
                    if replans > 3 {
                        return Err(GameError::Failed("follow path is stuck".into()));
                    }
                    moved = Instant::now();
                }
                if goal.is_none_or(|g| g.distance(target) > 1.5) || stuck {
                    self.game.start_path(target, distance)?;
                    goal = Some(target);
                }
            }
        }
        .await;
        self.game.stop();
        result
    }
    async fn gather(
        &self,
        owner: &str,
        names: &[String],
        drops: Option<&[String]>,
        requested: u32,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        let mut mined = 0;
        let mut tried = HashSet::new();
        let mut failures = 0;
        let mut last_error = None;
        loop {
            if cancel.is_cancelled() {
                return Err(GameError::Cancelled);
            }
            let inventory = drops.map(|d| self.game.snapshot().count_any(d));
            let current = inventory.unwrap_or(mined);
            self.report(owner, current, Some(requested));
            if current >= requested {
                return Ok(current);
            }
            if mined >= self.config.max_mine {
                return Err(GameError::Failed(
                    "mining budget reached before inventory target".into(),
                ));
            }
            let targets = self.game.blocks(names, 24, 128);
            let target = targets
                .iter()
                .find(|b| !tried.contains(&b.position) && self.game.safe_break(b.position).is_ok())
                .ok_or_else(|| {
                    last_error.clone().unwrap_or_else(|| {
                        GameError::Failed(
                            "no safe reachable resource blocks in loaded chunks".into(),
                        )
                    })
                })?;
            tried.insert(target.position);
            let result = async {
                self.approach(target.position, cancel).await?;
                self.game.safe_break(target.position)?;
                self.game
                    .dig(
                        target.position,
                        if drops.is_some_and(|items| items.contains(&target.name))
                            && (target.name == "stone"
                                || target.name == "cobweb"
                                || target.name.ends_with("_leaves"))
                        {
                            DropGoal::SilkTouch
                        } else {
                            DropGoal::Harvest
                        },
                        cancel,
                    )
                    .await?;
                mined += 1;
                if drops.is_some() {
                    self.pickup(None, None, 8., cancel).await?;
                }
                Ok(())
            }
            .await;
            match result {
                Ok(()) => failures = 0,
                Err(e @ GameError::Cancelled) | Err(e @ GameError::Disconnected) => return Err(e),
                Err(e) => {
                    last_error = Some(e.clone());
                    failures += 1;
                    if failures >= 8 {
                        return Err(e);
                    }
                }
            }
        }
    }
    async fn pickup(
        &self,
        item: Option<&str>,
        count: Option<u32>,
        radius: f32,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        let initial = self.game.snapshot();
        let before = if let Some(name) = item {
            initial.count(name)
        } else {
            initial.inventory.iter().map(|i| i.count).sum()
        };
        let mut tried = HashSet::new();
        let mut collected = 0;
        loop {
            let s = self.game.snapshot();
            let after = if let Some(name) = item {
                s.count(name)
            } else {
                s.inventory.iter().map(|i| i.count).sum()
            };
            collected = collected.max(after.saturating_sub(before));
            if count.is_some_and(|n| collected >= n) {
                return Ok(collected);
            }
            let Some(drop) = s.drops.iter().find(|e| {
                e.distance <= radius as f64
                    && item.is_none_or(|n| e.item.as_deref() == Some(n))
                    && !tried.contains(&e.id)
            }) else {
                if count.is_some_and(|n| collected < n) {
                    return Err(GameError::Failed(format!(
                        "collected {collected} items; no more matching drops"
                    )));
                }
                return Ok(collected);
            };
            tried.insert(drop.id);
            if tried.len() > 128 {
                return Err(GameError::Failed("pickup entity budget exhausted".into()));
            }
            self.navigate(drop.position, 0.6, cancel).await?;
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                self.game.tick(cancel).await?;
                let now = self.game.snapshot();
                if !now.drops.iter().any(|e| e.id == drop.id) {
                    break;
                }
            }
        }
    }
    async fn container(&self, location: Option<&str>) -> GameResult<Position> {
        let s = self.game.snapshot();
        if let Some(name) = location.filter(|n| *n != "nearest") {
            let m = self.memory.lock().await;
            let l = m.location(name, &s.dimension).map_err(GameError::Unsafe)?;
            return Ok(l.position.block());
        }
        let names = vec!["chest".into(), "trapped_chest".into(), "barrel".into()];
        self.game
            .blocks(&names, 16, 64)
            .into_iter()
            .find(|b| {
                self.config
                    .allow_containers
                    .contains(&safety::container_key(&s.dimension, b.position))
            })
            .map(|b| b.position)
            .ok_or_else(|| {
                GameError::Unsafe(
                    "no authorized container nearby; configure AUTHORIZED_CONTAINERS".into(),
                )
            })
    }
    pub async fn combat(
        &self,
        target: Option<&str>,
        radius: f32,
        center: Option<Point>,
        cancel: &CancellationToken,
    ) -> GameResult<u32> {
        let s = self.game.snapshot();
        let origin = center.unwrap_or(s.position);
        if s.avoid_mobs
            .iter()
            .any(|e| e.position.distance(origin) <= radius as f64)
        {
            return Err(GameError::Unsafe(
                "dangerous mob nearby; retreat instead of approaching combat".into(),
            ));
        }
        let e = s
            .hostiles
            .iter()
            .find(|e| {
                e.position.distance(origin) <= radius as f64
                    && target.is_none_or(|name| e.name == name)
            })
            .ok_or_else(|| GameError::Failed("no hostile target nearby".into()))?;
        if e.distance > 2.8 {
            self.navigate(e.position, 2.5, cancel).await?;
        }
        for weapon in [
            "netherite_sword",
            "diamond_sword",
            "iron_sword",
            "stone_sword",
            "wooden_sword",
        ] {
            if self.game.snapshot().count(weapon) > 0 {
                self.game.equip(weapon, cancel).await?;
                break;
            }
        }
        self.game.attack(e.id, cancel).await?;
        Ok(1)
    }
    pub async fn escape(&self, cancel: &CancellationToken) -> GameResult<u32> {
        let s = self.game.snapshot();
        let mut choices = Vec::new();
        for dx in [-6, 0, 6] {
            for dz in [-6, 0, 6] {
                if dx == 0 && dz == 0 {
                    continue;
                }
                let p = s.position.block().offset(dx, 0, dz);
                let floor = self.game.block_name(p.offset(0, -1, 0));
                let feet = self.game.block_name(p);
                let head = self.game.block_name(p.offset(0, 1, 0));
                if floor.is_some_and(|n| {
                    !safety::dangerous(&n) && !["air", "water"].contains(&n.as_str())
                }) && feet.as_deref() == Some("air")
                    && head.as_deref() == Some("air")
                {
                    let point = Point::from(p);
                    if s.avoid_mobs
                        .iter()
                        .any(|e| e.position.distance(point) < safety::avoid_radius(&e.name))
                    {
                        continue;
                    }
                    let score = s
                        .hostiles
                        .iter()
                        .chain(&s.avoid_mobs)
                        .map(|e| e.position.distance(point) - safety::avoid_radius(&e.name))
                        .fold(100., f64::min);
                    choices.push((score, point));
                }
            }
        }
        choices.sort_by(|a, b| b.0.total_cmp(&a.0));
        let p = choices
            .first()
            .ok_or_else(|| {
                GameError::Failed("no safe escape destination in loaded terrain".into())
            })?
            .1;
        self.navigate(p, 1., cancel).await?;
        Ok(1)
    }
}
