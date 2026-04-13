use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, list_mount_ids, CreateMountInput,
};
use cognios_lib::infrastructure::db::node_repository::list_snapshot;
use cognios_lib::services::mounts::reconcile::reconcile_all_mounts;

#[test]
fn rescans_mounts_after_restart_and_handles_unavailable_paths() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");

    fs::write(mount_tempdir.path().join("alpha.txt"), "alpha").expect("alpha file");

    {
        let mut conn = open_database(&db_path).expect("database");
        create_mount(
            &mut conn,
            &CreateMountInput {
                path: mount_tempdir.path().to_string_lossy().into_owned(),
                parent_id: None,
                ignore_config: None,
            },
        )
        .expect("mount created");
    }

    fs::write(mount_tempdir.path().join("beta.txt"), "beta").expect("beta file");

    {
        let mut conn = open_database(&db_path).expect("database reopened");
        reconcile_all_mounts(&mut conn).expect("mounts reconciled");

        let snapshot = list_snapshot(&conn).expect("snapshot");
        let mount = snapshot
            .roots
            .iter()
            .find(|node| node.kind == "mount")
            .expect("mount");
        assert_eq!(mount.state, "ready");
        assert!(mount.children.iter().any(|child| child.name == "alpha.txt"));
        assert!(mount.children.iter().any(|child| child.name == "beta.txt"));
    }

    let mount_ids = {
        let conn = open_database(&db_path).expect("database reopened");
        list_mount_ids(&conn).expect("mount ids")
    };
    let mount_path = mount_tempdir.keep();
    fs::remove_dir_all(&mount_path).expect("remove mounted dir");

    {
        let mut conn = open_database(&db_path).expect("database reopened");
        let outcomes = reconcile_all_mounts(&mut conn).expect("mounts reconciled");
        assert_eq!(outcomes.len(), 1);
        assert_eq!(outcomes[0].mount_id, mount_ids[0]);
        assert!(!outcomes[0].is_available);

        let snapshot = list_snapshot(&conn).expect("snapshot");
        let mount = snapshot
            .roots
            .iter()
            .find(|node| node.kind == "mount")
            .expect("mount");
        assert_eq!(mount.state, "unavailable");
        assert!(mount.children.iter().any(|child| child.name == "alpha.txt"));
        assert!(mount.children.iter().any(|child| child.name == "beta.txt"));
    }

    fs::create_dir_all(&mount_path).expect("recreate dir");
    fs::write(mount_path.join("gamma.txt"), "gamma").expect("gamma file");

    {
        let mut conn = open_database(&db_path).expect("database reopened");
        let outcomes = reconcile_all_mounts(&mut conn).expect("mounts reconciled");
        assert_eq!(outcomes.len(), 1);
        assert!(outcomes[0].is_available);

        let snapshot = list_snapshot(&conn).expect("snapshot");
        let mount = snapshot
            .roots
            .iter()
            .find(|node| node.kind == "mount")
            .expect("mount");
        assert_eq!(mount.state, "ready");
        assert_eq!(mount.children.len(), 1);
        assert_eq!(mount.children[0].name, "gamma.txt");
    }
}
