use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::node_repository::list_snapshot;

#[test]
fn opens_a_fresh_database_and_returns_an_empty_snapshot() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let conn = open_database(&db_path).expect("database opens");

    let snapshot = list_snapshot(&conn).expect("snapshot loads");

    assert!(snapshot.roots.is_empty());
}
