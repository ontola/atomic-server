//! Integration tests for sync between two Db instances.

#[cfg(all(test, feature = "db-redb"))]
mod peer_sync_tests {
    use crate::{agents::ForAgent, storelike::Query, Db, Storelike};

    /// Test sync engine: Device A creates resources, Device B syncs via the protocol.
    /// This tests the same code path that Iroh/WS would use, without needing network.
    #[tokio::test]
    async fn two_devices_sync_via_engine() {
        // === Device A: create agent, drive, resource ===
        let db_a = Db::init_temp("sync_engine_a").await.unwrap();

        let (agent_a, drive_a) = db_a.setup("Alice").await.unwrap();
        let secret = agent_a.build_secret().unwrap();
        println!("Device A drive: {drive_a}");

        // Create a canvas resource
        let canvas_subject = db_a
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive_a,
                "Test Canvas",
                Some(vec![(
                    "https://atomicdata.dev/ontology/canvas/strokeData",
                    crate::Value::String(r#"[{"color":255,"points":[[10,20]]}]"#.into()),
                )]),
            )
            .await
            .unwrap();
        println!("Device A canvas: {canvas_subject}");

        // === Device B: restore from secret ===
        let db_b = Db::init_temp("sync_engine_b").await.unwrap();

        let agent_b = crate::agents::Agent::from_secret(&secret).unwrap();
        db_b.set_default_agent(agent_b.clone());

        // Verify secret contains drive DID
        let drive_b = agent_b.initial_drive.as_ref().unwrap().to_string();
        assert_eq!(drive_b, drive_a);
        db_b.set_active_drive(&drive_b).unwrap();

        // === Sync: simulate the SYNC_VV → SYNC_DIFF → SYNC_PUSH exchange ===

        // Device B computes its sync state (empty — it has nothing)
        let drive_subject_b =
            crate::Subject::from_raw(&drive_b, db_b.get_base_domain().as_deref());
        let drive_subjects_b = crate::sync::engine::collect_drive_subjects(&db_b, &drive_subject_b);
        let vvs_b = crate::sync::engine::build_drive_vvs(&db_b, &drive_subjects_b);
        let hash_b = crate::sync::engine::compute_drive_hash(&vvs_b);
        println!(
            "Device B has {} resources, hash: {}",
            vvs_b.len(),
            &hash_b[..8]
        );

        // Device B sends SYNC_VV to Device A (simulated)
        let peers_b: Vec<String> = vec![];
        let resources_b: std::collections::HashMap<String, Vec<i32>> =
            std::collections::HashMap::new();

        let response_frames: Vec<Vec<u8>> = crate::sync::engine::handle_sync_vv(
            &drive_a,
            &hash_b,
            &peers_b,
            &resources_b,
            &db_a,
            &ForAgent::Public,
        )
        .await;

        println!("Device A returned {} response frames", response_frames.len());
        assert!(
            !response_frames.is_empty(),
            "Should have at least SYNC_DIFF"
        );

        // Process response frames on Device B using the engine helper
        let mut total_imported = 0;

        for frame in &response_frames {
            if frame.is_empty() {
                continue;
            }

            let tag = frame[0];
            let payload = &frame[1..];

            if tag == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(payload) {
                    println!(
                        "SYNC_PUSH: {} entries for drive {}",
                        push.entries.len(),
                        push.drive
                    );
                    let count = crate::sync::engine::import_sync_push(&push, &db_b, &ForAgent::Sudo).await;
                    total_imported += count;
                }
            } else if tag == crate::sync::protocol::tag::SYNC_DIFF {
                println!("SYNC_DIFF received");
            } else if tag == crate::sync::protocol::tag::SYNC_OK {
                println!("SYNC_OK — already in sync (unexpected for empty device)");
            }
        }

        println!("Device B imported {} resources", total_imported);
        assert!(total_imported > 0, "Should have imported resources");

        // === Verify Device B has the canvas ===
        let resource_b = db_b
            .get_resource(&canvas_subject.as_str().into())
            .await
            .expect("Device B should have the canvas after sync");

        let name = resource_b.get(crate::urls::NAME).unwrap().to_string();
        assert_eq!(name, "Test Canvas", "Canvas name should match");

        let strokes = resource_b
            .get("https://atomicdata.dev/ontology/canvas/strokeData")
            .unwrap()
            .to_string();
        assert!(
            strokes.contains("10,20"),
            "Stroke data should be present. Got: {strokes}"
        );

        println!("SUCCESS: Device B has '{}' with strokes!", name);
    }

    /// Test that sync respects authorization:
    /// - A private drive (read: [agent only]) should NOT sync to an unauthenticated peer
    /// - The same drive SHOULD sync when the peer authenticates as the correct agent
    #[tokio::test]
    async fn sync_auth_private_drive() {
        // === Device A: create agent and a PRIVATE drive ===
        let db_a = Db::init_temp("sync_auth_a").await.unwrap();
        let agent_a = crate::agents::Agent::new(Some("Alice")).unwrap();
        db_a.set_default_agent(agent_a.clone());

        // Create drive manually with read restricted to agent only (not public)
        let mut builder = crate::commit::CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::IS_A.into(),
            crate::Value::ResourceArray(vec![crate::urls::DRIVE.into()]),
        );
        builder.set(
            crate::urls::NAME.into(),
            crate::Value::String("Private Drive".into()),
        );
        builder.set(
            crate::urls::WRITE.into(),
            crate::Value::ResourceArray(vec![agent_a.subject.to_string().into()]),
        );
        builder.set(
            crate::urls::READ.into(),
            crate::Value::ResourceArray(vec![agent_a.subject.to_string().into()]),
        );

        let commit =
            crate::commit::Commit::create_did(builder, &agent_a, &db_a)
                .await
                .unwrap();
        let drive_did = commit.subject.to_string();
        let opts = crate::commit::CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..crate::commit::CommitOpts::no_validations_no_index()
        };
        db_a.apply_commit(commit, &opts).await.unwrap();
        db_a.set_active_drive(&drive_did).unwrap();
        println!("Private drive: {drive_did}");

        // Create a child resource
        let child_subject = db_a
            .create_resource(
                crate::urls::CLASS,
                &drive_did,
                "Secret Doc",
                Some(vec![(
                    crate::urls::DESCRIPTION,
                    crate::Value::String("top secret".into()),
                )]),
            )
            .await
            .unwrap();
        println!("Secret doc: {child_subject}");

        // === Test 1: Sync as Public (unauthenticated) — should get NOTHING ===
        let drive_subject =
            crate::Subject::from_raw(&drive_did, db_a.get_base_domain().as_deref());
        let drive_subjects = crate::sync::engine::collect_drive_subjects(&db_a, &drive_subject);
        assert!(
            drive_subjects.len() >= 2,
            "Drive should have at least 2 resources (drive + child), got {}",
            drive_subjects.len()
        );

        let empty_peers: Vec<String> = vec![];
        let empty_resources: std::collections::HashMap<String, Vec<i32>> =
            std::collections::HashMap::new();

        let public_frames = crate::sync::engine::handle_sync_vv(
            &drive_did,
            "",
            &empty_peers,
            &empty_resources,
            &db_a,
            &ForAgent::Public,
        )
        .await;

        // Count how many resources would be pushed
        let mut public_push_count = 0;
        for frame in &public_frames {
            if !frame.is_empty() && frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                    public_push_count += push.entries.len();
                }
            }
        }
        println!("Public sync: {} resources pushed", public_push_count);
        assert_eq!(
            public_push_count, 0,
            "Unauthenticated sync should NOT receive private resources"
        );

        // === Test 2: Sync as the correct agent — should get ALL resources ===
        let authed_frames = crate::sync::engine::handle_sync_vv(
            &drive_did,
            "",
            &empty_peers,
            &empty_resources,
            &db_a,
            &ForAgent::from(&agent_a),
        )
        .await;

        let mut authed_push_count = 0;
        for frame in &authed_frames {
            if !frame.is_empty() && frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                    authed_push_count += push.entries.len();
                }
            }
        }
        println!("Authenticated sync: {} resources pushed", authed_push_count);
        assert!(
            authed_push_count >= 2,
            "Authenticated sync should receive at least drive + child, got {}",
            authed_push_count
        );

        // === Test 3: Sync as a DIFFERENT agent — should get NOTHING ===
        let stranger = crate::agents::Agent::new(Some("Eve")).unwrap();
        let stranger_frames = crate::sync::engine::handle_sync_vv(
            &drive_did,
            "",
            &empty_peers,
            &empty_resources,
            &db_a,
            &ForAgent::from(&stranger),
        )
        .await;

        let mut stranger_push_count = 0;
        for frame in &stranger_frames {
            if !frame.is_empty() && frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                    stranger_push_count += push.entries.len();
                }
            }
        }
        println!("Stranger sync: {} resources pushed", stranger_push_count);
        assert_eq!(
            stranger_push_count, 0,
            "Wrong agent should NOT receive private resources"
        );

        println!("SUCCESS: Auth tests passed — private drive is protected");
    }

    /// Test the ACTUAL Iroh code path: handle_frame starts with ForAgent::Public.
    /// A private drive should return nothing when synced through handle_frame
    /// without prior AUTH. This test MUST FAIL if auth is missing — it validates
    /// that the transport layer (Iroh/WS) correctly blocks unauthenticated access.
    #[tokio::test]
    async fn sync_via_handle_frame_requires_auth() {
        // === Setup: private drive with a child resource ===
        let db = Db::init_temp("sync_frame_auth").await.unwrap();
        let agent = crate::agents::Agent::new(Some("Alice")).unwrap();
        db.set_default_agent(agent.clone());

        // Create private drive (read: [agent only])
        let mut builder = crate::commit::CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::IS_A.into(),
            crate::Value::ResourceArray(vec![crate::urls::DRIVE.into()]),
        );
        builder.set(crate::urls::NAME.into(), crate::Value::String("Private".into()));
        builder.set(
            crate::urls::WRITE.into(),
            crate::Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        builder.set(
            crate::urls::READ.into(),
            crate::Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        let commit = crate::commit::Commit::create_did(builder, &agent, &db)
            .await
            .unwrap();
        let drive_did = commit.subject.to_string();
        let opts = crate::commit::CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..crate::commit::CommitOpts::no_validations_no_index()
        };
        db.apply_commit(commit, &opts).await.unwrap();
        db.set_active_drive(&drive_did).unwrap();

        db.create_resource(crate::urls::CLASS, &drive_did, "Secret", None)
            .await
            .unwrap();

        // === Test 1: Send SYNC frame through handle_frame as Public (no auth) ===
        // This is exactly what the Iroh handler does.
        let mut for_agent = ForAgent::Public;

        let sync_frame = crate::sync::protocol::encode_sync(
            &drive_did,
            "",
            &[],
            &std::collections::HashMap::new(),
        );

        let responses =
            crate::sync::engine::handle_frame(&sync_frame, &db, &mut for_agent).await;

        // Count pushed resources
        let mut unauthenticated_count = 0;
        for frame in &responses {
            if !frame.is_empty() && frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                    unauthenticated_count += push.entries.len();
                }
            }
        }
        println!(
            "handle_frame (Public): {} resources pushed",
            unauthenticated_count
        );
        assert_eq!(
            unauthenticated_count, 0,
            "handle_frame with ForAgent::Public must NOT leak private resources"
        );

        // === Test 2: Same flow but with ForAgent set to the correct agent ===
        // This simulates what would happen AFTER a successful AUTH frame.
        let mut for_agent_authed = ForAgent::from(&agent);

        let responses_authed =
            crate::sync::engine::handle_frame(&sync_frame, &db, &mut for_agent_authed).await;

        let mut authenticated_count = 0;
        for frame in &responses_authed {
            if !frame.is_empty() && frame[0] == crate::sync::protocol::tag::SYNC_PUSH {
                if let Some(push) = crate::sync::protocol::decode_sync_push(&frame[1..]) {
                    authenticated_count += push.entries.len();
                }
            }
        }
        println!(
            "handle_frame (Agent): {} resources pushed",
            authenticated_count
        );
        assert!(
            authenticated_count >= 2,
            "handle_frame with correct agent should push drive + child, got {}",
            authenticated_count
        );

        println!("SUCCESS: handle_frame respects ForAgent correctly");
    }

    /// End-to-end Iroh test: two real Iroh endpoints on localhost.
    /// Device A runs a server with a private drive.
    /// Device B calls sync_drive_with_peer.
    /// This MUST FAIL until we add auth to the Iroh sync handshake,
    /// because the server starts as ForAgent::Public and the client never sends AUTH.
    #[tokio::test]
    async fn iroh_sync_private_drive_requires_auth() {
        use crate::sync::peer;

        // === Device A (server): private drive ===
        let db_a = Db::init_temp("iroh_auth_a").await.unwrap();
        let agent = crate::agents::Agent::new(Some("Alice")).unwrap();
        db_a.set_default_agent(agent.clone());

        // Create private drive
        let mut builder = crate::commit::CommitBuilder::new("placeholder".into());
        builder.set(
            crate::urls::IS_A.into(),
            crate::Value::ResourceArray(vec![crate::urls::DRIVE.into()]),
        );
        builder.set(crate::urls::NAME.into(), crate::Value::String("Private".into()));
        builder.set(
            crate::urls::WRITE.into(),
            crate::Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        builder.set(
            crate::urls::READ.into(),
            crate::Value::ResourceArray(vec![agent.subject.to_string().into()]),
        );
        let commit = crate::commit::Commit::create_did(builder, &agent, &db_a)
            .await
            .unwrap();
        let drive_did = commit.subject.to_string();
        let opts = crate::commit::CommitOpts {
            validate_signature: true,
            validate_timestamp: false,
            validate_previous_commit: false,
            validate_rights: false,
            update_index: true,
            ..crate::commit::CommitOpts::no_validations_no_index()
        };
        db_a.apply_commit(commit, &opts).await.unwrap();
        db_a.set_active_drive(&drive_did).unwrap();

        let _child = db_a
            .create_resource(crate::urls::CLASS, &drive_did, "Secret Doc", None)
            .await
            .unwrap();

        // Start Iroh server (Device A)
        let (node_id_a, _router_a) = peer::start(db_a.clone()).await.unwrap();
        println!("Server NodeID: {node_id_a}");

        // === Device B (client): restore agent, try to sync ===
        let db_b = Db::init_temp("iroh_auth_b").await.unwrap();
        let secret = agent.build_secret().unwrap();
        db_b.load_agent_from_secret(&secret).await.unwrap().agent;

        // Create a separate Iroh endpoint for Device B
        let ep_b = iroh::Endpoint::builder().bind().await.unwrap();

        // Tell Device B how to reach Device A (localhost direct address)
        let node_addr_a = _router_a.endpoint().node_addr().await.unwrap();
        ep_b.add_node_addr(node_addr_a).unwrap();

        // Sync using the explicit endpoint
        let result = peer::sync_drive_with_peer_using(
            &ep_b,
            &node_id_a.to_string(),
            &drive_did,
            &db_b,
        )
        .await;

        // Device B has the same agent (restored from secret) so it SHOULD be able
        // to sync the private drive. If count == 0, auth is broken — the server
        // didn't recognize the agent because no AUTH was sent over Iroh.
        let count = result.expect("Sync should not error");
        assert!(
            count >= 2,
            "Device B has the correct agent and should sync the private drive, \
             but got {count} resources. The Iroh transport is not sending AUTH."
        );

        // Verify Device B has the secret doc
        let child_resource = db_b
            .get_resource(&_child.as_str().into())
            .await
            .expect("Device B should have the secret doc after authenticated sync");
        assert_eq!(
            child_resource.get(crate::urls::NAME).unwrap().to_string(),
            "Secret Doc"
        );

        println!("TEST PASSED: Iroh sync authenticates and syncs private drives");
    }

    /// Full end-to-end test: pkarr discovery + Iroh sync.
    /// Device A creates a drive with data, publishes its NodeID via pkarr relay.
    /// Device B discovers Device A via pkarr, connects via Iroh, syncs the drive.
    #[cfg(feature = "discovery")]
    #[tokio::test]
    async fn pkarr_discovery_and_iroh_sync() {
        use crate::sync::peer;

        // === Device A: create drive + resource ===
        let db_a = Db::init_temp("pkarr_sync_a").await.unwrap();
        let (agent, drive_a) = db_a.setup("Alice").await.unwrap();
        let secret = agent.build_secret().unwrap();

        let child_subject = db_a
            .create_resource(
                crate::urls::CLASS,
                &drive_a,
                "Synced Doc",
                Some(vec![(
                    crate::urls::DESCRIPTION,
                    crate::Value::String("pkarr discovery test".into()),
                )]),
            )
            .await
            .unwrap();
        println!("Device A drive: {drive_a}");
        println!("Device A doc: {child_subject}");

        // Start Iroh on Device A
        let (node_id_a, _router_a) = peer::start(db_a.clone()).await.unwrap();
        println!("Device A NodeID: {node_id_a}");

        // Publish Device A's NodeID via pkarr relay
        crate::discovery::publish_node_id(&agent, &drive_a, &node_id_a.to_string())
            .await
            .expect("pkarr publish should succeed");
        println!("Device A: published NodeID to pkarr relay");

        // === Device B: restore agent, discover, sync ===
        let db_b = Db::init_temp("pkarr_sync_b").await.unwrap();
        let agent_b = crate::agents::Agent::from_secret(&secret).unwrap();
        db_b.set_default_agent(agent_b.clone());

        // Create a separate Iroh endpoint for Device B
        let ep_b = iroh::Endpoint::builder().discovery_n0().bind().await.unwrap();

        // Tell Device B how to reach Device A
        let node_addr_a = _router_a.endpoint().node_addr().await.unwrap();
        ep_b.add_node_addr(node_addr_a).unwrap();

        // Discover Device A's NodeID via pkarr relay
        // Filter out Device B's own NodeID (in tests, the global ENDPOINT is Device A's)
        let my_node_id_b = ep_b.node_id().to_string();
        let discovered_node_id = crate::discovery::resolve_node_id_filtered(
            &agent_b, &drive_a, Some(&my_node_id_b),
        )
            .await
            .expect("pkarr resolve should find Device A");
        println!("Device B discovered: {discovered_node_id}");
        assert_eq!(
            discovered_node_id,
            node_id_a.to_string(),
            "Discovered NodeID should match Device A's"
        );

        // Sync via Iroh using the discovered NodeID
        let count = peer::sync_drive_with_peer_using(
            &ep_b,
            &discovered_node_id,
            &drive_a,
            &db_b,
        )
        .await
        .expect("Iroh sync should succeed");

        println!("Device B synced {count} resources");
        assert!(count >= 2, "Should sync at least drive + child, got {count}");

        // Verify Device B has the document
        let doc = db_b
            .get_resource(&child_subject.as_str().into())
            .await
            .expect("Device B should have the synced doc");
        assert_eq!(
            doc.get(crate::urls::NAME).unwrap().to_string(),
            "Synced Doc"
        );

        println!("TEST PASSED: pkarr discovery → Iroh sync works end-to-end");
    }

    /// QR pairing flow: two devices each start Iroh, exchange NodeIDs
    /// (simulating QR scan), and sync bidirectionally.
    /// Device A has data, Device B has different data. After sync both have everything.
    #[tokio::test]
    async fn qr_pairing_sync() {
        use crate::sync::peer;

        // === Device A: create agent, drive, canvas ===
        let db_a = Db::init_temp("qr_pair_a").await.unwrap();
        let (agent_a, drive_a) = db_a.setup("Alice").await.unwrap();
        let secret = agent_a.build_secret().unwrap();

        let canvas_a = db_a
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive_a,
                "Canvas from A",
                Some(vec![(
                    "https://atomicdata.dev/ontology/canvas/strokeData",
                    crate::Value::String(r#"[{"color":255,"points":[[1,2]]}]"#.into()),
                )]),
            )
            .await
            .unwrap();
        println!("Device A: drive={drive_a}, canvas={canvas_a}");

        // === Device B: restore same agent, create its own canvas ===
        let db_b = Db::init_temp("qr_pair_b").await.unwrap();
        db_b.load_agent_from_secret(&secret).await.unwrap().agent;
        let drive_b = db_b.get_active_drive().expect("Should have drive from secret");

        let canvas_b = db_b
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive_b,
                "Canvas from B",
                Some(vec![(
                    "https://atomicdata.dev/ontology/canvas/strokeData",
                    crate::Value::String(r#"[{"color":16711680,"points":[[10,20]]}]"#.into()),
                )]),
            )
            .await
            .unwrap();
        println!("Device B: drive={drive_b}, canvas={canvas_b}");
        assert_eq!(drive_a, drive_b, "Same agent → same drive");

        // === Both devices start Iroh (like app startup) ===
        let (node_id_a, router_a) = peer::start(db_a.clone()).await.unwrap();
        println!("Device A NodeID: {node_id_a}");

        // Device B needs its own endpoint (can't reuse global — same process)
        let ep_b = iroh::Endpoint::builder()
            .discovery_n0()
            .discovery_local_network()
            .bind()
            .await
            .unwrap();
        let node_id_b = ep_b.node_id();
        println!("Device B NodeID: {node_id_b}");

        // === QR scan: Device B gets Device A's NodeID ===
        // In the real app, this is the QR code content: did:ad:node:<node_id_a>
        let qr_content = format!("did:ad:node:{node_id_a}");
        println!("QR code: {qr_content}");

        // Device B adds Device A's address (on same machine, use direct addr)
        let node_addr_a = router_a.endpoint().node_addr().await.unwrap();
        ep_b.add_node_addr(node_addr_a).unwrap();

        // === Device B syncs with Device A ===
        let count_b = peer::sync_drive_with_peer_using(
            &ep_b,
            &node_id_a.to_string(),
            &drive_a,
            &db_b,
        )
        .await
        .expect("Sync B→A should succeed");
        println!("Device B synced {count_b} resources from A");
        assert!(count_b > 0, "B should get A's canvas");

        // Verify Device B has A's canvas
        let fetched_a_on_b = db_b
            .get_resource(&canvas_a.as_str().into())
            .await
            .expect("Device B should have A's canvas");
        assert_eq!(
            fetched_a_on_b.get(crate::urls::NAME).unwrap().to_string(),
            "Canvas from A"
        );

        // Give the server-side handler time to process B's SYNC_PUSH
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // The bidirectional exchange: when B synced with A, the SYNC_DIFF
        // told B which resources A needs. B sent them via SYNC_PUSH.
        // A's handle_stream processed that push and imported B's data.
        let fetched_b_on_a = db_a
            .get_resource(&canvas_b.as_str().into())
            .await
            .expect("Device A should have B's canvas (sent during sync)");
        assert_eq!(
            fetched_b_on_a.get(crate::urls::NAME).unwrap().to_string(),
            "Canvas from B"
        );

        println!("TEST PASSED: QR pairing sync — both devices have each other's data");
    }

    /// Live query test: Device A creates a resource, syncs to Device B.
    /// Device B's query (children of drive where class=Canvas) should include
    /// the synced resource without manually re-running the query.
    #[tokio::test]
    async fn synced_resource_appears_in_query() {
        use crate::sync::peer;

        // === Device A: create agent, drive, canvas ===
        let db_a = Db::init_temp("query_sync_a").await.unwrap();
        let (agent_a, drive_a) = db_a.setup("Alice").await.unwrap();
        let secret = agent_a.build_secret().unwrap();

        let canvas_subject = db_a
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive_a,
                "Synced Canvas",
                None,
            )
            .await
            .unwrap();
        println!("Device A created canvas: {canvas_subject}");

        // === Device B: restore agent, run a query BEFORE sync ===
        let db_b = Db::init_temp("query_sync_b").await.unwrap();
        db_b.load_agent_from_secret(&secret).await.unwrap();
        let drive_b = db_b.get_active_drive().expect("Should have drive from secret");
        assert_eq!(drive_a, drive_b);

        // Query children of the drive — should be empty
        let query = Query::new_prop_val(
            crate::urls::PARENT,
            &drive_b,
        );
        let before = db_b.query(&query).await.unwrap();
        println!("Device B query before sync: {} results", before.subjects.len());
        assert_eq!(before.subjects.len(), 0, "No resources before sync");

        // === Start Iroh, sync ===
        let (node_id_a, router_a) = peer::start(db_a.clone()).await.unwrap();
        let ep_b = iroh::Endpoint::builder()
            .discovery_n0()
            .discovery_local_network()
            .bind()
            .await
            .unwrap();

        let node_addr_a = router_a.endpoint().node_addr().await.unwrap();
        ep_b.add_node_addr(node_addr_a).unwrap();

        let count = peer::sync_drive_with_peer_using(
            &ep_b,
            &node_id_a.to_string(),
            &drive_a,
            &db_b,
        )
        .await
        .expect("Sync should succeed");
        println!("Device B synced {count} resources");

        // Wait for server-side to process
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // === Query again — should now include the synced canvas ===
        let after = db_b.query(&query).await.unwrap();
        println!("Device B query after sync: {} results", after.subjects.len());
        assert!(
            after.subjects.iter().any(|s| s == &canvas_subject),
            "Query should find the synced canvas. Got: {:?}",
            after.subjects,
        );

        // Verify the resource is complete
        let canvas = db_b
            .get_resource(&canvas_subject.as_str().into())
            .await
            .expect("Canvas should exist");
        assert_eq!(
            canvas.get(crate::urls::NAME).unwrap().to_string(),
            "Synced Canvas"
        );

        println!("TEST PASSED: synced resource appears in query results");
    }

    /// Test the resource change broadcast: subscribing to changes and receiving
    /// notifications when resources are written (locally or via sync).
    #[tokio::test]
    async fn resource_change_broadcast() {
        let db = Db::init_temp("change_broadcast").await.unwrap();
        let (_agent, drive) = db.setup("Alice").await.unwrap();

        // Subscribe before creating a resource
        let mut rx = db.subscribe_changes();

        // Create a canvas
        let canvas = db
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive,
                "Broadcast Test",
                None,
            )
            .await
            .unwrap();

        // Should receive the notification
        let received = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            rx.recv(),
        )
        .await
        .expect("Should receive within 2s")
        .expect("Channel should not be closed");

        assert_eq!(received, canvas, "Should receive the created resource's subject");
        println!("TEST PASSED: resource change broadcast works");
    }

    /// Test that JsonArray (stroke data) round-trips through Loro and syncs correctly.
    #[tokio::test]
    async fn json_array_syncs_via_loro() {
        use crate::sync::peer;

        let db_a = Db::init_temp("jsonarray_a").await.unwrap();
        let (agent_a, drive_a) = db_a.setup("Alice").await.unwrap();
        let secret = agent_a.build_secret().unwrap();

        // Create a canvas with JsonArray stroke data
        let strokes = vec![
            serde_json::json!({"color": 255, "width": 2.0, "path": [[1.0, 2.0], [3.0, 4.0]]}),
            serde_json::json!({"color": 16711680, "width": 5.0, "path": [[10.0, 20.0], [30.0, 40.0]]}),
        ];

        let canvas = db_a
            .create_resource(
                "https://atomicdata.dev/ontology/canvas/Canvas",
                &drive_a,
                "Stroke Test",
                Some(vec![(
                    "https://atomicdata.dev/ontology/canvas/strokeData",
                    crate::Value::JsonArray(strokes.clone()),
                )]),
            )
            .await
            .unwrap();
        println!("Canvas with strokes: {canvas}");

        // Verify strokes are in the Loro snapshot
        let resource_a = db_a.get_resource(&canvas.as_str().into()).await.unwrap();
        match resource_a.get("https://atomicdata.dev/ontology/canvas/strokeData") {
            Ok(crate::Value::JsonArray(arr)) => {
                println!("Device A has {} strokes", arr.len());
                assert_eq!(arr.len(), 2);
                assert_eq!(arr[0]["color"], 255);
                assert_eq!(arr[1]["path"][0][0], 10.0);
            }
            other => panic!("Expected JsonArray, got: {:?}", other),
        }

        // Sync to device B
        let db_b = Db::init_temp("jsonarray_b").await.unwrap();
        db_b.load_agent_from_secret(&secret).await.unwrap();

        let (node_id_a, router_a) = peer::start(db_a.clone()).await.unwrap();
        let ep_b = iroh::Endpoint::builder()
            .discovery_n0()
            .discovery_local_network()
            .bind()
            .await
            .unwrap();
        let node_addr_a = router_a.endpoint().node_addr().await.unwrap();
        ep_b.add_node_addr(node_addr_a).unwrap();

        let count = peer::sync_drive_with_peer_using(
            &ep_b,
            &node_id_a.to_string(),
            &drive_a,
            &db_b,
        )
        .await
        .expect("Sync should succeed");
        println!("Device B synced {count} resources");

        tokio::time::sleep(std::time::Duration::from_millis(500)).await;

        // Verify strokes arrived on device B
        let resource_b = db_b.get_resource(&canvas.as_str().into()).await.unwrap();
        match resource_b.get("https://atomicdata.dev/ontology/canvas/strokeData") {
            Ok(crate::Value::JsonArray(arr)) => {
                println!("Device B has {} strokes", arr.len());
                assert_eq!(arr.len(), 2, "Should have 2 strokes");
                assert_eq!(arr[0]["color"], 255);
                assert_eq!(arr[1]["color"], 16711680);
                assert_eq!(arr[1]["path"][0][0], 10.0);
            }
            other => panic!("Expected JsonArray on device B, got: {:?}", other),
        }

        println!("TEST PASSED: JsonArray stroke data syncs via Loro");
    }
}
