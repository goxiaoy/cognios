use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::open_database;
use cognios_lib::infrastructure::db::node_repository::{
    create_folder, list_snapshot, CreateFolderInput,
};

#[test]
fn persists_root_and_nested_folders_across_connections() {
    let tempdir = tempdir().expect("tempdir");
    let db_path = tempdir.path().join("cognios.db");

    {
        let conn = open_database(&db_path).expect("database opens");
        let root_snapshot = create_folder(
            &conn,
            &CreateFolderInput {
                name: "Inbox".into(),
                parent_id: None,
            },
        )
        .expect("root folder is created");
        let root_id = root_snapshot.roots[0].id.clone();

        create_folder(
            &conn,
            &CreateFolderInput {
                name: "Nested".into(),
                parent_id: Some(root_id),
            },
        )
        .expect("nested folder is created");
    }

    let reopened = open_database(&db_path).expect("database reopens");
    let snapshot = list_snapshot(&reopened).expect("snapshot loads");

    assert_eq!(snapshot.roots.len(), 1);
    assert_eq!(snapshot.roots[0].name, "Inbox");
    assert_eq!(snapshot.roots[0].children.len(), 1);
    assert_eq!(snapshot.roots[0].children[0].name, "Nested");
}
