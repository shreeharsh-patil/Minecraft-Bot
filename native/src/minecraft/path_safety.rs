use azalea::{
    app::{App, Plugin},
    core::tick::GameTick,
    ecs::prelude::*,
    entity::{Jumping, LocalEntity},
    pathfinder::{ExecutingPath, Pathfinder},
    physics::PhysicsSet,
    InstanceHolder, PhysicsState, WalkDirection,
};
pub struct PathSafetyPlugin;
#[derive(Clone)]
pub struct ThreatZone {
    pub position: crate::world::Point,
    pub radius: f64,
}
#[derive(Default)]
pub struct PathThreats(pub Vec<ThreatZone>);
impl Component for PathThreats {
    const STORAGE_TYPE: azalea::ecs::component::StorageType =
        azalea::ecs::component::StorageType::Table;
}
pub fn threat_blocks_step(
    zone: &ThreatZone,
    current: crate::world::Point,
    target: crate::world::Point,
) -> bool {
    let before = current.distance(zone.position);
    let after = target.distance(zone.position);
    // Retreat must remain possible when the bot starts inside a danger zone.
    after < zone.radius && (before >= zone.radius || after <= before + 0.05)
}
impl Plugin for PathSafetyPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(
            GameTick,
            (check_path, apply_deferred).chain().before(PhysicsSet),
        );
    }
}
type PathQuery<'w, 's> = Query<
    'w,
    's,
    (
        Entity,
        &'static InstanceHolder,
        &'static ExecutingPath,
        &'static mut Pathfinder,
        &'static mut PhysicsState,
        &'static mut Jumping,
        Option<&'static PathThreats>,
        &'static azalea::entity::Position,
    ),
    With<LocalEntity>,
>;
fn check_path(mut commands: Commands, mut query: PathQuery) {
    for (entity, holder, path, mut finder, mut controls, mut jumping, threats, position) in
        &mut query
    {
        let instance = holder.instance.read();
        let unsafe_path = path.path.iter().take(2).any(|step| {
            let p = step.target;
            if threats.is_some_and(|threats| {
                threats.0.iter().any(|zone| {
                    let center = crate::world::Point {
                        x: p.x as f64 + 0.5,
                        y: p.y as f64,
                        z: p.z as f64 + 0.5,
                    };
                    threat_blocks_step(zone, super::game::point(**position), center)
                })
            }) {
                return true;
            }
            [p, p.up(1), p.down(1)].into_iter().any(|p| {
                instance.get_block_state(&p).is_none_or(|b| {
                    crate::safety::dangerous(
                        azalea::registry::Block::from(b)
                            .to_string()
                            .trim_start_matches("minecraft:"),
                    )
                })
            })
        });
        if unsafe_path {
            finder.goal = None;
            finder
                .goto_id
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            controls.move_direction = WalkDirection::None;
            controls.trying_to_sprint = false;
            controls.forward_impulse = 0.;
            controls.left_impulse = 0.;
            **jumping = false;
            commands.entity(entity).remove::<ExecutingPath>();
        }
    }
}
