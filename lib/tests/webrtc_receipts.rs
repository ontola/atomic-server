//! Test-owned native host for a real browser RTCDataChannel acceptance journey.
//! The Chromium carrier only moves framed bytes; WebRtcPeerLink, authentication,
//! storage, automatic receipt requests and EmbedHost are production Rust code.
//! This does not exercise the packaged Flutter WebRTC plugin.
#![cfg(all(feature = "db-redb", feature = "iroh"))]

use atomic_lib::host::{embed::EmbedHost, profiles::AgentProfiles, NoPush};
use atomic_lib::runtime::AtomicNode;
use atomic_lib::sync::webrtc_link::WebRtcPeerLink;
use atomic_lib::{Db, Storelike, Value};
use serde_json::{json, Value as Json};
use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;

struct Fixture {
    db: Db,
    host: EmbedHost,
    link: Mutex<Option<Arc<WebRtcPeerLink>>>,
}

impl Fixture {
    async fn link(&self) -> Result<Arc<WebRtcPeerLink>, String> {
        self.link
            .lock()
            .await
            .clone()
            .ok_or("No native WebRTC link".into())
    }

    async fn call(&self, method: &str, args: &Json) -> Result<Json, String> {
        let text = |index: usize| args[index].as_str().ok_or("Expected string argument");
        match method {
            "__test_initialize" => {
                let agent = self
                    .db
                    .load_agent_from_secret(text(0)?)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"agent": agent.agent.subject.to_string()}))
            }
            "__test_link_open" => {
                let (link, challenge) =
                    WebRtcPeerLink::new(self.db.clone(), text(0)?, text(1)?, Some(text(2)?.into()))
                        .map_err(|e| e.to_string())?;
                let old = self.link.lock().await.replace(Arc::new(link));
                if let Some(old) = old {
                    old.close().await;
                }
                Ok(json!(challenge))
            }
            "__test_link_handle" => {
                let bytes: Vec<u8> =
                    serde_json::from_value(args[0].clone()).map_err(|e| e.to_string())?;
                let out = self
                    .link()
                    .await?
                    .handle(&bytes)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({"frames": out.frames, "ready": out.ready}))
            }
            "__test_link_live" => {
                let link = self.link().await?;
                match tokio::time::timeout(Duration::from_secs(1), link.next_live_frames()).await {
                    Ok(result) => Ok(json!(result.map_err(|e| e.to_string())?)),
                    Err(_) => Ok(json!([])),
                }
            }
            "__test_link_reconcile" => Ok(json!(self
                .link()
                .await?
                .reconcile_frame()
                .await
                .map_err(|e| e.to_string())?)),
            "__test_link_close" => {
                if let Some(link) = self.link.lock().await.take() {
                    link.close().await;
                }
                Ok(Json::Null)
            }
            "__test_drive_ready" => Ok(json!(self.db.get_resource(&text(0)?.into()).await.is_ok())),
            "__test_create_file" => self.create_file(text(0)?).await,
            "__test_replace_file" => {
                let subject = text(0)?;
                let content = text(1)?.as_bytes();
                let hash = blake3::hash(content);
                self.db
                    .put_blob(hash.as_bytes(), content)
                    .await
                    .map_err(|e| e.to_string())?;
                let mut file = self
                    .db
                    .get_resource(&subject.into())
                    .await
                    .map_err(|e| e.to_string())?;
                for (property, value) in [
                    (
                        atomic_lib::urls::BLOB,
                        Value::AtomicUrl(
                            atomic_lib::identifiers::blob_subject(hash.to_hex().as_ref())
                                .as_str()
                                .into(),
                        ),
                    ),
                    (
                        atomic_lib::urls::INTERNAL_ID,
                        Value::String(hash.to_hex().to_string()),
                    ),
                    (
                        atomic_lib::urls::FILESIZE,
                        Value::Integer(content.len() as i64),
                    ),
                ] {
                    file.set_unsafe(property.into(), value)
                        .map_err(|e| e.to_string())?;
                }
                file.save_locally(&self.db)
                    .await
                    .map_err(|e| e.to_string())?;
                self.db.flush().map_err(|e| e.to_string())?;
                Ok(json!({"hash": hash.to_hex().to_string()}))
            }
            _ => self
                .host
                .call(method, &args.to_string())
                .await
                .and_then(|value| serde_json::from_str(&value).map_err(|e| e.to_string())),
        }
    }

    async fn create_file(&self, drive: &str) -> Result<Json, String> {
        // The drive must have arrived over the real channel before fixture writes.
        self.db
            .get_resource(&drive.into())
            .await
            .map_err(|e| e.to_string())?;
        let content = b"Real native WebRTC attachment bytes";
        let hash = blake3::hash(content);
        self.db
            .put_blob(hash.as_bytes(), content)
            .await
            .map_err(|e| e.to_string())?;
        let file = self
            .db
            .create_resource(
                atomic_lib::urls::FILE,
                drive,
                "Native WebRTC.txt",
                Some(vec![
                    (
                        atomic_lib::urls::FILENAME,
                        Value::String("Native WebRTC.txt".into()),
                    ),
                    (
                        atomic_lib::urls::FILESIZE,
                        Value::Integer(content.len() as i64),
                    ),
                    (
                        atomic_lib::urls::DOWNLOAD_URL,
                        Value::AtomicUrl(
                            format!("https://native.invalid/download/files/{hash}")
                                .as_str()
                                .into(),
                        ),
                    ),
                    (
                        atomic_lib::urls::INTERNAL_ID,
                        Value::String(hash.to_hex().to_string()),
                    ),
                    (
                        atomic_lib::urls::BLOB,
                        Value::AtomicUrl(
                            atomic_lib::identifiers::blob_subject(hash.to_hex().as_ref())
                                .as_str()
                                .into(),
                        ),
                    ),
                ]),
            )
            .await
            .map_err(|e| e.to_string())?;
        let subject = self
            .db
            .create_resource(
                atomic_lib::urls::FOLDER,
                drive,
                "Native WebRTC evidence",
                None,
            )
            .await
            .map_err(|e| e.to_string())?;
        let mut parent = self
            .db
            .get_resource(&subject.as_str().into())
            .await
            .map_err(|e| e.to_string())?;
        parent
            .set_unsafe(
                atomic_lib::urls::ATTACHMENTS.into(),
                Value::ResourceArray(vec![file.clone().into()]),
            )
            .map_err(|e| e.to_string())?;
        parent
            .save_locally(&self.db)
            .await
            .map_err(|e| e.to_string())?;
        self.db.flush().map_err(|e| e.to_string())?;
        Ok(
            json!({"subject": subject, "file": file, "hash": hash.to_hex().to_string(), "content": String::from_utf8_lossy(content)}),
        )
    }
}

#[tokio::test]
#[ignore = "test-owned JSON-lines native host, driven by Playwright with a real RTCDataChannel"]
async fn native_webrtc_renderer_host() {
    let dir = std::env::temp_dir().join(format!(
        "atomic-webrtc-receipts-{}-{:016x}",
        std::process::id(),
        rand::random::<u64>()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let db = Db::init_redb_file(&dir, None, &dir.join("uploads"))
        .await
        .unwrap();
    let fixture = Arc::new(Fixture {
        host: EmbedHost::new(
            AtomicNode::from_db(db.clone()),
            Arc::new(NoPush),
            AgentProfiles::none(),
        ),
        db,
        link: Mutex::new(None),
    });
    println!("NATIVE_HOST_READY {}", json!({"drive": "", "subject": ""}));
    std::io::stdout().flush().unwrap();
    let (send, mut receive) = tokio::sync::mpsc::channel::<String>(32);
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if send.blocking_send(line).is_err() {
                break;
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = receive.recv().await {
        let request: Json = serde_json::from_str(&line).unwrap();
        if request["method"] == "__test_stop" {
            break;
        }
        let fixture = fixture.clone();
        tasks.spawn(async move {
            let result = fixture
                .call(request["method"].as_str().unwrap(), &request["args"])
                .await;
            let reply = match result {
                Ok(value) => json!({"id": request["id"], "ok": true, "value": value}),
                Err(error) => json!({"id": request["id"], "ok": false, "error": error}),
            };
            println!("NATIVE_HOST_REPLY {reply}");
            std::io::stdout().flush().unwrap();
        });
    }
    if let Some(link) = fixture.link.lock().await.take() {
        link.close().await;
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    drop(fixture);
    std::fs::remove_dir_all(dir).unwrap();
}
