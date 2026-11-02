//! The native end of a browser WebRTC peer link: the app's `flutter_webrtc`
//! data channel carries the frames, `WebRtcPeerLink` decides what they mean.
//! See `planning/flutter-webrtc-peer.md`.

use atomic_lib::sync::webrtc_link::WebRtcPeerLink;
use flutter_rust_bridge::frb;

#[frb(opaque)]
pub struct WebRtcLink(WebRtcPeerLink);

#[frb(non_opaque)]
pub struct WebRtcLinkStart {
    pub link: WebRtcLink,
    pub challenge: Vec<u8>,
}

pub struct WebRtcLinkOutput {
    pub frames: Vec<Vec<u8>>,
    pub changed: Vec<String>,
    pub ready: bool,
}

pub async fn open_webrtc_link(
    drive: String,
    binding: String,
    expected_peer: Option<String>,
) -> Result<WebRtcLinkStart, String> {
    let store = super::state::default_store()?.db.as_ref().clone();
    let (link, challenge) =
        WebRtcPeerLink::new(store, &drive, &binding, expected_peer).map_err(|e| e.to_string())?;
    Ok(WebRtcLinkStart {
        link: WebRtcLink(link),
        challenge,
    })
}

impl WebRtcLink {
    pub async fn handle(&self, frame: Vec<u8>) -> Result<WebRtcLinkOutput, String> {
        let out = self.0.handle(&frame).await.map_err(|e| e.to_string())?;
        Ok(WebRtcLinkOutput {
            frames: out.frames,
            changed: out.changed,
            ready: out.ready,
        })
    }

    pub async fn reconcile_frame(&self) -> Result<Option<Vec<u8>>, String> {
        self.0.reconcile_frame().await.map_err(|e| e.to_string())
    }

    pub async fn next_live_frames(&self) -> Result<Vec<Vec<u8>>, String> {
        self.0.next_live_frames().await.map_err(|e| e.to_string())
    }

    pub async fn close(&self) {
        self.0.close().await
    }
}
