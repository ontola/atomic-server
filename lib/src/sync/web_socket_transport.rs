//! [`AtomicTransport`] over the browser's `WebSocket`, for wasm32 apps that
//! cannot use `tokio-tungstenite` (the `ws` feature). Frames are binary with
//! `binaryType = "arraybuffer"`; text messages are ignored, as the v2 protocol
//! only uses binary frames. Works on the main thread and in workers.

use std::cell::RefCell;
use std::rc::Rc;

use tokio::sync::{mpsc, oneshot};
use wasm_bindgen::prelude::*;
use web_sys::{BinaryType, CloseEvent, MessageEvent, WebSocket};

use super::transport::AtomicTransport;
use crate::errors::AtomicResult;

/// What the socket callbacks queue for `recv`.
enum Incoming {
    Frame(Vec<u8>),
    /// Closed; `true` for a clean close (`CloseEvent.wasClean`).
    Closed(bool),
}

pub struct WebSocketTransport {
    ws: WebSocket,
    rx: mpsc::UnboundedReceiver<Incoming>,
    closed: bool,
    // Kept alive for as long as the socket can call them.
    _on_message: Closure<dyn FnMut(MessageEvent)>,
    _on_close: Closure<dyn FnMut(CloseEvent)>,
    _on_open: Closure<dyn FnMut()>,
    _on_error: Closure<dyn FnMut()>,
}

// Safety: wasm32 without threads (the only place this type exists) has a
// single thread, so a `WebSocket` and its closures never cross threads; the
// impl only satisfies the `Send` bound on `AtomicTransport`, like `OpfsBackend`.
unsafe impl Send for WebSocketTransport {}

impl WebSocketTransport {
    /// Open `url` (`ws://` or `wss://`) and wait until the connection is up.
    pub async fn connect(url: &str) -> AtomicResult<Self> {
        let ws = WebSocket::new(url).map_err(|e| format!("WebSocket::new failed: {e:?}"))?;
        ws.set_binary_type(BinaryType::Arraybuffer);

        let (tx, rx) = mpsc::unbounded_channel();
        let (open_tx, open_rx) = oneshot::channel::<Result<(), String>>();
        let open_tx = Rc::new(RefCell::new(Some(open_tx)));

        let tx_msg = tx.clone();
        let on_message = Closure::<dyn FnMut(MessageEvent)>::new(move |ev: MessageEvent| {
            if let Ok(buf) = ev.data().dyn_into::<js_sys::ArrayBuffer>() {
                let _ = tx_msg.send(Incoming::Frame(js_sys::Uint8Array::new(&buf).to_vec()));
            }
        });
        let open_tx_close = open_tx.clone();
        let on_close = Closure::<dyn FnMut(CloseEvent)>::new(move |ev: CloseEvent| {
            if let Some(o) = open_tx_close.borrow_mut().take() {
                let _ = o.send(Err(format!("closed before open (code {})", ev.code())));
            }
            let _ = tx.send(Incoming::Closed(ev.was_clean()));
        });
        let open_tx_open = open_tx.clone();
        let on_open = Closure::<dyn FnMut()>::new(move || {
            if let Some(o) = open_tx_open.borrow_mut().take() {
                let _ = o.send(Ok(()));
            }
        });
        // `error` carries no detail; a `close` always follows it.
        let on_error = Closure::<dyn FnMut()>::new(move || {
            if let Some(o) = open_tx.borrow_mut().take() {
                let _ = o.send(Err("WebSocket error".into()));
            }
        });

        ws.set_onmessage(Some(on_message.as_ref().unchecked_ref()));
        ws.set_onclose(Some(on_close.as_ref().unchecked_ref()));
        ws.set_onopen(Some(on_open.as_ref().unchecked_ref()));
        ws.set_onerror(Some(on_error.as_ref().unchecked_ref()));

        let transport = Self {
            ws,
            rx,
            closed: false,
            _on_message: on_message,
            _on_close: on_close,
            _on_open: on_open,
            _on_error: on_error,
        };
        // On failure `transport` drops here and closes the socket.
        open_rx
            .await
            .map_err(|_| "WebSocket dropped while connecting".to_string())??;
        Ok(transport)
    }
}

impl Drop for WebSocketTransport {
    fn drop(&mut self) {
        self.ws.set_onmessage(None);
        self.ws.set_onclose(None);
        self.ws.set_onopen(None);
        self.ws.set_onerror(None);
        let _ = self.ws.close();
    }
}

impl AtomicTransport for WebSocketTransport {
    async fn send(&mut self, frame: Vec<u8>) -> AtomicResult<()> {
        self.ws
            .send_with_u8_array(&frame)
            .map_err(|e| format!("WebSocket send failed: {e:?}").into())
    }

    async fn recv(&mut self) -> AtomicResult<Option<Vec<u8>>> {
        if self.closed {
            return Ok(None);
        }
        match self.rx.recv().await {
            Some(Incoming::Frame(f)) => Ok(Some(f)),
            Some(Incoming::Closed(clean)) => {
                self.closed = true;
                if clean {
                    Ok(None)
                } else {
                    Err("WebSocket closed uncleanly".into())
                }
            }
            None => Ok(None),
        }
    }
}
