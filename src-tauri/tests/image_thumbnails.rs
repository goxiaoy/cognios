use std::fs;

use tempfile::tempdir;

use cognios_lib::commands::thumbnails::load_thumbnail_data_url;
use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{create_mount, CreateMountInput};
use cognios_lib::infrastructure::db::node_repository::list_snapshot;

const TINY_PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
    0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
    0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78,
    0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00, 0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92,
    0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

#[test]
fn returns_data_url_for_mounted_image_nodes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let image_path = mount_tempdir.path().join("preview.png");
    fs::write(&image_path, TINY_PNG).expect("png");

    let mut conn = open_database(&db_path).expect("database");
    let created_mount = create_mount(
        &mut conn,
        &CreateMountInput {
            path: mount_tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount");
    let snapshot = list_snapshot(&conn).expect("snapshot");
    let image_node = snapshot
        .roots
        .iter()
        .find(|node| node.id == created_mount.mount_id)
        .and_then(|mount| mount.children.iter().find(|child| child.name == "preview.png"))
        .expect("image node");

    let data_url = load_thumbnail_data_url(&conn, &image_node.id).expect("thumbnail");

    assert!(data_url.starts_with("data:image/png;base64,"));
}

#[test]
fn rejects_non_image_nodes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    fs::write(mount_tempdir.path().join("notes.txt"), "plain text").expect("text file");

    let mut conn = open_database(&db_path).expect("database");
    let created_mount = create_mount(
        &mut conn,
        &CreateMountInput {
            path: mount_tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount");
    let snapshot = list_snapshot(&conn).expect("snapshot");
    let text_node = snapshot
        .roots
        .iter()
        .find(|node| node.id == created_mount.mount_id)
        .and_then(|mount| mount.children.iter().find(|child| child.name == "notes.txt"))
        .expect("text node");

    let error = load_thumbnail_data_url(&conn, &text_node.id).expect_err("rejected");

    assert_eq!(error, "thumbnail unavailable");
}
