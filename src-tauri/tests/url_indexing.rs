use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::{open_database, Database};
use cognios_lib::infrastructure::db::node_repository::list_snapshot;
use cognios_lib::infrastructure::db::url_repository::create_url;
use cognios_lib::infrastructure::db::url_repository::CreateUrlInput;
use cognios_lib::services::url_indexing::queue::UrlJobRunner;

type UrlMetadataRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
);

#[test]
fn url_node_appears_immediately_and_is_indexed_in_background() {
    let app_tempdir = tempdir().expect("app tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let cache_dir = app_tempdir.path().join("url-cache");
    let (url, _handle) = spawn_html_server(vec![r#"
        <html>
          <head>
            <title>Example Title</title>
            <meta name="description" content="Example description" />
            <link rel="canonical" href="https://example.test/canonical" />
          </head>
          <body>
            <h1>Heading</h1>
            <p>This is a readable preview for CogniOS indexing.</p>
          </body>
        </html>
    "#
    .to_string()]);

    let created_url = {
        let mut conn = open_database(&db_path).expect("database");
        create_url(
            &mut conn,
            &CreateUrlInput {
                url: url.clone(),
                parent_id: None,
            },
        )
        .expect("url created")
    };

    let pending_node = created_url
        .snapshot
        .roots
        .iter()
        .find(|node| node.id == created_url.node_id)
        .expect("pending node");
    assert_eq!(pending_node.kind, "url");
    assert_eq!(pending_node.state, "pending");
    assert_eq!(pending_node.name, url);

    let runner = UrlJobRunner::new(Database::new(db_path.clone()), cache_dir, |_| {});
    runner
        .enqueue(created_url.node_id.clone())
        .expect("job queued");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut indexed = false;

    while Instant::now() < deadline {
        let conn = open_database(&db_path).expect("database reopen");
        let snapshot = list_snapshot(&conn).expect("snapshot");
        let node = snapshot
            .roots
            .iter()
            .find(|root| root.id == created_url.node_id)
            .expect("indexed node");

        if node.state == "indexed" {
            indexed = true;
            assert_eq!(node.name, "Example Title");

            let (title, description, preview_text, canonical_url, cache_path): UrlMetadataRow =
                conn.query_row(
                    "
                    SELECT title, description, preview_text, canonical_url, html_cache_path
                    FROM urls
                    WHERE node_id = ?1
                    ",
                    [&created_url.node_id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .expect("url metadata");

            assert_eq!(title.as_deref(), Some("Example Title"));
            assert_eq!(description.as_deref(), Some("Example description"));
            assert!(preview_text
                .unwrap_or_default()
                .contains("readable preview"));
            assert_eq!(
                canonical_url.as_deref(),
                Some("https://example.test/canonical")
            );
            assert!(std::path::Path::new(&cache_path.expect("cache path")).exists());
            break;
        }

        thread::sleep(Duration::from_millis(100));
    }

    assert!(indexed, "url job never reached indexed state");
}

fn spawn_html_server(responses: Vec<String>) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("listener");
    let address = listener.local_addr().expect("local addr");
    let handle = thread::spawn(move || {
        for response_body in responses {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buffer = [0_u8; 1024];
                let _ = stream.read(&mut buffer);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                let _ = stream.write_all(response.as_bytes());
            }
        }
    });

    (format!("http://{}", address), handle)
}
