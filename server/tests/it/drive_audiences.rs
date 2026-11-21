//! One drive per audience: what a real server lets each agent read.
//!
//! Apps that keep information for different audiences (everyone, all
//! members, a few named people, one committee) split it over drives by who
//! may read, so the rights model needs no app code. This suite pins down,
//! on a running server, that every way in to a resource honours the drive's
//! `read` list:
//!
//! - HTTP `GET` of a resource and of the commit that made it;
//! - `/search`;
//! - WebSocket `SUB` on the drive, and the live fan-out of later edits;
//! - the drive inventory a device syncs from (`drive_items_for`, the gate of
//!   `SYNC`, the probe and `RBSR_ITEMS`);
//! - taking someone off a drive's `read` list.
//!
//! It also pins two properties that decide how such an app must lay out its
//! drives:
//!
//! - rights add up along the parent chain, so a folder inside a drive can
//!   never be narrower than the drive;
//! - a device syncs whole drives, and a drive whose root the agent cannot
//!   read is refused as a whole, even when a folder inside grants it read.
//!
//! Run: cargo test -p atomic-server --test it drive_audiences

use atomic_lib::{
    agents::{Agent, ForAgent},
    client::{
        connected::Client,
        ws::{WsClient, WsMessage},
    },
    sync::protocol,
    urls, Resource, Storelike, Value,
};
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::broadcast::Receiver;

use crate::common::{start_server_with_store, wait_for_server};

/// A drive owned by `owner` that `readers` may read.
async fn drive_for(
    client: &Client,
    owner: &Agent,
    name: &str,
    readers: &[&Agent],
) -> (String, Resource) {
    client.store().set_default_agent(owner.clone());
    let mut drive = Resource::new("did:ad:placeholder".into());
    drive
        .set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::DRIVE.into()]),
        )
        .unwrap();
    drive.set_name(name).unwrap();
    drive
        .set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![owner.subject.to_string().into()]),
        )
        .unwrap();
    set_readers(&mut drive, owner, readers);
    let subject = drive.save_remote(client.store()).await.unwrap();
    (subject, drive)
}

/// `read` = `readers` plus the owner.
fn set_readers(resource: &mut Resource, owner: &Agent, readers: &[&Agent]) {
    let mut read: Vec<_> = readers
        .iter()
        .map(|a| a.subject.to_string().into())
        .collect();
    read.push(owner.subject.to_string().into());
    resource
        .set_unsafe(urls::READ.into(), Value::ResourceArray(read))
        .unwrap();
}

/// A document under `parent` whose text holds `word`, written by `owner`.
async fn doc_in(client: &Client, owner: &Agent, parent: &str, word: &str) -> Resource {
    client.store().set_default_agent(owner.clone());
    let mut doc = client.new_resource(parent).unwrap();
    doc.set_name(&format!("Stuk {word}")).unwrap();
    doc.set_unsafe(
        urls::DESCRIPTION.into(),
        Value::String(format!("Inhoud met het woord {word}")),
    )
    .unwrap();
    doc.save_remote(client.store()).await.unwrap();
    doc
}

/// A folder under `parent` with its own `read` list.
async fn folder_in(client: &Client, owner: &Agent, parent: &str, readers: &[&Agent]) -> String {
    client.store().set_default_agent(owner.clone());
    let mut folder = client.new_resource(parent).unwrap();
    folder
        .set_unsafe(
            urls::IS_A.into(),
            Value::ResourceArray(vec![urls::FOLDER.into()]),
        )
        .unwrap();
    folder.set_name("Map").unwrap();
    set_readers(&mut folder, owner, readers);
    folder.save_remote(client.store()).await.unwrap()
}

/// Whether `agent` can `GET` `subject` over HTTP.
async fn http_get(client: &Client, agent: &Agent, subject: &str) -> bool {
    atomic_lib::client::fetch_resource(subject, client.store(), Some(agent))
        .await
        .is_ok()
}

/// The body of `/search?q=word`, signed as `agent`.
async fn search(server_url: &str, agent: &Agent, word: &str) -> String {
    let url = format!("{server_url}/search?q={word}");
    let headers = atomic_lib::client::helpers::get_authentication_headers(&url, agent).unwrap();
    let mut req = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/ad+json");
    for (k, v) in headers {
        req = req.header(k, v);
    }
    req.send().await.unwrap().text().await.unwrap()
}

/// Whether a `SUB` on `drive` is refused for `agent`.
async fn sub_refused(ws_url: &str, agent: &Agent, drive: &str) -> bool {
    let ws = WsClient::connect(ws_url).await.unwrap();
    ws.authenticate(agent).await.unwrap();
    let mut rx = ws.subscribe();
    ws.send_binary(protocol::encode_sub(drive)).await.unwrap();
    tokio::time::timeout(Duration::from_millis(1500), async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Error { message, .. }) if message.contains(drive) => return true,
                Ok(_) => continue,
                Err(_) => return false,
            }
        }
    })
    .await
    .unwrap_or(false)
}

/// What `agent` gets when its device syncs `drive`: `None` when the whole
/// drive is refused, else the subjects it receives.
async fn sync_inventory(
    store: &atomic_lib::Db,
    agent: &Agent,
    drive: &str,
) -> Option<HashSet<String>> {
    let for_agent = ForAgent::AgentSubject(agent.subject.clone());
    atomic_lib::sync::engine::drive_items_for(store, drive, &for_agent)
        .await
        .ok()
        .map(|items| items.into_iter().map(|(s, _)| s).collect())
}

/// Every subject that reaches `rx` within `wait`.
async fn drain(rx: &mut Receiver<WsMessage>, wait: Duration) -> HashSet<String> {
    let mut seen = HashSet::new();
    let _ = tokio::time::timeout(wait, async {
        loop {
            match rx.recv().await {
                Ok(WsMessage::Update { subject, .. }) => {
                    seen.insert(subject);
                }
                Ok(WsMessage::Destroy { subject }) => {
                    seen.insert(subject);
                }
                Ok(_) => {}
                Err(_) => return,
            }
        }
    })
    .await;
    seen
}

#[tokio::test]
async fn every_way_in_honours_the_drive_read_list() {
    let (port, store) = start_server_with_store("drive_audiences", &[]);
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let ws_url = format!("ws://localhost:{port}/ws");
    let client = Client::new(&server_url).await.unwrap();

    // The organisation: an owner who manages everything, three members and
    // one outsider who belongs to none of the audiences below.
    let owner = client.new_agent("Owner").await.unwrap();
    let m1 = client.new_agent("Member 1").await.unwrap();
    let m2 = client.new_agent("Member 2").await.unwrap();
    let m3 = client.new_agent("Member 3").await.unwrap();
    let outsider = client.new_agent("Outsider").await.unwrap();
    let everyone = [&m1, &m2, &m3, &outsider];

    // One drive per audience, each with one document carrying its own word.
    let (all_drive, _) = drive_for(&client, &owner, "Iedereen", &everyone).await;
    let (members_drive, _) = drive_for(&client, &owner, "Leden", &[&m1, &m2, &m3]).await;
    let (few_drive, _) = drive_for(&client, &owner, "Enkelen", &[&m1]).await;
    let (group_drive, mut group_res) = drive_for(&client, &owner, "Commissie", &[&m1, &m2]).await;

    let mut all_doc = doc_in(&client, &owner, &all_drive, "aardvark").await;
    let mut members_doc = doc_in(&client, &owner, &members_drive, "bever").await;
    let mut few_doc = doc_in(&client, &owner, &few_drive, "cavia").await;
    let mut group_doc = doc_in(&client, &owner, &group_drive, "das").await;

    struct Case<'a> {
        drive: &'a str,
        doc: String,
        word: &'a str,
        readers: Vec<&'a Agent>,
    }
    let cases = [
        Case {
            drive: &all_drive,
            doc: all_doc.get_subject().to_string(),
            word: "aardvark",
            readers: vec![&owner, &m1, &m2, &m3, &outsider],
        },
        Case {
            drive: &members_drive,
            doc: members_doc.get_subject().to_string(),
            word: "bever",
            readers: vec![&owner, &m1, &m2, &m3],
        },
        Case {
            drive: &few_drive,
            doc: few_doc.get_subject().to_string(),
            word: "cavia",
            readers: vec![&owner, &m1],
        },
        Case {
            drive: &group_drive,
            doc: group_doc.get_subject().to_string(),
            word: "das",
            readers: vec![&owner, &m1, &m2],
        },
    ];
    let agents = [
        ("owner", &owner),
        ("m1", &m1),
        ("m2", &m2),
        ("m3", &m3),
        ("outsider", &outsider),
    ];

    for case in &cases {
        let commit = all_or_last_commit(&client, &owner, &case.doc).await;
        for (name, agent) in agents {
            let may = case.readers.iter().any(|r| r.subject == agent.subject);
            let what = format!("{name} on the {} drive", case.word);

            assert_eq!(
                http_get(&client, agent, &case.doc).await,
                may,
                "GET document: {what}"
            );
            assert_eq!(
                http_get(&client, agent, case.drive).await,
                may,
                "GET drive: {what}"
            );
            if let Some(commit) = &commit {
                assert_eq!(
                    http_get(&client, agent, commit).await,
                    may,
                    "GET commit: {what}"
                );
            }

            assert_eq!(
                !sub_refused(&ws_url, agent, case.drive).await,
                may,
                "WS SUB: {what}"
            );

            let inventory = sync_inventory(&store, agent, case.drive).await;
            if may {
                let items = inventory.unwrap_or_else(|| panic!("sync refused: {what}"));
                assert!(
                    items.contains(&case.doc),
                    "sync misses the document: {what}"
                );
            } else {
                assert!(inventory.is_none(), "sync not refused: {what}");
            }

            // Search never lists a document the agent may not read.
            if !may {
                let body = search(&server_url, agent, case.word).await;
                assert!(
                    !body.contains(&case.doc),
                    "search leaks the document: {what}: {body}"
                );
            }
        }
    }

    // Live: everyone subscribes to every drive they may, then the owner edits
    // every document. Nobody receives an edit of a document they cannot read.
    let mut feeds = Vec::new();
    for (name, agent) in agents {
        let ws = WsClient::connect(&ws_url).await.unwrap();
        ws.authenticate(agent).await.unwrap();
        let rx = ws.subscribe();
        for case in &cases {
            ws.send_binary(protocol::encode_sub(case.drive))
                .await
                .unwrap();
        }
        feeds.push((name, agent, ws, rx));
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    client.store().set_default_agent(owner.clone());
    for doc in [&mut all_doc, &mut members_doc, &mut few_doc, &mut group_doc] {
        doc.set_name("Bijgewerkt").unwrap();
        doc.save_remote(client.store()).await.unwrap();
    }
    for (name, agent, _ws, rx) in feeds.iter_mut() {
        let seen = drain(rx, Duration::from_secs(2)).await;
        for case in &cases {
            let may = case.readers.iter().any(|r| r.subject == agent.subject);
            if !may {
                assert!(
                    !seen.contains(&case.doc),
                    "live fan-out leaks the {} document to {name}",
                    case.word
                );
            }
        }
        if *name != "owner" {
            assert!(
                seen.contains(all_doc.get_subject().as_str()),
                "inconclusive: {name} never got the edit on the drive everyone reads"
            );
        }
    }

    // Moving a document to a narrower drive narrows who reads it: the
    // members' document goes to the drive only m1 reads.
    client.store().set_default_agent(owner.clone());
    members_doc
        .set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl(few_drive.clone().into()),
        )
        .unwrap();
    members_doc.save_remote(client.store()).await.unwrap();
    let moved = members_doc.get_subject().to_string();
    assert!(
        http_get(&client, &m1, &moved).await,
        "m1 lost the moved document"
    );
    for agent in [&m2, &m3] {
        assert!(
            !http_get(&client, agent, &moved).await,
            "{} still reads a document moved to a narrower drive",
            agent.subject
        );
        let left = sync_inventory(&store, agent, &members_drive).await.unwrap();
        assert!(
            !left.contains(&moved),
            "the old drive still syncs the moved document"
        );
    }
    let few = sync_inventory(&store, &m1, &few_drive).await.unwrap();
    assert!(
        few.contains(&moved),
        "the new drive does not sync the moved document"
    );

    // Taking m2 off the committee drive ends their access to it.
    client.store().set_default_agent(owner.clone());
    set_readers(&mut group_res, &owner, &[&m1]);
    group_res.save_remote(client.store()).await.unwrap();
    let group_doc_subject = group_doc.get_subject().to_string();
    assert!(
        !http_get(&client, &m2, &group_doc_subject).await,
        "m2 still reads after removal"
    );
    assert!(
        sync_inventory(&store, &m2, &group_drive).await.is_none(),
        "m2 still syncs after removal"
    );
    assert!(
        sub_refused(&ws_url, &m2, &group_drive).await,
        "m2 can still SUB after removal"
    );
    assert!(
        http_get(&client, &m1, &group_doc_subject).await,
        "m1 lost access too"
    );
}

/// The commit that last changed `subject`, if the resource names it.
async fn all_or_last_commit(client: &Client, owner: &Agent, subject: &str) -> Option<String> {
    let response = atomic_lib::client::fetch_resource(subject, client.store(), Some(owner))
        .await
        .ok()?;
    let resource = response.to_single();
    resource.get(urls::LAST_COMMIT).ok().map(|v| v.to_string())
}

/// Rights add up along the parent chain: a folder with a short `read` list
/// inside a drive that more agents read is still read by all of them. So a
/// narrower audience needs its own drive, not a folder.
#[tokio::test]
async fn a_folder_is_never_narrower_than_its_drive() {
    let (port, _store) = start_server_with_store("drive_audiences_folder", &[]);
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let client = Client::new(&server_url).await.unwrap();

    let owner = client.new_agent("Owner").await.unwrap();
    let m1 = client.new_agent("Member 1").await.unwrap();
    let m2 = client.new_agent("Member 2").await.unwrap();

    let (drive, _) = drive_for(&client, &owner, "Leden", &[&m1, &m2]).await;
    let folder = folder_in(&client, &owner, &drive, &[&m1]).await;
    let doc = doc_in(&client, &owner, &folder, "egel").await;
    let doc = doc.get_subject().to_string();

    assert!(http_get(&client, &m1, &doc).await);
    assert!(
        http_get(&client, &m2, &doc).await,
        "rights no longer add up along parents: update this suite and the apps that rely on it"
    );
}

/// A device syncs whole drives. When the drive root is not readable for an
/// agent, the server refuses the drive as a whole, even if a folder inside
/// grants that agent read. The agent can still `GET` the folder's documents
/// one by one, but its device never receives them through sync.
#[tokio::test]
async fn a_folder_grant_inside_an_unreadable_drive_does_not_sync() {
    let (port, store) = start_server_with_store("drive_audiences_unsyncable", &[]);
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let client = Client::new(&server_url).await.unwrap();

    let owner = client.new_agent("Owner").await.unwrap();
    let m1 = client.new_agent("Member 1").await.unwrap();

    let (drive, _) = drive_for(&client, &owner, "Vertrouwelijk", &[]).await;
    let folder = folder_in(&client, &owner, &drive, &[&m1]).await;
    let doc = doc_in(&client, &owner, &folder, "fret").await;
    let doc = doc.get_subject().to_string();

    assert!(
        http_get(&client, &m1, &doc).await,
        "the folder grant reaches the document"
    );
    assert!(
        sync_inventory(&store, &m1, &drive).await.is_none(),
        "the drive now syncs per readable subject: apps may put audiences in folders again"
    );
}

/// `append` on one resource lets the agents listed create children of it
/// (and nothing else): each writes its own child, with itself as the only
/// writer, and can change it later; another appender cannot change it, and an
/// agent without `append` cannot add one at all. This is how members cast
/// their own ballot in a vote the owner opened.
#[tokio::test]
async fn append_lets_each_agent_write_only_its_own_child() {
    let (port, _store) = start_server_with_store("drive_audiences_append", &[]);
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let client = Client::new(&server_url).await.unwrap();

    let owner = client.new_agent("Owner").await.unwrap();
    let m1 = client.new_agent("Member 1").await.unwrap();
    let m2 = client.new_agent("Member 2").await.unwrap();
    let outsider = client.new_agent("Outsider").await.unwrap();

    let (drive, _) = drive_for(&client, &owner, "Leden", &[&m1, &m2, &outsider]).await;
    client.store().set_default_agent(owner.clone());
    let mut vote = client.new_resource(&drive).unwrap();
    vote.set_name("Stemming").unwrap();
    vote.set_unsafe(
        urls::APPEND.into(),
        Value::ResourceArray(vec![
            m1.subject.to_string().into(),
            m2.subject.to_string().into(),
        ]),
    )
    .unwrap();
    let vote = vote.save_remote(client.store()).await.unwrap();

    async fn ballot(
        client: &Client,
        who: &Agent,
        vote: &str,
    ) -> atomic_lib::errors::AtomicResult<Resource> {
        client.store().set_default_agent(who.clone());
        let mut b = client.new_resource(vote)?;
        b.set_name("voor")?;
        b.set_unsafe(
            urls::WRITE.into(),
            Value::ResourceArray(vec![who.subject.to_string().into()]),
        )?;
        b.save_remote(client.store()).await?;
        Ok(b)
    }

    let mut mine = ballot(&client, &m1, &vote)
        .await
        .expect("m1 may add a ballot");
    client.store().set_default_agent(m1.clone());
    mine.set_name("tegen").unwrap();
    mine.save_remote(client.store())
        .await
        .expect("m1 may change their own ballot");

    // m2 takes m1's ballot and tries to change it.
    let subject = mine.get_subject().to_string();
    client.store().set_default_agent(m2.clone());
    let mut theirs = atomic_lib::client::fetch_resource(&subject, client.store(), Some(&m2))
        .await
        .unwrap()
        .to_single();
    theirs.set_name("onthouden").unwrap();
    assert!(
        theirs.save_remote(client.store()).await.is_err(),
        "m2 changed m1's ballot"
    );

    assert!(
        ballot(&client, &outsider, &vote).await.is_err(),
        "an agent without append added a ballot"
    );
}

/// An invite accepted at the server (`accept_invite_at_server`, what a
/// device connected to a server does) puts the accepting agent on the
/// target's lists. A one-use invite admits one agent.
#[tokio::test]
async fn an_invite_accepted_at_the_server_grants_its_target() {
    let (port, _store) = start_server_with_store("drive_audiences_invite", &[]);
    wait_for_server(port).await;
    let server_url = format!("http://localhost:{port}");
    let client = Client::new(&server_url).await.unwrap();

    let owner = client.new_agent("Owner").await.unwrap();
    let guest = client.new_agent("Guest").await.unwrap();
    let other = client.new_agent("Other").await.unwrap();
    let (drive, _) = drive_for(&client, &owner, "Leden", &[]).await;
    let claim = folder_in(&client, &owner, &drive, &[]).await;
    assert!(!http_get(&client, &guest, &claim).await);

    let expires = atomic_lib::utils::now() + 60_000;
    let token =
        atomic_lib::invite_token::InviteToken::new(claim.clone(), true, expires, &owner, Some(1))
            .unwrap()
            .encode()
            .unwrap();
    atomic_lib::client::helpers::accept_invite_at_server(&server_url, &token, &guest)
        .await
        .expect("the server accepts the invite");

    let target = atomic_lib::client::fetch_resource(&claim, client.store(), Some(&owner))
        .await
        .unwrap()
        .to_single();
    let writers: Vec<String> = target.get(urls::WRITE).unwrap().to_subjects(None).unwrap();
    assert!(writers.contains(&guest.subject.to_string()), "{writers:?}");
    assert!(
        http_get(&client, &guest, &claim).await,
        "the guest reads the target"
    );
    // The rest of the drive stays closed to the guest.
    assert!(!http_get(&client, &guest, &drive).await);

    assert!(
        atomic_lib::client::helpers::accept_invite_at_server(&server_url, &token, &other)
            .await
            .is_err(),
        "a one-use invite admitted a second agent"
    );
}
