use std::fs;
use std::thread;
use std::time::{Duration, Instant};

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::{open_database, Database};
use cognios_lib::infrastructure::db::mount_repository::{create_mount, CreateMountInput};
use cognios_lib::infrastructure::db::node_repository::list_snapshot;
use cognios_lib::services::mounts::watcher::MountWatcherRegistry;

#[test]
fn watcher_reconciles_mount_after_filesystem_changes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");

    let created_mount = {
        let mut conn = open_database(&db_path).expect("database");
        create_mount(
            &mut conn,
            &CreateMountInput {
                path: mount_tempdir.path().to_string_lossy().into_owned(),
                parent_id: None,
                ignore_config: None,
            },
        )
        .expect("mount created")
    };

    let registry = MountWatcherRegistry::new(|_| {});
    registry
        .start_mount(
            Database::new(db_path.clone()),
            created_mount.mount_id,
            mount_tempdir.path().to_path_buf(),
        )
        .expect("watcher starts");

    fs::write(mount_tempdir.path().join("live.txt"), "live").expect("write file");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut saw_live_file = false;

    while Instant::now() < deadline {
        let conn = open_database(&db_path).expect("database reopen");
        let snapshot = list_snapshot(&conn).expect("snapshot");
        let live_present = snapshot
            .roots
            .iter()
            .flat_map(|root| root.children.iter())
            .any(|child| child.name == "live.txt");

        if live_present {
            saw_live_file = true;
            break;
        }

        thread::sleep(Duration::from_millis(150));
    }

    registry.stop_all();

    assert!(saw_live_file, "watcher did not reconcile filesystem change");
}
