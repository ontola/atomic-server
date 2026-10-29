//! One end of a WebRTC peer link, for a native node (the Flutter app).
//!
//! The browser drives its side of a link from TypeScript (`BrowserPeerSync`):
//! it opens an ordered data channel, exchanges a channel-bound `CHALLENGE`,
//! answers it with a signed `AUTH`, then reconciles with `SYNC` every two
//! seconds and forwards its own commits. Everything the browser does with
//! *received* frames is [`BrowserPeerSession`]. This type is the other half
//! for a host that has an agent key and an `atomic_lib` database but no
//! TypeScript: frames in, frames out, the host only moves bytes (the data
//! channel and the signalling are the host's).
//!
//! There is no second sync implementation here. Inbound frames go through the
//! same [`BrowserPeerSession`] the browser's WASM node uses, so drive scope,
//! rights and signed-commit checks are identical. What this adds is the
//! initiating half of the handshake, the `SYNC` the browser builds in
//! `computeDriveSyncState`, and forwarding of local writes.
//!
//! Discovery is not authorization: nothing the data channel carries is
//! trusted before the peer's `AUTH` verifies against this drive's ACLs.
//!
//! The protocol, as the browser speaks it (`browser/lib/src/browser-peer-sync.ts`):
//!
//! 1. both sides send `CHALLENGE` = `{binding}:{64 hex}`, `binding` being the
//!    SHA-256 over both DTLS certificate fingerprints (computed by the host
//!    from the SDPs, see `docs/src/browser-peer-sync.md`);
//! 2. each answers the other's challenge with `AUTH` over `{drive}#{challenge}`;
//! 3. each acknowledges a verified `AUTH` with `AUTH_OK`;
//! 4. once it has verified the peer's `AUTH` and received its `AUTH_OK`, a side
//!    is *ready*: the host then sends [`WebRtcPeerLink::reconcile_frame`]
//!    periodically and the frames of [`WebRtcPeerLink::next_live_frames`].

use super::browser_peer::BrowserPeerSession;
use super::{engine, protocol, ws_apply};
use crate::agents::Agent;
use crate::db::EphemeralEvent;
use crate::errors::AtomicResult;
use crate::{Db, DbEvent, Storelike};
use tokio::sync::{broadcast, Mutex, Notify};

/// A peer's CHALLENGE is `{64 hex}:{64 hex}`; the browser refuses more.
const MAX_CHALLENGE_FRAME: usize = 256;

/// What handling one inbound frame produced.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct PeerLinkOutput {
    /// Frames to send back over the channel, in order.
    pub frames: Vec<Vec<u8>>,
    /// Subjects that changed locally because of the frame.
    pub changed: Vec<String>,
    /// A presence frame for the UI, when the peer sent one.
    pub ephemeral: Option<Vec<u8>>,
    /// Both directions are authenticated; reconcile and live frames may flow.
    pub ready: bool,
}

struct LinkState {
    session: BrowserPeerSession,
    challenged: bool,
    accepted: bool,
    authenticated: bool,
}

impl LinkState {
    fn ready(&self) -> bool {
        self.challenged && self.accepted && self.authenticated
    }
}

/// One authenticated-or-authenticating conversation with one remote peer about
/// one drive. Methods take `&self` so a host can await [`Self::next_live_frames`]
/// while feeding [`Self::handle`].
pub struct WebRtcPeerLink {
    db: Db,
    agent: Agent,
    drive: String,
    binding: String,
    /// Names this link as the source of what it imports, so the live loop
    /// does not echo it back.
    source: String,
    state: Mutex<LinkState>,
    events: Mutex<broadcast::Receiver<DbEvent>>,
    /// Presence announced on this node (by the app, or relayed from the server
    /// or another kind of link), waiting to go out to this peer.
    ephemeral: Mutex<broadcast::Receiver<EphemeralEvent>>,
    /// Wakes a pending [`Self::next_live_frames`] when the host closes the link.
    closed: Notify,
}

impl WebRtcPeerLink {
    /// Start a link. Returns the link and the `CHALLENGE` frame to send first.
    ///
    /// `binding` is the 64 hex characters that tie this link to the two DTLS
    /// certificates. `expected_peer` pins the remote agent (an invitation's
    /// issuer); needed to bootstrap a drive this node does not hold yet, and
    /// unused otherwise, as the browser does.
    pub fn new(
        db: Db,
        drive: &str,
        binding: &str,
        expected_peer: Option<String>,
    ) -> AtomicResult<(Self, Vec<u8>)> {
        if binding.len() != 64 || !binding.bytes().all(is_lower_hex) {
            return Err("Channel binding must be 64 lowercase hex characters".into());
        }
        // The browser keys rooms and proofs on the canonical spelling.
        let drive = crate::identifiers::canonicalize_scheme(drive);
        let agent = db.get_default_agent()?;
        if agent.private_key.is_none() {
            return Err("Peer links need an agent with its private key".into());
        }
        let challenge = format!("{binding}:{}", protocol::new_challenge_nonce());
        let session = BrowserPeerSession::new(drive.clone(), expected_peer, challenge.clone())?;
        let events = Mutex::new(db.subscribe_events());
        let ephemeral = Mutex::new(db.subscribe_ephemeral());
        let source = format!("webrtc:{}", &challenge[64..80]);
        Ok((
            Self {
                db,
                agent,
                drive,
                binding: binding.to_string(),
                source,
                state: Mutex::new(LinkState {
                    session,
                    challenged: false,
                    accepted: false,
                    authenticated: false,
                }),
                events,
                ephemeral,
                closed: Notify::new(),
            },
            protocol::encode_challenge(&challenge),
        ))
    }

    /// End the link: nothing more is forwarded, and a pending
    /// [`Self::next_live_frames`] returns an error. Call it before dropping
    /// the link, so no task is left waiting on the store.
    pub async fn close(&self) {
        // `notify_one` keeps the permit when nobody waits yet.
        self.closed.notify_one();
        let mut state = self.state.lock().await;
        state.challenged = false;
    }

    /// The canonical drive subject this link syncs.
    pub fn drive(&self) -> &str {
        &self.drive
    }

    /// Handle one frame received from the peer. An error ends the link: close
    /// the channel and let the host redial with backoff.
    pub async fn handle(&self, frame: &[u8]) -> AtomicResult<PeerLinkOutput> {
        let mut state = self.state.lock().await;
        let tag = *frame.first().ok_or("Empty peer frame")?;
        let mut out = PeerLinkOutput::default();
        match tag {
            protocol::tag::CHALLENGE => {
                if state.challenged || frame.len() > MAX_CHALLENGE_FRAME {
                    return Err("Invalid peer challenge".into());
                }
                let remote = protocol::decode_challenge(&frame[1..]).ok_or("Invalid challenge")?;
                let (binding, nonce) = remote.split_once(':').ok_or("Invalid challenge")?;
                if binding != self.binding {
                    return Err("WebRTC channel binding mismatch".into());
                }
                if nonce.len() != 64 || !nonce.bytes().all(is_lower_hex) {
                    return Err("Invalid peer challenge".into());
                }
                state.challenged = true;
                out.frames.push(protocol::encode_auth(
                    &self.agent,
                    &format!("{}#{remote}", self.drive),
                )?);
            }
            protocol::tag::AUTH_OK => {
                if !state.challenged || state.accepted {
                    return Err("Unexpected authentication acknowledgement".into());
                }
                state.accepted = true;
            }
            _ => {
                let result = ws_apply::import_scope(
                    Some(self.source.clone()),
                    state.session.handle(&self.db, frame),
                )
                .await?;
                self.db.flush()?;
                if tag == protocol::tag::AUTH {
                    state.authenticated = true;
                }
                out.frames = result.frames;
                out.changed = result.changed;
                // The frame was admitted by the session (right agent, right
                // drive, readable). Hand it to everything on this node that
                // listens, the presence hub first, and keep returning it for
                // callers that route it themselves.
                if let Some(frame) = &result.ephemeral {
                    if let Some(decoded) = frame.get(1..).and_then(protocol::decode_ephemeral) {
                        self.db.publish_ephemeral(EphemeralEvent {
                            kind: decoded.kind,
                            drive: decoded.drive,
                            agent: decoded.agent,
                            payload: decoded.payload,
                            from_peer: self.source.clone(),
                        });
                    }
                }
                out.ephemeral = result.ephemeral;
            }
        }
        out.ready = state.ready();
        Ok(out)
    }

    /// The `SYNC` frame that tells the peer what this node holds of the drive,
    /// built as the browser's `computeDriveSyncState` does. Send it right
    /// after the link is ready and then about every two seconds: it is the
    /// catch-up path for everything the live frames miss. `None` before ready.
    pub async fn reconcile_frame(&self) -> AtomicResult<Option<Vec<u8>>> {
        let state = self.state.lock().await;
        if !state.ready() {
            return Ok(None);
        }
        let drive = crate::Subject::from_raw(&self.drive, self.db.get_base_domain().as_deref());
        let subjects = engine::collect_drive_subjects(&self.db, &drive).await;
        let vvs = engine::build_drive_vvs(&self.db, &subjects);
        // The browser stops a link whose peer lost read access.
        if !vvs.is_empty() && !state.session.can_send(&self.db, &self.drive).await {
            return Err("Peer access removed".into());
        }
        let hash = engine::compute_drive_hash(&vvs);
        let mut peers = std::collections::BTreeSet::new();
        for vv in vvs.values() {
            peers.extend(vv.keys().cloned());
        }
        let peers: Vec<String> = peers.into_iter().collect();
        let index: std::collections::HashMap<&str, usize> = peers
            .iter()
            .enumerate()
            .map(|(i, p)| (p.as_str(), i))
            .collect();
        let resources = vvs
            .iter()
            .map(|(subject, vv)| {
                let mut counters = vec![0i32; peers.len()];
                for (peer, &counter) in vv {
                    if let Some(&i) = index.get(peer.as_str()) {
                        counters[i] = counter;
                    }
                }
                (subject.clone(), counters)
            })
            .collect();
        Ok(Some(protocol::encode_sync(
            &self.drive,
            &hash,
            &peers,
            &resources,
        )))
    }

    /// Waits for a local write, or presence announced on this node, that the
    /// peer may read and returns the frames that carry it. Writes that arrived
    /// from a peer (this link or another) are not forwarded: the next reconcile
    /// carries them, as in the browser. Presence has no reconcile, so it is
    /// relayed instead, except back to where it came from and except between
    /// two WebRTC links (three nodes in a ring would otherwise pass one update
    /// around forever). Errors only when the store's event channel is gone.
    pub async fn next_live_frames(&self) -> AtomicResult<Vec<Vec<u8>>> {
        let mut events = self.events.lock().await;
        let mut ephemeral = self.ephemeral.lock().await;
        loop {
            let frames = tokio::select! {
                _ = self.closed.notified() => return Err("Peer link closed".into()),
                received = events.recv() => match received {
                    // Missed events are the reconcile's job.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("Store event channel closed".into())
                    }
                    Ok(event) => self.frames_for(&event).await,
                },
                received = ephemeral.recv() => match received {
                    // A stale cursor is not worth catching up on; the
                    // heartbeat re-sends presence within seconds.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => {
                        return Err("Store event channel closed".into())
                    }
                    Ok(event) => self.presence_frames_for(&event).await,
                },
            };
            if !frames.is_empty() {
                return Ok(frames);
            }
        }
    }

    async fn presence_frames_for(&self, event: &EphemeralEvent) -> Vec<Vec<u8>> {
        if event.kind != protocol::ephemeral_kind::PRESENCE
            || event.from_peer == self.source
            || event.from_peer.starts_with("webrtc:")
            // The peer refuses a frame whose agent is not the one that
            // authenticated this link, and drops the link for it. Other
            // agents' presence reaches it through its own server connection.
            || event.agent != self.agent.subject
            || crate::identifiers::canonicalize_scheme(&event.drive) != self.drive
        {
            return vec![];
        }
        let state = self.state.lock().await;
        if !state.ready() || !state.session.can_send(&self.db, &self.drive).await {
            return vec![];
        }
        vec![protocol::encode_ephemeral(
            event.kind,
            &event.drive,
            &event.agent,
            &event.payload,
        )]
    }

    async fn frames_for(&self, event: &DbEvent) -> Vec<Vec<u8>> {
        let state = self.state.lock().await;
        if !state.ready() {
            return vec![];
        }
        match event {
            DbEvent::Changed {
                subject,
                delta,
                source_id: None,
                is_new,
                ..
            } => {
                let subject = subject.pure_id().to_string();
                if !state.session.can_send(&self.db, &subject).await {
                    return vec![];
                }
                // A delta is enough for a resource the peer already holds;
                // a new one travels whole. If the peer lacks the base, the
                // reconcile repairs it.
                let bytes = match delta {
                    Some(delta) if !delta.is_empty() && !is_new => delta.clone(),
                    _ => match self.db.get_loro_snapshot_bytes(&subject) {
                        Some(bytes) if !bytes.is_empty() => bytes,
                        _ => return vec![],
                    },
                };
                let envelopes = crate::envelopes::for_subjects(&self.db, [subject.as_str()]);
                protocol::encode_sync_push_chunks_with_envelopes(
                    &self.drive,
                    &[(subject.as_str(), bytes.as_slice())],
                    &envelopes,
                )
            }
            // A deletion crosses as the signed commit that caused it. The
            // resource is gone, so the drive's remaining read grant decides.
            DbEvent::Destroyed {
                drive: Some(drive),
                source_id: None,
                commit_json: Some(json),
                ..
            } => {
                let drive = crate::identifiers::canonicalize_scheme(&drive.pure_id());
                if drive == self.drive && state.session.can_send(&self.db, &self.drive).await {
                    vec![protocol::encode_commit(0, json)]
                } else {
                    vec![]
                }
            }
            _ => vec![],
        }
    }
}

fn is_lower_hex(byte: u8) -> bool {
    byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn node(agent: Option<&Agent>) -> (Db, Agent, String) {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let db = Db::init_temp(&format!(
            "webrtc-link-{}-{}",
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
        .await
        .unwrap();
        match agent {
            Some(agent) => {
                db.set_default_agent(agent.clone());
                (db, agent.clone(), String::new())
            }
            None => {
                let (agent, drive) = db.setup("Alice").await.unwrap();
                (db, agent, drive)
            }
        }
    }

    /// Deliver every frame in `frames` to `to`, collecting its replies.
    async fn deliver(to: &WebRtcPeerLink, frames: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
        let mut replies = vec![];
        for frame in frames {
            replies.extend(to.handle(&frame).await.unwrap().frames);
        }
        replies
    }

    /// The handshake as two devices run it: both challenge, both answer, both
    /// acknowledge. Also pins the SYNC the second device builds.
    #[tokio::test]
    async fn two_nodes_of_one_agent_become_ready() {
        let (db_a, agent, drive) = node(None).await;
        let (db_b, _, _) = node(Some(&agent)).await;
        let binding = "ab".repeat(32);
        let (a, challenge_a) = WebRtcPeerLink::new(db_a, &drive, &binding, None).unwrap();
        let (b, challenge_b) =
            WebRtcPeerLink::new(db_b, &drive, &binding, Some(agent.subject.to_string())).unwrap();

        // Each answers the other's challenge with an AUTH.
        let auth_from_b = deliver(&b, vec![challenge_a]).await;
        let auth_from_a = deliver(&a, vec![challenge_b]).await;
        assert_eq!(auth_from_a[0][0], protocol::tag::AUTH);
        // An AUTH is verified by the receiving session and acknowledged.
        let ok_from_a = deliver(&a, auth_from_b).await;
        let ok_from_b = deliver(&b, auth_from_a).await;
        assert_eq!(ok_from_a[0][0], protocol::tag::AUTH_OK);
        assert!(
            a.reconcile_frame().await.unwrap().is_none(),
            "not ready yet"
        );
        deliver(&a, ok_from_b).await;
        deliver(&b, ok_from_a).await;

        let sync = a.reconcile_frame().await.unwrap().expect("ready");
        assert_eq!(sync[0], protocol::tag::SYNC);
        assert_eq!(protocol::decode_sync(&sync[1..]).unwrap().drive, a.drive());
        // The empty node asks too, and says it holds nothing.
        let empty = b.reconcile_frame().await.unwrap().expect("ready");
        assert!(protocol::decode_sync(&empty[1..])
            .unwrap()
            .resources
            .is_empty());
    }

    /// Run both links to a settled state, as the two data channels would:
    /// handshake, then SYNC both ways until no frame is left in flight.
    async fn settle(a: &WebRtcPeerLink, b: &WebRtcPeerLink, first: (Vec<u8>, Vec<u8>)) {
        let mut to_a = vec![first.1];
        let mut to_b = vec![first.0];
        for round in 0..12 {
            if round == 4 {
                // Ready by now: the periodic reconcile of each side.
                to_b.extend(a.reconcile_frame().await.unwrap());
                to_a.extend(b.reconcile_frame().await.unwrap());
            }
            let (mut next_a, mut next_b) = (vec![], vec![]);
            for frame in std::mem::take(&mut to_a) {
                next_b.extend(a.handle(&frame).await.unwrap().frames);
            }
            for frame in std::mem::take(&mut to_b) {
                next_a.extend(b.handle(&frame).await.unwrap().frames);
            }
            to_a = next_a;
            to_b = next_b;
        }
    }

    /// A drive that exists on one device only arrives on the other.
    #[tokio::test]
    async fn an_empty_node_receives_the_drive_through_the_link() {
        let (db_a, agent, drive) = node(None).await;
        let (db_b, _, _) = node(Some(&agent)).await;
        let binding = "ab".repeat(32);
        let (a, challenge_a) = WebRtcPeerLink::new(db_a, &drive, &binding, None).unwrap();
        let (b, challenge_b) = WebRtcPeerLink::new(
            db_b.clone(),
            &drive,
            &binding,
            Some(agent.subject.to_string()),
        )
        .unwrap();
        assert!(db_b.get_resource(&drive.as_str().into()).await.is_err());
        settle(&a, &b, (challenge_a, challenge_b)).await;
        assert!(db_b.get_resource(&drive.as_str().into()).await.is_ok());
    }

    /// After the link is up, a local edit reaches the peer as a live frame,
    /// without waiting for the next reconcile.
    #[tokio::test]
    async fn a_local_edit_is_forwarded_live_and_applies_on_the_peer() {
        let (db_a, agent, drive) = node(None).await;
        let (db_b, _, _) = node(Some(&agent)).await;
        let binding = "ab".repeat(32);
        let (a, challenge_a) = WebRtcPeerLink::new(db_a.clone(), &drive, &binding, None).unwrap();
        let (b, challenge_b) = WebRtcPeerLink::new(
            db_b.clone(),
            &drive,
            &binding,
            Some(agent.subject.to_string()),
        )
        .unwrap();
        settle(&a, &b, (challenge_a, challenge_b)).await;

        let live = tokio::spawn({
            let a = std::sync::Arc::new(a);
            let waiting = a.clone();
            async move { (a, waiting.next_live_frames().await) }
        });
        tokio::task::yield_now().await;
        let mut resource = db_a.get_resource(&drive.as_str().into()).await.unwrap();
        resource
            .set_unsafe(
                crate::urls::NAME.into(),
                crate::Value::String("Renamed live".into()),
            )
            .unwrap();
        db_a.add_resource(&resource).await.unwrap();
        let (_a, frames) = tokio::time::timeout(std::time::Duration::from_secs(5), live)
            .await
            .expect("a live frame arrives")
            .unwrap();
        let frames = frames.unwrap();
        assert_eq!(frames[0][0], protocol::tag::SYNC_PUSH);
        for frame in frames {
            b.handle(&frame).await.unwrap();
        }
        let renamed = db_b.get_resource(&drive.as_str().into()).await.unwrap();
        assert_eq!(
            renamed.get(crate::urls::NAME).unwrap().to_string(),
            "Renamed live"
        );
    }

    /// Two ready links of one agent over one drive.
    async fn ready_pair() -> (
        std::sync::Arc<WebRtcPeerLink>,
        WebRtcPeerLink,
        Db,
        Db,
        Agent,
    ) {
        let (db_a, agent, drive) = node(None).await;
        let (db_b, _, _) = node(Some(&agent)).await;
        let binding = "ab".repeat(32);
        let (a, challenge_a) = WebRtcPeerLink::new(db_a.clone(), &drive, &binding, None).unwrap();
        let (b, challenge_b) = WebRtcPeerLink::new(
            db_b.clone(),
            &drive,
            &binding,
            Some(agent.subject.to_string()),
        )
        .unwrap();
        settle(&a, &b, (challenge_a, challenge_b)).await;
        (std::sync::Arc::new(a), b, db_a, db_b, agent)
    }

    fn presence_event(link: &WebRtcPeerLink, agent: &Agent, from_peer: &str) -> EphemeralEvent {
        EphemeralEvent {
            kind: protocol::ephemeral_kind::PRESENCE,
            drive: link.drive().to_string(),
            agent: agent.subject.to_string(),
            payload: vec![1, 2, 3],
            from_peer: from_peer.to_string(),
        }
    }

    /// Presence announced on this node goes to the peer as an EPHEMERAL frame
    /// the peer accepts and publishes on its own node. Presence that came from
    /// this link, or from another WebRTC link, is not sent on.
    #[tokio::test]
    async fn local_presence_is_sent_and_published_by_the_peer() {
        let (a, b, db_a, db_b, agent) = ready_pair().await;
        let mut seen_by_b = db_b.subscribe_ephemeral();
        let waiting = tokio::spawn({
            let a = a.clone();
            async move { a.next_live_frames().await }
        });
        tokio::task::yield_now().await;
        // Neither of these is for the peer; the third is.
        db_a.publish_ephemeral(presence_event(&a, &agent, &a.source));
        db_a.publish_ephemeral(presence_event(&a, &agent, "webrtc:other"));
        db_a.publish_ephemeral(presence_event(&a, &agent, "local"));
        let frames = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("a frame arrives")
            .unwrap()
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0][0], protocol::tag::EPHEMERAL);
        let out = b.handle(&frames[0]).await.unwrap();
        assert_eq!(out.ephemeral.as_deref(), Some(frames[0].as_slice()));
        let published = seen_by_b.try_recv().unwrap();
        assert_eq!(published.kind, protocol::ephemeral_kind::PRESENCE);
        assert_eq!(published.payload, vec![1, 2, 3]);
        assert_eq!(published.from_peer, b.source);
    }

    #[tokio::test]
    async fn presence_of_another_agent_is_not_sent() {
        let (a, _b, db_a, _, _) = ready_pair().await;
        let waiting = tokio::spawn({
            let a = a.clone();
            async move { a.next_live_frames().await }
        });
        tokio::task::yield_now().await;
        let other = Agent::new(Some("Other")).unwrap();
        db_a.publish_ephemeral(presence_event(&a, &other, "ws"));
        let result = tokio::time::timeout(std::time::Duration::from_millis(300), waiting).await;
        assert!(result.is_err(), "nothing to send");
    }

    #[tokio::test]
    async fn closing_wakes_a_waiting_live_loop() {
        let (db, _, drive) = node(None).await;
        let (link, _) = WebRtcPeerLink::new(db, &drive, &"ab".repeat(32), None).unwrap();
        let link = std::sync::Arc::new(link);
        let waiting = tokio::spawn({
            let link = link.clone();
            async move { link.next_live_frames().await }
        });
        tokio::task::yield_now().await;
        link.close().await;
        let result = tokio::time::timeout(std::time::Duration::from_secs(5), waiting)
            .await
            .expect("woken")
            .unwrap();
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn refuses_a_challenge_for_another_channel() {
        let (db, _, drive) = node(None).await;
        let (link, _) = WebRtcPeerLink::new(db, &drive, &"ab".repeat(32), None).unwrap();
        let other = protocol::encode_challenge(&format!("{}:{}", "cd".repeat(32), "ef".repeat(32)));
        assert!(link.handle(&other).await.is_err());
    }

    #[tokio::test]
    async fn refuses_a_bad_binding_and_an_ack_before_the_challenge() {
        let (db, _, drive) = node(None).await;
        assert!(WebRtcPeerLink::new(db.clone(), &drive, "short", None).is_err());
        let (link, _) = WebRtcPeerLink::new(db, &drive, &"ab".repeat(32), None).unwrap();
        assert!(link.handle(&protocol::encode_auth_ok()).await.is_err());
    }
}
