use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_in_memory_database;
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, find_nested_mount_conflict, CreateMountInput, NestedMountDirection,
};
use cognios_lib::services::mounts::scanner::normalize_mount_path;

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
    assert_eq!(docs.kind, "folder");
    assert!(docs.children.iter().any(|child| child.name == "notes.txt"));
}

#[test]
fn nested_mount_conflict_detects_descendant_paths() {
    // Setup: outer mount at <tmp>, then a candidate path at
    // <tmp>/inner — the candidate is *inside* the outer mount and
    // must surface as ``Inside``. Production callers normalize the
    // candidate path before checking; mirror that here so macOS's
    // /var → /private/var symlink doesn't make the prefix test miss.
    let tempdir = tempdir().expect("tempdir");
    let inner = tempdir.path().join("inner");
    fs::create_dir_all(&inner).expect("inner dir");

    let mut conn = open_in_memory_database().expect("database");
    create_mount(
        &mut conn,
        &CreateMountInput {
            path: tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("outer mount");

    let normalized_inner = normalize_mount_path(&inner.to_string_lossy()).expect("normalize");
    let conflict = find_nested_mount_conflict(&conn, &normalized_inner)
        .expect("query")
        .expect("inner is inside outer");
    assert!(matches!(conflict.direction, NestedMountDirection::Inside));
}

#[test]
fn nested_mount_conflict_detects_ancestor_paths() {
    // Mirror case: inner mount lives first, then a candidate that
    // would swallow it must surface as ``Contains``.
    let tempdir = tempdir().expect("tempdir");
    let inner = tempdir.path().join("inner");
    fs::create_dir_all(&inner).expect("inner dir");

    let mut conn = open_in_memory_database().expect("database");
    create_mount(
        &mut conn,
        &CreateMountInput {
            path: inner.to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("inner mount");

    let normalized_outer =
        normalize_mount_path(&tempdir.path().to_string_lossy()).expect("normalize");
    let conflict = find_nested_mount_conflict(&conn, &normalized_outer)
        .expect("query")
        .expect("outer contains inner");
    assert!(matches!(conflict.direction, NestedMountDirection::Contains));
}

#[test]
fn nested_mount_conflict_skips_unrelated_siblings() {
    // ``/foo/bar`` and ``/foo/baz`` share a parent prefix but
    // neither lives inside the other — the prefix-only test would
    // false-positive here; component-wise comparison must skip it.
    let tempdir = tempdir().expect("tempdir");
    let bar = tempdir.path().join("bar");
    let baz = tempdir.path().join("baz");
    fs::create_dir_all(&bar).expect("bar dir");
    fs::create_dir_all(&baz).expect("baz dir");

    let mut conn = open_in_memory_database().expect("database");
    create_mount(
        &mut conn,
        &CreateMountInput {
            path: bar.to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("bar mount");

    let normalized_baz = normalize_mount_path(&baz.to_string_lossy()).expect("normalize");
    let conflict = find_nested_mount_conflict(&conn, &normalized_baz).expect("query");
    assert!(conflict.is_none(), "siblings shouldn't conflict");
}

#[test]
fn nested_mount_conflict_ignores_exact_path_match() {
    // Exact-path duplicates are surfaced via the dedicated
    // ``find_existing_mount_by_absolute_path`` flow — the nested
    // check must not double-report them.
    let tempdir = tempdir().expect("tempdir");

    let mut conn = open_in_memory_database().expect("database");
    create_mount(
        &mut conn,
        &CreateMountInput {
            path: tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("first mount");

    let normalized = normalize_mount_path(&tempdir.path().to_string_lossy()).expect("normalize");
    let conflict = find_nested_mount_conflict(&conn, &normalized).expect("query");
    assert!(
        conflict.is_none(),
        "exact-path duplicate is not a nesting conflict"
    );
}
