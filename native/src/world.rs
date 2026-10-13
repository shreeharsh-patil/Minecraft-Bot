use crate::{actions::Position, mining::DropGoal};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}
impl Point {
    pub fn validate(self) -> Result<(), String> {
        if !self.x.is_finite()
            || !self.y.is_finite()
            || !self.z.is_finite()
            || self.x.abs() > 29_999_984.
            || self.z.abs() > 29_999_984.
            || !(-64.0..320.0).contains(&self.y)
        {
            return Err("position is outside the supported world bounds".into());
        }
        Ok(())
    }
    pub fn distance(self, other: Self) -> f64 {
        ((self.x - other.x).powi(2) + (self.y - other.y).powi(2) + (self.z - other.z).powi(2))
            .sqrt()
    }
    pub fn block(self) -> Position {
        Position {
            x: self.x.floor() as i32,
            y: self.y.floor() as i32,
            z: self.z.floor() as i32,
        }
    }
}
impl From<Position> for Point {
    fn from(p: Position) -> Self {
        Self {
            x: p.x as f64 + 0.5,
            y: p.y as f64,
            z: p.z as f64 + 0.5,
        }
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct Player {
    pub name: String,
    pub uuid: uuid::Uuid,
    pub position: Option<Point>,
}
#[derive(Debug, Clone, Serialize)]
pub struct Entity {
    pub id: u32,
    pub name: String,
    pub position: Point,
    pub distance: f64,
    pub health: Option<f32>,
    pub item: Option<String>,
    pub count: u32,
}
#[derive(Debug, Clone, Serialize)]
pub struct Item {
    pub name: String,
    pub count: u32,
    pub slot: usize,
}
#[derive(Debug, Clone)]
pub struct Block {
    pub name: String,
    pub position: Position,
    pub distance: f64,
}
#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    pub position: Point,
    pub dimension: String,
    pub health: f32,
    pub hunger: u32,
    pub has_food: bool,
    pub in_hazard: bool,
    pub online: Vec<Player>,
    pub hostiles: Vec<Entity>,
    pub avoid_mobs: Vec<Entity>,
    pub drops: Vec<Entity>,
    pub inventory: Vec<Item>,
    pub connected: bool,
    pub spawned: bool,
}
impl Snapshot {
    pub fn count(&self, name: &str) -> u32 {
        self.inventory
            .iter()
            .filter(|i| i.name == name)
            .map(|i| i.count)
            .sum()
    }
    pub fn count_any(&self, names: &[String]) -> u32 {
        self.inventory
            .iter()
            .filter(|i| names.contains(&i.name))
            .map(|i| i.count)
            .sum()
    }
    pub fn player(&self, name: &str) -> Option<&Player> {
        self.online
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
    }
    pub fn context(&self) -> serde_json::Value {
        serde_json::json!({"position":self.position,"dimension":self.dimension,"health":self.health,"hunger":self.hunger,"onlinePlayers":self.online.iter().take(5).collect::<Vec<_>>(),"nearbyHostiles":self.hostiles.iter().take(5).collect::<Vec<_>>(),"avoidMobs":self.avoid_mobs.iter().take(5).collect::<Vec<_>>(),"inventory":self.inventory.iter().take(12).collect::<Vec<_>>()})
    }
}
#[derive(Debug, thiserror::Error, Clone, PartialEq)]
pub enum GameError {
    #[error("cancelled")]
    Cancelled,
    #[error("operation timed out: {0}")]
    Timeout(String),
    #[error("server disconnected")]
    Disconnected,
    #[error("unsafe action refused: {0}")]
    Unsafe(String),
    #[error("gameplay failed: {0}")]
    Failed(String),
    #[error("player or chunk is not loaded")]
    Unloaded,
}
pub type GameResult<T> = Result<T, GameError>;
#[async_trait]
pub trait Game: Send + Sync {
    fn snapshot(&self) -> Snapshot;
    fn stop(&self);
    fn start_path(&self, target: Point, distance: f32) -> GameResult<()>;
    async fn tick(&self, cancel: &CancellationToken) -> GameResult<()>;
    fn blocks(&self, names: &[String], radius: u32, limit: usize) -> Vec<Block>;
    fn block_name(&self, p: Position) -> Option<String>;
    fn safe_break(&self, p: Position) -> GameResult<()>;
    fn look(&self, target: Point);
    async fn equip(&self, item: &str, cancel: &CancellationToken) -> GameResult<()>;
    async fn dig(&self, p: Position, goal: DropGoal, cancel: &CancellationToken) -> GameResult<()>;
    async fn place(
        &self,
        p: Position,
        name: &str,
        face: Option<&str>,
        cancel: &CancellationToken,
    ) -> GameResult<()>;
    async fn drop_items(
        &self,
        name: &str,
        count: u32,
        cancel: &CancellationToken,
    ) -> GameResult<u32>;
    async fn transfer(
        &self,
        p: Position,
        name: Option<&str>,
        count: Option<u32>,
        deposit: bool,
        cancel: &CancellationToken,
    ) -> GameResult<u32>;
    async fn eat(&self, name: Option<&str>, cancel: &CancellationToken) -> GameResult<()>;
    async fn attack(&self, id: u32, cancel: &CancellationToken) -> GameResult<()>;
    fn say(&self, owner: &str, message: &str);
}
pub async fn delay(duration: Duration, cancel: &CancellationToken) -> GameResult<()> {
    tokio::select! {biased;_=cancel.cancelled()=>Err(GameError::Cancelled),_=tokio::time::sleep(duration)=>Ok(())}
}
