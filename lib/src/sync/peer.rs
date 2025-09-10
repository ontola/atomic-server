//! Iroh peer-to-peer transport for the v2 binary protocol.
//!
//! Any device running atomic-lib with the `iroh` feature becomes a peer node.
//! Peers connect via NodeID — no port forwarding, DNS, or TLS needed.

use crate::{agents::ForAgent, Db};
use iroh::{protocol::Router, Endpoint, NodeId};
use std::sync::OnceLock;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// ALPN protocol identifier for Atomic Data over Iroh.
const ATOMIC_ALPN: &[u8] = b"atomic/1";

/// Global NodeID, set once on startup.
static NODE_ID: OnceLock<String> = OnceLock::new();

/// Returns the Iroh NodeID if the peer node is running.
pub fn get_node_id() -> Option<&'static str> {
    NODE_ID.get().map(|s| s.as_str())
}

/// Start the Iroh peer node. Returns the NodeID and a Router that must be kept alive.
pub async fn start(store: Db) -> anyhow::Result<(NodeId, Router)> {
    let endpoint = Endpoint::builder().discovery_n0().bind().await?;

    let node_id = endpoint.node_id();
    NODE_ID.set(node_id.to_string()).ok();
    tracing::info!("Iroh NodeID: {node_id}");

    let router = Router::builder(endpoint)
        .accept(ATOMIC_ALPN, AtomicHandler { store })
        .spawn();

    Ok((node_id, router))
}

#[derive(Debug, Clone)]
struct AtomicHandler {
    store: Db,
}

impl iroh::protocol::ProtocolHandler for AtomicHandler {
    fn accept(
        &self,
        connection: iroh::endpoint::Connection,
    ) -> futures::future::BoxFuture<'static, anyhow::Result<()>> {
        let store = self.store.clone();
        Box::pin(async move {
            let remote = connection.remote_node_id()?;
            tracing::info!("Iroh connection from {remote}");

            loop {
                let (send, recv) = match connection.accept_bi().await {
                    Ok(pair) => pair,
                    Err(_) => break,
                };

                let store = store.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_stream(send, recv, store).await {
                        tracing::debug!("Iroh stream ended: {e}");
                    }
                });
            }

            Ok(())
        })
    }
}

/// Handle a single bidirectional QUIC stream.
/// Reads length-prefixed v2 binary frames and dispatches them via the sync engine.
async fn handle_stream(
    mut send: iroh::endpoint::SendStream,
    mut recv: iroh::endpoint::RecvStream,
    store: Db,
) -> anyhow::Result<()> {
    let mut agent = ForAgent::Public;

    loop {
        let len = match recv.read_u32().await {
            Ok(n) => n as usize,
            Err(_) => break,
        };

        if len == 0 || len > 10_000_000 {
            break;
        }

        let mut buf = vec![0u8; len];
        recv.read_exact(&mut buf).await?;

        let responses = super::engine::handle_frame(&buf, &store, &mut agent).await;

        for response in responses {
            send.write_u32(response.len() as u32).await?;
            send.write_all(&response).await?;
        }
    }

    Ok(())
}
