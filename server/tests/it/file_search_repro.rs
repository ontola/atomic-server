//! Regression test: uploading a File and then searching for it with
//! `parents=<drive>&filters=isA:File` (the exact query `FilePickerDialog`
//! issues) must return the file. Filters are exact PropValSub pairs.
//!
//! Run: cargo test -p atomic-server --test it file_search_repro -- --nocapture

use atomic_lib::{client::connected::Client, errors::AtomicResult};

use crate::common::{start_server, wait_for_server};

/// Matches the browser's `escapeTantivyKey` (`browser/lib/src/search.ts`):
/// backslash-escapes every special char, including `.` and `:`.
fn escape_filter_key(key: &str) -> String {
    let mut out = String::with_capacity(key.len());
    for c in key.chars() {
        if "+^`:{}\"[]()!\\* .".contains(c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

async fn run_search(server_url: &str, agent: &atomic_lib::agents::Agent, query: &str) -> String {
    let search_url = format!("{}/search?{}", server_url, query);
    let auth_headers =
        atomic_lib::client::helpers::get_authentication_headers(&search_url, agent).unwrap();
    let mut req = reqwest::Client::new()
        .get(&search_url)
        .header("Accept", "application/ad+json");
    for (k, v) in auth_headers {
        req = req.header(k, v);
    }
    let resp = req.send().await.unwrap();
    resp.text().await.unwrap()
}

#[tokio::test]
async fn uploaded_file_is_findable_via_search() -> AtomicResult<()> {
    let port = start_server("file_search_repro");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{}", port);

    let client = Client::new(&server_url).await?;
    let agent = client.new_agent("Alice").await?;
    let drive = client.new_drive(&agent, "Alice's Drive").await?;

    // Upload a file the same way the browser's FilePicker "Upload" button
    // does: multipart POST to /upload?parent=<drive>, signed with the
    // agent's key.
    let bytes = b"hello file search repro".to_vec();
    let upload_url = format!(
        "{}/upload?parent={}",
        server_url,
        urlencoding::encode(&drive)
    );
    let upload_auth_headers =
        atomic_lib::client::helpers::get_authentication_headers(&upload_url, &agent)?;

    let form = reqwest::multipart::Form::new().part(
        "file",
        reqwest::multipart::Part::bytes(bytes)
            .file_name("hello.txt")
            .mime_str("text/plain")
            .unwrap(),
    );

    let mut upload_req = reqwest::Client::new().post(&upload_url);
    for (k, v) in upload_auth_headers {
        upload_req = upload_req.header(k, v);
    }
    let resp = upload_req
        .multipart(form)
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    println!("upload response ({status}): {body}");
    assert!(status.is_success(), "upload must succeed");

    // Exactly what FilePickerDialog issues: filters built via
    // `escapeTantivyKey`/`buildFilterString`, scoped with `parents=<drive>`.
    let isa_key = escape_filter_key("https://atomicdata.dev/properties/isA");
    let filters = format!(r#"{isa_key}:"https://atomicdata.dev/classes/File""#);

    let both = run_search(
        &server_url,
        &agent,
        &format!(
            "limit=30&filters={}&parents={}",
            urlencoding::encode(&filters),
            urlencoding::encode(&drive)
        ),
    )
    .await;
    println!("--- filters (isA:File) + parents=<drive> ---\n{both}\n");

    assert!(
        both.contains("hello.txt") || both.contains("/files/"),
        "uploaded file should show up in the isA:File + parents search, got: {both}"
    );

    Ok(())
}
