use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{create_mount, CreateMountInput};
use cognios_lib::infrastructure::db::node_repository::create_folder;
use cognios_lib::infrastructure::db::node_repository::CreateFolderInput;
use cognios_lib::infrastructure::db::url_repository::{create_url, CreateUrlInput};
use cognios_lib::services::mounts::watcher::VfsChangeEvent;
use cognios_lib::services::mutations::delete_node::{delete_node, DeleteNodeInput};
use cognios_lib::services::mutations::rename_node::{rename_node, RenameNodeInput};

fn noop_emitter(_event: VfsChangeEvent) {}

#[test]
fn renames_folder_and_deletes_folder_url_and_mount_nodes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let notes_dir = app_tempdir.path().join("notes");
    fs::create_dir_all(&notes_dir).expect("notes dir");
    fs::write(mount_tempdir.path().join("keep.txt"), "keep").expect("mount file");

    let (root_folder_id, child_folder_id, url_node_id, mount_node_id) = {
        let mut conn = open_database(&db_path).expect("database");
        let root_created = create_folder(
            &conn,
            &CreateFolderInput {
                name: "Root".into(),
                parent_id: None,
            },
        )
        .expect("root folder");
        let root_folder_id = root_created.snapshot.roots[0].id.clone();

        let child_created = create_folder(
            &conn,
            &CreateFolderInput {
                name: "Child".into(),
                parent_id: Some(root_folder_id.clone()),
            },
        )
        .expect("child folder");
        let child_folder_id = child_created.snapshot.roots[0].children[0].id.clone();

        let created_url = create_url(
            &mut conn,
            &CreateUrlInput {
                url: "https://example.test/item".into(),
                parent_id: None,
            },
        )
        .expect("url created");

        let cache_path = app_tempdir.path().join("url-cache").join("cached.html");
        fs::create_dir_all(cache_path.parent().expect("cache dir")).expect("cache dir");
        fs::write(&cache_path, "<html></html>").expect("cache file");
        let cache_path_string = cache_path.to_string_lossy().into_owned();
        conn.execute(
            "UPDATE urls SET html_cache_path = ?2 WHERE node_id = ?1",
            [&created_url.node_id, &cache_path_string],
        )
        .expect("cache path saved");

        let created_mount = create_mount(
            &mut conn,
            &CreateMountInput {
                path: mount_tempdir.path().to_string_lossy().into_owned(),
                parent_id: None,
                ignore_config: None,
            },
        )
        .expect("mount created");

        (
            root_folder_id,
            child_folder_id,
            created_url.node_id,
            created_mount.mount_id,
        )
    };

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let renamed = rename_node(
            &mut conn,
            &RenameNodeInput {
                node_id: root_folder_id.clone(),
                new_name: "Renamed Root".into(),
            },
            &noop_emitter,
        )
        .expect("rename root");
        let renamed_root = renamed
            .roots
            .iter()
            .find(|node| node.id == root_folder_id)
            .expect("renamed root");
        assert_eq!(renamed_root.name, "Renamed Root");
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let error = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: root_folder_id.clone(),
                cascade: None,
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect_err("non-empty folder should require cascade");
        assert!(error.contains("folder not empty"));
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: url_node_id.clone(),
                cascade: None,
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect("delete url");
        assert!(!snapshot.roots.iter().any(|node| node.id == url_node_id));
        let remaining_jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM urls WHERE node_id = ?1",
                [&url_node_id],
                |row| row.get(0),
            )
            .expect("job count");
        assert_eq!(remaining_jobs, 0);
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: mount_node_id.clone(),
                cascade: None,
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect("delete mount");
        assert!(!snapshot.roots.iter().any(|node| node.id == mount_node_id));
        assert!(
            mount_tempdir.path().exists(),
            "mount source folder should remain"
        );
    }

    {
        let mut conn = open_database(&db_path).expect("database reopen");
        let snapshot = delete_node(
            &mut conn,
            &DeleteNodeInput {
                node_id: root_folder_id,
                cascade: Some(true),
            },
            &notes_dir,
            &noop_emitter,
        )
        .expect("delete folder cascade");
        assert!(!snapshot.roots.iter().any(|node| node.id == child_folder_id));
    }
}
