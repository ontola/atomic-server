//! A WebSocket message split over several frames is one message.
//!
//! Chromium streams an outgoing message through a data pipe and sends what it
//! has read as a frame, so a large `COMMIT` (a drive app's entry point carries
//! its whole module, ~170 KB) reaches the server as a first frame with FIN
//! unset followed by continuation frames. actix-web-actors hands those to the
//! handler as `Message::Continuation` and does not join them. The handler used
//! to stop the actor on anything it did not name, dropping the TCP socket with
//! no Close frame: the browser saw `1006`, went "Working offline" mid-install,
//! and queued everything after it for a reconnect drain.
//!
//! Run: cargo test -p atomic-server --test it ws_fragmented

use atomic_lib::{client::connected::Client, errors::AtomicResult, sync::protocol};
use futures_util::{SinkExt, StreamExt};
use std::time::Duration;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{
        protocol::frame::{
            coding::{Data, OpCode},
            Frame,
        },
        Message,
    },
};

use crate::common::{start_server, wait_for_server};

/// A signed genesis commit under `parent` whose description is `padding`
/// bytes long, so the frame carrying it is as large as a real app's.
async fn large_genesis_commit(
    client: &Client,
    signer: &atomic_lib::agents::Agent,
    parent: &str,
    padding: usize,
) -> AtomicResult<String> {
    let mut builder = atomic_lib::commit::CommitBuilder::new("placeholder".into());
    builder.set(
        atomic_lib::urls::NAME.into(),
        atomic_lib::Value::String("Large".into()),
    );
    builder.set(
        atomic_lib::urls::DESCRIPTION.into(),
        // Random words, so Loro cannot compress it away.
        atomic_lib::Value::Markdown(
            (0..padding / 9)
                .map(|_| atomic_lib::utils::random_string(8))
                .collect::<Vec<_>>()
                .join(" "),
        ),
    );
    builder.set(
        atomic_lib::urls::PARENT.into(),
        atomic_lib::Value::AtomicUrl(parent.into()),
    );
    let commit = atomic_lib::commit::Commit::create_did(builder, signer, client.store()).await?;
    atomic_lib::client::commit_to_wire_json(&commit, client.store()).await
}

#[tokio::test]
async fn a_commit_sent_in_continuation_frames_is_applied() -> AtomicResult<()> {
    let port = start_server("ws_fragmented");
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");

    let client = Client::new(&server_url).await?;
    let alice = client.new_agent("Alice").await?;
    let drive = client.new_drive(&alice, "Fragmented").await?;

    let commit = large_genesis_commit(&client, &alice, &drive, 96 * 1024).await?;
    let frame = protocol::encode_commit(7, &commit);
    assert!(
        frame.len() > 64 * 1024,
        "the frame needs more than one fragment"
    );

    let (mut ws, _) = connect_async(&ws_url)
        .await
        .map_err(|e| format!("connect: {e}"))?;

    // Several fragments, the way Chromium sends a message it reads from its
    // data pipe piece by piece.
    let chunks: Vec<&[u8]> = frame.chunks(32 * 1024).collect();
    for (i, chunk) in chunks.iter().enumerate() {
        let opcode = if i == 0 {
            OpCode::Data(Data::Binary)
        } else {
            OpCode::Data(Data::Continue)
        };
        let fin = i == chunks.len() - 1;
        ws.send(Message::Frame(Frame::message(chunk.to_vec(), opcode, fin)))
            .await
            .map_err(|e| format!("send fragment {i}: {e}"))?;
    }

    let answer = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(message) = ws.next().await {
            match message {
                Ok(Message::Binary(bin)) if bin.first() == Some(&protocol::tag::COMMIT_OK) => {
                    return Ok(u16::from_be_bytes([bin[1], bin[2]]));
                }
                Ok(Message::Binary(bin)) if bin.first() == Some(&protocol::tag::ERROR) => {
                    return Err(format!(
                        "refused: {}",
                        String::from_utf8_lossy(&bin[5.min(bin.len())..])
                    ));
                }
                Ok(Message::Close(frame)) => return Err(format!("closed: {frame:?}")),
                Ok(_) => continue,
                Err(e) => return Err(format!("socket dropped: {e}")),
            }
        }

        Err("socket ended without an answer".to_string())
    })
    .await
    .map_err(|_| "no COMMIT_OK within 10s".to_string())??;

    assert_eq!(answer, 7, "the COMMIT_OK answers the fragmented COMMIT");

    Ok(())
}
