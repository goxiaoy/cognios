use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, reconcile_mount, CreateMountInput,
};
use cognios_lib::infrastructure::db::node_repository::CreateFolderInput;
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::create_folder::create_folder;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::mutations::rename_node::{rename_node, RenameNodeInput};

fn noop_emitter(_event: VfsChangeEvent) {}

fn create_folder_error(conn: &mut rusqlite::Connection, input: CreateFolderInput) -> String {
    match create_folder(conn, &input, &noop_emitter) {
        Ok(_) => panic!("folder creation unexpectedly succeeded"),
        Err(error) => error,
    }
}

#[test]
fn creates_mounted_folders_on_disk_and_reconciles_stable_nodes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    fs::create_dir_all(mount_tempdir.path().join("docs")).expect("docs dir");

    let (mount_id, docs_id) = {
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
        let docs = created_mount.snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.name == "docs")
            .expect("docs node");
        assert_eq!(docs.kind, "folder");
        (created_mount.mount_id, docs.id.clone())
    };

    let root_created_id = {
        let mut conn = open_database(&db_path).expect("database reopen");
        let created = create_folder(
            &mut conn,
            &CreateFolderInput {
                name: "from-root".into(),
                parent_id: Some(mount_id.clone()),
            },
            &noop_emitter,
        )
        .expect("create folder under mount");
        assert!(mount_tempdir.path().join("from-root").is_dir());
        let child = created.snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.name == "from-root")
            .expect("created child in snapshot");
        assert_eq!(child.kind, "folder");
        created.node_id
    };

    let nested_created_id = {
        let mut conn = open_database(&db_path).expect("database reopen");
        let created = create_folder(
            &mut conn,
            &CreateFolderInput {
                name: "nested".into(),
                parent_id: Some(docs_id.clone()),
            },
            &noop_emitter,
        )
        .expect("create folder under mounted folder");
        assert!(mount_tempdir.path().join("docs").join("nested").is_dir());
        let docs = created.snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.id == docs_id)
            .expect("docs node in snapshot");
        assert!(docs
            .children
            .iter()
            .any(|child| child.id == created.node_id && child.kind == "folder"));
        created.node_id
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        reconcile_mount(&mut conn, &mount_id).expect("reconcile mount");
        let (root_id_after_reconcile, nested_id_after_reconcile): (String, String) = conn
            .query_row(
                "
                SELECT
                    (SELECT id FROM nodes WHERE mount_id = ?1 AND relative_path = 'from-root'),
                    (SELECT id FROM nodes WHERE mount_id = ?1 AND relative_path = 'docs/nested')
                ",
                [&mount_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("created folder ids");
        assert_eq!(root_id_after_reconcile, root_created_id);
        assert_eq!(nested_id_after_reconcile, nested_created_id);
    }
}

#[test]
fn rejects_mounted_folder_creation_when_invalid_or_unavailable() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    fs::write(mount_tempdir.path().join("taken"), "file").expect("taken file");

    let (mount_id, file_id) = {
        let mut conn = open_database(&db_path).expect("database");
        let created_mount = create_mount(
            &mut conn,
            &CreateMountInput {
                path: mount_tempdir.path().to_string_lossy().into_owned(),
                parent_id: None,
                ignore_config: Some("hidden/\n".into()),
            },
        )
        .expect("mount created");
        let file = created_mount.snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.name == "taken")
            .expect("file child");
        (created_mount.mount_id, file.id.clone())
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let error = create_folder_error(
            &mut conn,
            CreateFolderInput {
                name: "taken".into(),
                parent_id: Some(mount_id.clone()),
            },
        );
        assert!(error.contains("already exists"));
        assert!(mount_tempdir.path().join("taken").is_file());
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let error = create_folder_error(
            &mut conn,
            CreateFolderInput {
                name: "hidden".into(),
                parent_id: Some(mount_id.clone()),
            },
        );
        assert!(error.contains("excluded"));
        assert!(!mount_tempdir.path().join("hidden").exists());
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let error = create_folder_error(
            &mut conn,
            CreateFolderInput {
                name: "child".into(),
                parent_id: Some(file_id),
            },
        );
        assert!(error.contains("parent is not a folder"));
        assert!(!mount_tempdir.path().join("taken").join("child").exists());
    }

    fs::remove_dir_all(mount_tempdir.path()).expect("remove mount dir");
    {
        let mut conn = open_database(&db_path).expect("database reopen");
        reconcile_mount(&mut conn, &mount_id).expect("mark unavailable");
        let error = create_folder_error(
            &mut conn,
            CreateFolderInput {
                name: "after-unavailable".into(),
                parent_id: Some(mount_id),
            },
        );
        assert!(error.contains("unavailable"));
    }
}

#[test]
fn renames_and_deletes_mounted_folders_on_disk() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let notes_dir = app_tempdir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    fs::create_dir_all(mount_tempdir.path().join("docs")).expect("docs dir");
    fs::write(mount_tempdir.path().join("docs").join("notes.txt"), "notes").expect("notes file");

    let docs_id = {
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
        created_mount.snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.name == "docs")
            .expect("docs child")
            .id
            .clone()
    };

    let renamed_id = {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = rename_node(
            &mut conn,
            &RenameNodeInput {
                node_id: docs_id,
                new_name: "manuals".into(),
            },
            &noop_emitter,
        )
        .expect("rename mounted folder");
        assert!(mount_tempdir.path().join("manuals").is_dir());
        assert!(!mount_tempdir.path().join("docs").exists());
        snapshot.roots[0]
            .children
            .iter()
            .find(|child| child.name == "manuals")
            .expect("renamed folder")
            .id
            .clone()
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: renamed_id.clone(),
                cascade: None,
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect("delete mounted folder");
        assert!(!mount_tempdir.path().join("manuals").exists());
        assert!(!snapshot.roots[0]
            .children
            .iter()
            .any(|child| child.id == renamed_id));
    }
}

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
