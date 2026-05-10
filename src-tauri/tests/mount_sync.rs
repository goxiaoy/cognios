use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::{
    open_database, open_in_memory_database, Database,
};
use cognios_lib::infrastructure::db::mount_repository::{
    create_mount, find_nested_mount_conflict, reconcile_mount, CreateMountInput,
    NestedMountDirection,
};
use cognios_lib::services::mounts::scanner::normalize_mount_path;
use cognios_lib::services::search::client::IndexChangeDto;
use cognios_lib::services::search::index_state_sync::apply_index_changes;

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

    assert_eq!(mount.state, "pending");
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
fn reconcile_ignores_index_derived_container_state_when_mount_contents_are_unchanged() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    fs::write(mount_tempdir.path().join("root.txt"), "root").expect("root file");

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

    let child_id = {
        let conn = open_database(&db_path).expect("database");
        conn.query_row(
            "SELECT id FROM nodes WHERE mount_id = ?1 AND name = 'root.txt'",
            [&created_mount.mount_id],
            |row| row.get::<_, String>(0),
        )
        .expect("mounted child")
    };

    apply_index_changes(
        &Database::new(db_path.clone()),
        &[IndexChangeDto {
            node_id: child_id,
            state: "indexed".to_string(),
            indexed_at: None,
            error: None,
            transition_seq: 1,
        }],
    )
    .expect("index transition applied");

    {
        let conn = open_database(&db_path).expect("database");
        conn.execute(
            "UPDATE nodes SET updated_at = '2000-01-01 00:00:00' WHERE id = ?1",
            [&created_mount.mount_id],
        )
        .expect("pin mount timestamp");
    }

    let outcome = {
        let mut conn = open_database(&db_path).expect("database");
        reconcile_mount(&mut conn, &created_mount.mount_id).expect("reconcile")
    };

    let (state, updated_at) = {
        let conn = open_database(&db_path).expect("database");
        conn.query_row(
            "SELECT state, updated_at FROM nodes WHERE id = ?1",
            [&created_mount.mount_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .expect("mount row")
    };

    assert!(
        !outcome.changed,
        "index-derived mount state must not look like a filesystem change"
    );
    assert_eq!(state, "indexed");
    assert_eq!(updated_at, "2000-01-01 00:00:00");
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
