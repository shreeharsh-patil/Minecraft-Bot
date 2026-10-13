//! Drop cleanup events whose connection has already removed its inventory.
//! The historical framework unwraps these queries; cancelling a transfer after
//! a disconnect must not turn that stale handle into a process panic.
use azalea::{
    app::{App, Plugin, Update},
    ecs::prelude::*,
    inventory::{ClientSideCloseContainerEvent, CloseContainerEvent, Inventory, InventorySet},
};
pub struct InventoryCleanupPlugin;
impl Plugin for InventoryCleanupPlugin {
    fn build(&self, app: &mut App) {
        app.add_systems(Update, discard_stale.before(InventorySet));
    }
}
fn discard_stale(
    inventories: Query<Entity, With<Inventory>>,
    mut close: ResMut<Events<CloseContainerEvent>>,
    mut client_close: ResMut<Events<ClientSideCloseContainerEvent>>,
) {
    // Each supervisor session owns one ECS and one local inventory. Once that
    // inventory is gone, every queued close belongs to the ended connection.
    // Leave valid event IDs untouched so already-read cleanup is not replayed.
    if inventories.is_empty() {
        close.clear();
        client_close.clear();
    }
}
