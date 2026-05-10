use std::fs;

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::mount_repository::{create_mount, CreateMountInput};
use cognios_lib::infrastructure::db::node_repository::list_snapshot;
use cognios_lib::services::files::read_file_content::{read_file_content, MAX_PREVIEW_BYTES};

fn setup_mount_with_files(
    files: &[(&str, &[u8])],
) -> (
    tempfile::TempDir,
    tempfile::TempDir,
    rusqlite::Connection,
    String,
) {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    for (name, contents) in files {
        fs::write(mount_tempdir.path().join(name), contents).expect("write file");
    }
    let mut conn = open_database(&db_path).expect("database");
    let created = create_mount(
        &mut conn,
        &CreateMountInput {
            path: mount_tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount");
    (app_tempdir, mount_tempdir, conn, created.mount_id)
}

fn find_child_id(conn: &rusqlite::Connection, mount_id: &str, name: &str) -> String {
    let snapshot = list_snapshot(conn).expect("snapshot");
    snapshot
        .roots
        .iter()
        .find(|node| node.id == mount_id)
        .and_then(|mount| mount.children.iter().find(|child| child.name == name))
        .unwrap_or_else(|| panic!("child node {name} not found"))
        .id
        .clone()
}

#[test]
fn reads_md_file_contents() {
    let (_app, _mount, conn, mount_id) =
        setup_mount_with_files(&[("notes.md", b"# Hello\n\nWorld")]);
    let node_id = find_child_id(&conn, &mount_id, "notes.md");

    let content = read_file_content(&conn, &node_id).expect("read");

    assert_eq!(content, "# Hello\n\nWorld");
}

#[test]
fn reads_mdx_file_contents() {
    let (_app, _mount, conn, mount_id) =
        setup_mount_with_files(&[("doc.mdx", b"import X from 'x'")]);
    let node_id = find_child_id(&conn, &mount_id, "doc.mdx");

    let content = read_file_content(&conn, &node_id).expect("read");

    assert_eq!(content, "import X from 'x'");
}

#[test]
fn reads_plain_text_file_contents() {
    let (_app, _mount, conn, mount_id) = setup_mount_with_files(&[("notes.txt", b"plain text")]);
    let node_id = find_child_id(&conn, &mount_id, "notes.txt");

    let content = read_file_content(&conn, &node_id).expect("read");

    assert_eq!(content, "plain text");
}

#[test]
fn empty_md_file_returns_empty_string() {
    let (_app, _mount, conn, mount_id) = setup_mount_with_files(&[("empty.md", b"")]);
    let node_id = find_child_id(&conn, &mount_id, "empty.md");

    let content = read_file_content(&conn, &node_id).expect("read");

    assert_eq!(content, "");
}

#[test]
fn rejects_file_at_or_over_size_cap() {
    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let db_path = app_tempdir.path().join("cognios.db");

    // exactly at cap is accepted
    let at_cap = vec![b'a'; MAX_PREVIEW_BYTES as usize];
    fs::write(mount_tempdir.path().join("at-cap.md"), &at_cap).expect("write at cap");
    // one byte over is rejected
    let over_cap = vec![b'a'; MAX_PREVIEW_BYTES as usize + 1];
    fs::write(mount_tempdir.path().join("over-cap.md"), &over_cap).expect("write over cap");

    let mut conn = open_database(&db_path).expect("database");
    let created = create_mount(
        &mut conn,
        &CreateMountInput {
            path: mount_tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount");

    let at_cap_id = find_child_id(&conn, &created.mount_id, "at-cap.md");
    let over_cap_id = find_child_id(&conn, &created.mount_id, "over-cap.md");

    assert!(read_file_content(&conn, &at_cap_id).is_ok());
    assert_eq!(
        read_file_content(&conn, &over_cap_id).unwrap_err(),
        "file too large"
    );
}

#[test]
fn rejects_non_file_nodes() {
    let (_app, _mount, conn, mount_id) = setup_mount_with_files(&[("a.md", b"x")]);

    // mount node itself is kind=mount, not file
    let error = read_file_content(&conn, &mount_id).expect_err("rejected");

    assert_eq!(error, "file unavailable");
}

#[test]
fn rejects_unsupported_extension() {
    let (_app, _mount, conn, mount_id) = setup_mount_with_files(&[("archive.bin", b"plain text")]);
    let node_id = find_child_id(&conn, &mount_id, "archive.bin");

    let error = read_file_content(&conn, &node_id).expect_err("rejected");

    assert_eq!(error, "not previewable");
}

#[test]
fn rejects_nonexistent_node() {
    let (_app, _mount, conn, _mount_id) = setup_mount_with_files(&[("a.md", b"x")]);

    let error =
        read_file_content(&conn, "00000000-0000-0000-0000-000000000000").expect_err("rejected");

    assert_eq!(error, "file unavailable");
}

#[test]
fn returns_file_unavailable_when_underlying_file_is_missing() {
    let (_app, mount, conn, mount_id) = setup_mount_with_files(&[("vanish.md", b"x")]);
    let node_id = find_child_id(&conn, &mount_id, "vanish.md");

    fs::remove_file(mount.path().join("vanish.md")).expect("remove file");

    let error = read_file_content(&conn, &node_id).expect_err("rejected");

    assert_eq!(error, "file unavailable");
}

#[cfg(unix)]
#[test]
fn rejects_symlink_target_that_escapes_mount_root() {
    use std::os::unix::fs::symlink;

    let app_tempdir = tempdir().expect("app tempdir");
    let mount_tempdir = tempdir().expect("mount tempdir");
    let outside_tempdir = tempdir().expect("outside tempdir");
    let db_path = app_tempdir.path().join("cognios.db");

    // Create a real file outside the mount, then a symlink inside the mount pointing to it.
    let secret = outside_tempdir.path().join("secret.md");
    fs::write(&secret, b"secret").expect("secret file");
    symlink(&secret, mount_tempdir.path().join("escape.md")).expect("symlink");

    let mut conn = open_database(&db_path).expect("database");
    let created = create_mount(
        &mut conn,
        &CreateMountInput {
            path: mount_tempdir.path().to_string_lossy().into_owned(),
            parent_id: None,
            ignore_config: None,
        },
    )
    .expect("mount");

    let snapshot = list_snapshot(&conn).expect("snapshot");
    let escape_node = snapshot
        .roots
        .iter()
        .find(|node| node.id == created.mount_id)
        .and_then(|mount| {
            mount
                .children
                .iter()
                .find(|child| child.name == "escape.md")
        });

    // Some scanners may not surface symlinks at all; if the node exists, it must be rejected.
    if let Some(node) = escape_node {
        let error = read_file_content(&conn, &node.id).expect_err("symlink should be rejected");
        assert_eq!(error, "file unavailable");
    }
}

#[test]
fn returns_file_unavailable_for_non_utf8_contents() {
    // Invalid UTF-8: lone continuation byte
    let (_app, _mount, conn, mount_id) =
        setup_mount_with_files(&[("binary.md", &[0xff, 0xfe, 0xfd])]);
    let node_id = find_child_id(&conn, &mount_id, "binary.md");

    let error = read_file_content(&conn, &node_id).expect_err("rejected");

    assert_eq!(error, "file unavailable");
}

#[test]
fn error_strings_do_not_leak_filesystem_paths() {
    // Regression guard against the get_note_content anti-pattern of returning e.to_string().
    let (_app, _mount, conn, mount_id) = setup_mount_with_files(&[("archive.bin", b"x")]);
    let node_id = find_child_id(&conn, &mount_id, "archive.bin");

    let error = read_file_content(&conn, &node_id).expect_err("rejected");

    assert!(
        !error.contains('/'),
        "error string must not contain filesystem path separators: {error}"
    );
    assert!(
        !error.contains('\\'),
        "error string must not contain filesystem path separators: {error}"
    );
}
