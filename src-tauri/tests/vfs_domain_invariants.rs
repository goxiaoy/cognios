use cognios_lib::infrastructure::db::connection::open_in_memory_database;
use cognios_lib::infrastructure::db::node_repository::{create_folder, CreateFolderInput};

#[test]
fn rejects_blank_folder_names() {
    let conn = open_in_memory_database().expect("in-memory database opens");

    let result = create_folder(
        &conn,
        &CreateFolderInput {
            name: "   ".into(),
            parent_id: None,
        },
    );

    assert!(result.is_err());
}
