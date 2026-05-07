use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, reconcile_mount, CreateMountInput,
};
use cognios_lib::infrastructure::db::node_repository::{
    create_folder, list_snapshot, CreateFolderInput,
};
use cognios_lib::infrastructure::db::url_repository::{
    create_url, mark_url_indexed, CreateUrlInput, CreatedUrl, UrlJobResult,
};

#[test]
fn snapshot_includes_metadata_for_virtual_and_url_nodes() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");
    let cache_path = tempdir.path().join("url-cache.html");
    let cache_body = "<html><body>cached preview</body></html>";
    fs::write(&cache_path, cache_body).expect("cache file");

    let mut conn = open_database(&db_path).expect("database");
    let folder_created = create_folder(
        &conn,
        &CreateFolderInput {
            name: "Inbox".into(),
            parent_id: None,
        },
    )
    .expect("folder");
    let folder_id = folder_created.snapshot.roots[0].id.clone();
    let CreatedUrl { node_id, .. } = create_url(
        &mut conn,
        &CreateUrlInput {
            url: "https://example.test".into(),
            parent_id: Some(folder_id.clone()),
        },
    )
    .expect("url");

    mark_url_indexed(
        &conn,
        &node_id,
        &UrlJobResult {
            title: Some("Example".into()),
            description: Some("Description".into()),
            preview_text: "Preview".into(),
            canonical_url: Some("https://example.test".into()),
            html_cache_path: cache_path.to_string_lossy().into_owned(),
        },
    )
    .expect("indexed");

    let snapshot = list_snapshot(&conn).expect("snapshot");
    let folder = snapshot
        .roots
        .iter()
        .find(|node| node.id == folder_id)
        .expect("folder node");
    let url = folder
        .children
        .iter()
        .find(|node| node.id == node_id)
        .expect("url node");

    assert!(!folder.created_at.is_empty());
    assert!(!folder.modified_at.is_empty());
    assert!(!url.created_at.is_empty());
    assert!(!url.modified_at.is_empty());
    assert_eq!(url.size_bytes, cache_body.len() as i64);
    assert_eq!(folder.size_bytes, url.size_bytes);
}

#[test]
fn reconcile_reuses_mounted_descendant_ids_and_refreshes_sizes() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let nested_dir = mount_tempdir.path().join("docs");
    let nested_file = nested_dir.join("notes.txt");

    fs::create_dir_all(&nested_dir).expect("nested dir");
    fs::write(&nested_file, "old").expect("initial file");

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
    let original_snapshot = created_mount.snapshot;
    let mount = original_snapshot
        .roots
        .iter()
        .find(|node| node.id == created_mount.mount_id)
        .expect("mount node");
    let docs = mount
        .children
        .iter()
        .find(|node| node.name == "docs")
        .expect("docs dir");
    let notes = docs
        .children
        .iter()
        .find(|node| node.name == "notes.txt")
        .expect("notes file");
    let original_id = notes.id.clone();

    fs::write(&nested_file, "new content with more bytes").expect("updated file");
    reconcile_mount(&mut conn, &created_mount.mount_id).expect("reconcile");

    let refreshed_snapshot = list_snapshot(&conn).expect("refreshed snapshot");
    let refreshed_mount = refreshed_snapshot
        .roots
        .iter()
        .find(|node| node.id == created_mount.mount_id)
        .expect("mount node");
    let refreshed_docs = refreshed_mount
        .children
        .iter()
        .find(|node| node.name == "docs")
        .expect("docs dir");
    let refreshed_notes = refreshed_docs
        .children
        .iter()
        .find(|node| node.name == "notes.txt")
        .expect("notes file");

    assert_eq!(refreshed_notes.id, original_id);
    assert_eq!(
        refreshed_notes.size_bytes,
        "new content with more bytes".len() as i64
    );
    assert_eq!(refreshed_docs.size_bytes, refreshed_notes.size_bytes);
    assert_eq!(refreshed_mount.size_bytes, refreshed_notes.size_bytes);
}
