use rusqlite::Connection;

use crate::infrastructure::db::mount_repository::{
    list_mount_ids, reconcile_mount, ReconcileMountOutcome,
};

pub fn reconcile_all_mounts(conn: &mut Connection) -> Result<Vec<ReconcileMountOutcome>, String> {
    let mount_ids = list_mount_ids(conn).map_err(|error| error.to_string())?;
    let mut outcomes = Vec::with_capacity(mount_ids.len());

    for mount_id in mount_ids {
        outcomes.push(reconcile_mount(conn, &mount_id).map_err(|error| error.to_string())?);
    }

    Ok(outcomes)
}
