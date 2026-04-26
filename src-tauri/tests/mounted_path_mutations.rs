use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, reconcile_mount, CreateMountInput,
};
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::mutations::rename_node::{rename_node, RenameNodeInput};

fn noop_emitter(_event: VfsChangeEvent) {}

#[test]
fn renames_and_deletes_mounted_paths_and_rejects_unavailable_mounts() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let notes_dir = app_tempdir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");

    fs::write(mount_tempdir.path().join("alpha.txt"), "alpha").expect("alpha file");

    let (mount_id, file_node_id) = {
        let mut conn = open_database(&db_path).expect("database");
        let created_mount = create_mount(
            &mut conn,
            &CreateMountInput {
                path: mount_tempdir.path().to_string_lossy().into_owned(),
                parent_id: None,
                ignore_config: None,
            },
        )
        .expect("mount created");
        let file_node_id = created_mount.snapshot.roots[0].children[0].id.clone();
        (created_mount.mount_id, file_node_id)
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = rename_node(
            &mut conn,
            &RenameNodeInput {
                node_id: file_node_id.clone(),
                new_name: "beta.txt".into(),
            },
            &noop_emitter,
        )
        .expect("rename mounted file");
        assert!(snapshot.roots[0]
            .children
            .iter()
            .any(|child| child.name == "beta.txt"));
        assert!(mount_tempdir.path().join("beta.txt").exists());
        assert!(!mount_tempdir.path().join("alpha.txt").exists());
    }

    let renamed_file_id = {
        let conn = open_database(&db_path).expect("database reopen");
        conn.query_row(
            "SELECT id FROM nodes WHERE mount_id = ?1 AND name = 'beta.txt'",
            [&mount_id],
            |row| row.get::<_, String>(0),
        )
        .expect("beta node id")
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: renamed_file_id.clone(),
                cascade: None,
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect("delete mounted file");
        assert!(!snapshot.roots[0]
            .children
            .iter()
            .any(|child| child.id == renamed_file_id));
        assert!(!mount_tempdir.path().join("beta.txt").exists());
    }

    fs::write(mount_tempdir.path().join("gamma.txt"), "gamma").expect("gamma file");
    {
        let mut conn = open_database(&db_path).expect("database reopen");
        reconcile_mount(&mut conn, &mount_id).expect("reconcile mount");
    }
    fs::remove_dir_all(mount_tempdir.path()).expect("remove mount dir");

    let unavailable_file_id = {
        let mut conn = open_database(&db_path).expect("database reopen");
        reconcile_mount(&mut conn, &mount_id).expect("mark unavailable");
        conn.query_row(
            "SELECT id FROM nodes WHERE mount_id = ?1 LIMIT 1",
            [&mount_id],
            |row| row.get::<_, String>(0),
        )
        .expect("file node id")
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let error = rename_node(
            &mut conn,
            &RenameNodeInput {
                node_id: unavailable_file_id,
                new_name: "delta.txt".into(),
            },
            &noop_emitter,
        )
        .expect_err("unavailable mounted file should reject rename");
        assert!(error.contains("unavailable"));
    }
}
