use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;
use std::time::{Duration, Instant};

use tempfile::tempdir;

use cognios_lib::infrastructure::db::connection::{open_database, Database};
use cognios_lib::infrastructure::db::url_repository::create_url;
use cognios_lib::infrastructure::db::url_repository::CreateUrlInput;
use cognios_lib::services::url_indexing::queue::UrlJobRunner;

#[test]
fn restart_requeues_failed_or_inflight_url_jobs() {
    let app_tempdir = tempdir().expect("app tempdir");
    let db_path = app_tempdir.path().join("cognios.db");
    let cache_dir = app_tempdir.path().join("url-cache");
    let (url, _handle) = spawn_html_server(vec![r#"
        <html>
          <head><title>Recovered Title</title></head>
          <body><p>Recovered preview text.</p></body>
        </html>
    "#
    .to_string()]);

    let created_url = {
        let mut conn = open_database(&db_path).expect("database");
        create_url(
            &mut conn,
            &CreateUrlInput {
                url,
                parent_id: None,
            },
        )
        .expect("url created")
    };

    {
        let conn = open_database(&db_path).expect("database reopen");
        conn.execute(
            "UPDATE nodes SET state = ?2 WHERE id = ?1",
            [&created_url.node_id, "error"],
        )
        .expect("mark error");
    }

    let runner = UrlJobRunner::new(Database::new(db_path.clone()), cache_dir, |_| {});
    runner.resume_pending_jobs().expect("resume jobs");

    let deadline = Instant::now() + Duration::from_secs(5);
    let mut recovered = false;

    while Instant::now() < deadline {
        let conn = open_database(&db_path).expect("database reopen");
        let (state, title): (String, Option<String>) = conn
            .query_row(
                "
                SELECT n.state, j.title
                FROM nodes n
                INNER JOIN url_jobs j ON j.node_id = n.id
                WHERE n.id = ?1
                ",
                [&created_url.node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("job row");

        if state == "indexed" {
            recovered = true;
            assert_eq!(title.as_deref(), Some("Recovered Title"));
            break;
        }

        thread::sleep(Duration::from_millis(100));
    }

    assert!(recovered, "url job never recovered after restart requeue");
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
