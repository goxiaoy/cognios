use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_in_memory_database;
use cognios_lib::infrastructure::db::mount_repository::{create_mount, CreateMountInput};

#[test]
fn creates_a_mount_and_mirrors_non_ignored_entries() {
    let tempdir = tempdir().expect("tempdir");
    fs::create_dir_all(tempdir.path().join("docs")).expect("docs dir");
    fs::create_dir_all(tempdir.path().join("node_modules")).expect("ignored dir");
    fs::write(tempdir.path().join("docs").join("notes.txt"), "hello").expect("notes");
    fs::write(
        tempdir.path().join("node_modules").join("skip.js"),
        "ignored",
    )
    .expect("ignored");
    fs::write(tempdir.path().join("root.txt"), "root").expect("root file");

    let mut conn = open_in_memory_database().expect("database");
    let created_mount = create_mount(
        &mut conn,
        &CreateMountInput {
            path: tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount created");
    let snapshot = created_mount.snapshot;

    let mount = snapshot
        .roots
        .iter()
        .find(|node| node.kind == "mount")
        .expect("mount root");

    assert_eq!(mount.state, "ready");
    assert!(mount.children.iter().any(|child| child.name == "docs"));
    assert!(mount.children.iter().any(|child| child.name == "root.txt"));
    assert!(!mount
        .children
        .iter()
        .any(|child| child.name == "node_modules"));

    let docs = mount
        .children
        .iter()
        .find(|child| child.name == "docs")
        .expect("docs child");
    assert!(docs.children.iter().any(|child| child.name == "notes.txt"));
}
