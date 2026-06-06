use rusqlite::Connection;

use crate::domain::node_status::NodeStatusChangedEventDto;
use crate::infrastructure::db::node_status_repository::{
    get_node_status_changed_event, NODE_STATUS_CHANGED_EVENT,
};

pub const NODE_STATUS_CHANGED_EVENT_NAME: &str = NODE_STATUS_CHANGED_EVENT;

pub fn current_node_status_event(
    conn: &Connection,
    node_id: &str,
) -> rusqlite::Result<Option<NodeStatusChangedEventDto>> {
    get_node_status_changed_event(conn, node_id)
}
