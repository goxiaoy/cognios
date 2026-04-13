use rusqlite::Connection;

use crate::infrastructure::db::mount_repository::{create_mount, CreateMountInput, CreatedMount};

pub fn create_mount_snapshot(
    conn: &mut Connection,
    input: &CreateMountInput,
) -> Result<CreatedMount, String> {
    create_mount(conn, input).map_err(|error| error.to_string())
}
