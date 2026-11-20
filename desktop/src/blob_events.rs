//! Tell the main webview when independently transferred file bytes arrive.

use tokio::sync::broadcast::{error::RecvError, Receiver};

pub(crate) const EVENT: &str = "atomic-file-content-stored";

pub(crate) async fn relay(mut writes: Receiver<[u8; 32]>, mut emit: impl FnMut(serde_json::Value)) {
  loop {
    let hash = match writes.recv().await {
      Ok(hash) => Some(
        hash
          .iter()
          .map(|byte| format!("{byte:02x}"))
          .collect::<String>(),
      ),
      Err(RecvError::Lagged(_)) => None,
      Err(RecvError::Closed) => break,
    };
    emit(serde_json::json!({ "hash": hash }));
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::sync::broadcast;

  #[test]
  fn relay_emits_only_the_lowercase_content_hash() {
    let runtime = tokio::runtime::Builder::new_current_thread()
      .build()
      .unwrap();
    let (sender, receiver) = broadcast::channel(2);
    sender.send([0xab; 32]).unwrap();
    drop(sender);
    let mut emitted = Vec::new();
    runtime.block_on(relay(receiver, |payload| emitted.push(payload)));
    assert_eq!(
      emitted,
      vec![serde_json::json!({ "hash": "ab".repeat(32) })]
    );
  }

  #[test]
  fn relay_reports_lag_before_the_remaining_hashes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
      .build()
      .unwrap();
    let (sender, receiver) = broadcast::channel(1);
    sender.send([1; 32]).unwrap();
    sender.send([2; 32]).unwrap();
    drop(sender);
    let mut emitted = Vec::new();
    runtime.block_on(relay(receiver, |payload| emitted.push(payload)));
    assert_eq!(
      emitted,
      vec![
        serde_json::json!({ "hash": null }),
        serde_json::json!({ "hash": "02".repeat(32) }),
      ]
    );
  }
}
