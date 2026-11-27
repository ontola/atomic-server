//! Explicit, authenticated storage barriers; ordinary commit responses remain
//! acceptance acknowledgements. All resource proof checks live in atomic-lib.
use crate::{
    appstate::AppState,
    errors::{AtomicServerError, AtomicServerResult},
};
use actix_web::{web, HttpRequest, HttpResponse};
use atomic_lib::{
    agents::ForAgent,
    errors::AtomicResult,
    sync::protocol::{StorageReceipt, StorageReceiptRequest, STORAGE_RECEIPT_MAX_FRAME},
    Db,
};
use futures::StreamExt;

pub const CAPABILITY_HEADER: &str = "X-Atomic-Storage-Receipts";

/// Keep the synchronous persistent flush off Actix's request/actor worker.
pub(crate) async fn produce(
    store: Db,
    agent: ForAgent,
    request: StorageReceiptRequest,
    load: crate::write_load::WriteGuard,
) -> AtomicResult<Option<StorageReceipt>> {
    let runtime = tokio::runtime::Handle::current();
    actix_web::rt::task::spawn_blocking(move || {
        // The blocking operation can outlive a disconnected HTTP/WS caller.
        // Keep admission occupied until the actual barrier has finished.
        let _load = load;
        runtime.block_on(atomic_lib::sync::storage_receipts::produce_receipt(
            &store,
            &agent,
            &request.drive,
            &request,
        ))
    })
    .await
    .map_err(|error| format!("Storage receipt task failed: {error}"))?
}

pub async fn post_storage_receipt(
    appstate: web::Data<AppState>,
    req: HttpRequest,
    context: crate::context::RequestContext,
    mut payload: web::Payload,
) -> AtomicServerResult<HttpResponse> {
    // Bound the stream before deserializing or buffering the entire request.
    let mut body = web::BytesMut::new();
    while let Some(chunk) = payload.next().await {
        let chunk = chunk.map_err(|error| AtomicServerError::bad_request(error.to_string()))?;
        if body.len().saturating_add(chunk.len()) >= STORAGE_RECEIPT_MAX_FRAME {
            return Err(AtomicServerError::bad_request(
                "Storage receipt request is too large",
            ));
        }
        body.extend_from_slice(&chunk);
    }
    let request = StorageReceiptRequest::decode(&body)
        .ok_or_else(|| AtomicServerError::bad_request("Invalid storage receipt request"))?;
    let agent = crate::helpers::authenticate(&req, &appstate, &context, &body).await?;
    if matches!(agent, ForAgent::Public) {
        return Err(atomic_lib::AtomicError::unauthorized(
            "Storage receipts require authentication".into(),
        )
        .into());
    }
    // A flush spends the same authenticated rate/load budget as other writes.
    // Hold the load guard until completion, including the disk barrier.
    crate::helpers::enforce_write_rate_limit(&appstate, &req, &agent)?;
    let load = appstate
        .write_load
        .try_begin()
        .map_err(AtomicServerError::busy)?;
    let receipt = produce(appstate.store.clone(), agent, request, load)
        .await
        .map_err(|error| {
            if error.to_string() == "Receipt subject outside session drive" {
                AtomicServerError::bad_request(error.to_string())
            } else {
                error.into()
            }
        })?;
    Ok(match receipt {
        Some(receipt) => HttpResponse::Ok()
            .insert_header(("Cache-Control", crate::helpers::NO_STORE))
            .json(receipt),
        None => HttpResponse::NoContent()
            .insert_header(("Cache-Control", crate::helpers::NO_STORE))
            .finish(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::db::{
        kv_store::{KvIter, KvStore, ReplicaIdentity},
        trees::{Operation, Tree},
    };
    use std::sync::{Arc, Condvar, Mutex};

    struct HeldFlush {
        inner: Arc<dyn KvStore>,
        started: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
        release: Arc<(Mutex<bool>, Condvar)>,
    }
    impl KvStore for HeldFlush {
        fn replica_identity(&self, scope: &str) -> AtomicResult<Option<ReplicaIdentity>> {
            self.inner.replica_identity(scope)
        }
        fn get(&self, tree: Tree, key: &[u8]) -> AtomicResult<Option<Vec<u8>>> {
            self.inner.get(tree, key)
        }
        fn insert(&self, tree: Tree, key: &[u8], val: &[u8]) -> AtomicResult<()> {
            self.inner.insert(tree, key, val)
        }
        fn remove(&self, tree: Tree, key: &[u8]) -> AtomicResult<()> {
            self.inner.remove(tree, key)
        }
        fn contains_key(&self, tree: Tree, key: &[u8]) -> AtomicResult<bool> {
            self.inner.contains_key(tree, key)
        }
        fn scan_prefix(&self, tree: Tree, prefix: &[u8]) -> KvIter {
            self.inner.scan_prefix(tree, prefix)
        }
        fn range(&self, tree: Tree, start: Vec<u8>, end: Vec<u8>, reverse: bool) -> KvIter {
            self.inner.range(tree, start, end, reverse)
        }
        fn iter_tree(&self, tree: Tree) -> KvIter {
            self.inner.iter_tree(tree)
        }
        fn clear_tree(&self, tree: Tree) -> AtomicResult<()> {
            self.inner.clear_tree(tree)
        }
        fn apply_batch(&self, ops: &[Operation]) -> AtomicResult<()> {
            self.inner.apply_batch(ops)
        }
        fn len(&self, tree: Tree) -> AtomicResult<usize> {
            self.inner.len(tree)
        }
        fn flush(&self) -> AtomicResult<()> {
            if let Some(started) = self.started.lock().unwrap().take() {
                let _ = started.send(());
            }
            let (lock, wake) = &*self.release;
            let (released, timeout) = wake
                .wait_timeout_while(
                    lock.lock().unwrap(),
                    std::time::Duration::from_secs(10),
                    |released| !*released,
                )
                .unwrap();
            if timeout.timed_out() || !*released {
                return Err("test flush release timed out".into());
            }
            self.inner.flush()
        }
    }

    #[tokio::test]
    async fn canceled_receipt_caller_keeps_flush_admitted_until_actual_completion() {
        let mut db = Db::init_temp(&format!(
            "receipt-cancellation-{}",
            atomic_lib::utils::random_string(10)
        ))
        .await
        .unwrap();
        let (agent, drive) = db.setup("Owner").await.unwrap();
        let doc = atomic_lib::loro::AtomicLoroDoc::from_snapshot(
            &db.get_loro_snapshot(&drive.as_str().into()).unwrap(),
        )
        .unwrap();
        let request = StorageReceiptRequest {
            nonce: "a".repeat(64),
            subject: drive.clone(),
            drive,
            version: atomic_lib::agents::encode_base64(&doc.doc().state_vv().encode()),
        };
        let (started, barrier_started) = tokio::sync::oneshot::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        db.kv = Arc::new(HeldFlush {
            inner: db.kv.clone(),
            started: Mutex::new(Some(started)),
            release: release.clone(),
        });
        let load = crate::write_load::WriteLoad::new(0, 1);
        let guard = load.try_begin().unwrap();
        let task = tokio::spawn(produce(
            db,
            ForAgent::AgentSubject(agent.subject),
            request,
            guard,
        ));
        tokio::time::timeout(std::time::Duration::from_secs(5), barrier_started)
            .await
            .unwrap()
            .unwrap();
        task.abort();
        let _ = task.await;
        let still_admitted = load.in_flight();
        let extra_refused = load.try_begin().is_err();
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        assert_eq!(
            still_admitted, 1,
            "disconnect must not release a running blocking flush"
        );
        assert!(extra_refused);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while load.in_flight() != 0 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert!(load.try_begin().is_ok());
    }
}
