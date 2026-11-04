//! Comments on any resource, as the web app's comment panel writes them: a
//! `ChatLog` page with `about` = the resource, under the `Comments` folder of a
//! drive (`commentsFolder` on the drive). The page's drive decides who can read
//! the comments, so one resource can carry comments for different audiences:
//! comments in a team drive on a document in a public drive are read by that
//! team only. See `planning/chat-log.md`.
//!
//! Reading collects the pages about a resource from every drive this device
//! holds (or from one drive), so a reader sees exactly the comments of the
//! drives they can read.

use super::{
    chats::{append_to_log, count_page_decode, Log},
    own_commit_opts,
    profiles::same_agent,
    LocalWritePusher,
};
use crate::{
    chat_log::Entry,
    commit::CommitBuilder,
    errors::{AtomicErrorType, AtomicResult},
    loro::AtomicLoroDoc,
    runtime::AtomicNode,
    storelike::Query,
    urls, Commit, Db, Storelike, Subject, Value,
};
use serde_json::{json, Value as Json};

/// Name of the folder a drive keeps its comment pages in, as the web app
/// names it.
pub const COMMENTS_FOLDER_NAME: &str = "Comments";

/// Entry field holding where in `about` a comment is placed (a W3C Web
/// Annotation `FragmentSelector` value, see [`post_comment`]).
pub const FIELD_ANCHOR: &str = "sel";

/// The `Comments` folder of `drive`, created (and pointed to from the drive)
/// on first use, as the web app's `getOrCreateCommentsFolder` does. A pointer
/// to a folder that no longer exists is stale and replaced; any other read
/// failure is returned, so a real folder is never orphaned.
pub async fn comments_folder(
    node: &AtomicNode,
    pusher: &dyn LocalWritePusher,
    drive: &str,
) -> AtomicResult<String> {
    let store = node.db();
    let mut drive_resource = store.get_resource(&Subject::from(drive)).await?;
    if let Some(existing) = drive_resource
        .get(urls::COMMENTS_FOLDER)
        .ok()
        .map(|v| v.to_string())
        .filter(|s| !s.is_empty())
    {
        match store.get_resource(&Subject::from(existing.as_str())).await {
            Ok(_) => return Ok(existing),
            Err(e) if e.error_type == AtomicErrorType::NotFoundError => {}
            Err(e) => return Err(e),
        }
    }

    let agent = store.get_default_agent()?;
    let mut builder = CommitBuilder::new("placeholder".into());
    builder.set(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::FOLDER.into()]),
    );
    builder.set(
        urls::NAME.into(),
        Value::String(COMMENTS_FOLDER_NAME.into()),
    );
    builder.set(urls::PARENT.into(), Value::AtomicUrl(drive.into()));
    let commit = Commit::create_did(builder, &agent, store).await?;
    let folder = commit.subject.to_string();
    let response = node.apply_local_commit(commit, &own_commit_opts()).await?;
    pusher.push(&response).await;

    drive_resource.set_unsafe(
        urls::COMMENTS_FOLDER.into(),
        Value::AtomicUrl(folder.as_str().into()),
    )?;
    let response = node.save_locally(&mut drive_resource).await?;
    pusher.push(&response).await;
    Ok(folder)
}

/// The drives to look in: `drive`, or every drive this device holds (the
/// query index is per drive).
async fn scopes(store: &Db, drive: Option<&str>) -> AtomicResult<Vec<Subject>> {
    Ok(match drive.filter(|d| !d.is_empty()) {
        Some(d) => vec![Subject::from(d)],
        None => store
            .list_drives()
            .await?
            .into_iter()
            .map(|d| Subject::from(d.subject.as_str()))
            .collect(),
    })
}

/// The `ChatLog` pages about `about`, in `drive` or in every drive this
/// device holds, oldest first (by `createdAt`, then subject).
pub(super) async fn pages_about(
    store: &Db,
    about: &str,
    drive: Option<&str>,
) -> AtomicResult<Vec<String>> {
    let mut found = Vec::new();
    for scope in scopes(store, drive).await? {
        let mut q = Query::new_prop_val(urls::ABOUT, about).class_filter(urls::CHAT_LOG);
        q.drive = Some(scope);
        found.extend(store.query(&q).await?.subjects);
    }
    let mut pages: Vec<(i64, String)> = found
        .iter()
        .filter_map(|s| {
            let page = store.get_resource_shallow(s).ok()?;
            let at = page
                .get(urls::CREATED_AT)
                .ok()
                .and_then(|v| v.to_int().ok())
                .unwrap_or(0);
            Some((at, s.to_string()))
        })
        .collect();
    pages.sort();
    pages.dedup_by(|a, b| a.1 == b.1);
    Ok(pages.into_iter().map(|(_, s)| s).collect())
}

/// Every `ChatLog` page with an `about`, in `drive` or in every drive.
async fn all_comment_pages(store: &Db, drive: Option<&str>) -> AtomicResult<Vec<String>> {
    let mut found = Vec::new();
    for scope in scopes(store, drive).await? {
        let mut q = Query::new_prop_val(urls::IS_A, urls::CHAT_LOG);
        q.drive = Some(scope);
        found.extend(store.query(&q).await?.subjects);
    }
    // A page can turn up under more than one scope (a drive the query
    // index does not tell apart): each page once.
    let mut seen = std::collections::HashSet::new();
    Ok(found
        .iter()
        .filter(|s| {
            store
                .get_resource_shallow(s)
                .ok()
                .is_some_and(|p| p.get(urls::ABOUT).is_ok())
        })
        .map(|s| s.to_string())
        .filter(|s| seen.insert(s.clone()))
        .collect())
}

fn page_doc(store: &Db, page: &str) -> Option<AtomicLoroDoc> {
    count_page_decode();
    let subject = Subject::from(page);
    match store.get_loro_snapshot(&subject) {
        Some(snapshot) => AtomicLoroDoc::from_snapshot(&snapshot).ok(),
        None => store
            .get_resource_shallow(&subject)
            .ok()?
            .build_state_doc()
            .ok(),
    }
}

/// The subjects mentioned in `text`: the `id` of each `[@id="…" label="…"]`
/// (the web app's mention markup), in order, each once.
pub fn mentions(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[@") {
        rest = &rest[start + 2..];
        let end = rest.find(']').unwrap_or(rest.len());
        let attrs = &rest[..end];
        if let Some(i) = attrs.find("id=\"") {
            let value = &attrs[i + 4..];
            if let Some(close) = value.find('"') {
                let id = value[..close].to_string();
                if !id.is_empty() && !out.contains(&id) {
                    out.push(id);
                }
            }
        }
        rest = &rest[end..];
    }
    out
}

/// The comments about `about` (all comments, when `None`) in `drive` or in
/// every drive this device holds, oldest first, as JSON `[{id, page, drive,
/// about, author, mine, text, c, reply_to?, edited?, mentions}]`: `id` is
/// `<page>#<key>`, `drive` the drive the page lives in (its audience),
/// `reply_to` the `id` answered, `edited` the time of the last edit (ms) and
/// `mentions` the subjects mentioned in the text, and `anchor` where in `about`
/// the comment is placed, when it is (see [`post_comment`]). Read from the
/// local store.
pub async fn read_comments(
    store: &Db,
    about: Option<&str>,
    drive: Option<&str>,
) -> AtomicResult<Vec<Json>> {
    let pages = match about {
        Some(about) => pages_about(store, about, drive).await?,
        None => all_comment_pages(store, drive).await?,
    };
    let me = store
        .get_default_agent()
        .map(|a| a.subject.to_string())
        .unwrap_or_default();
    let mut out: Vec<(i64, String, Json)> = Vec::new();
    for page in pages {
        let Ok(resource) = store.get_resource_shallow(&Subject::from(page.as_str())) else {
            continue;
        };
        let page_about = resource
            .get(urls::ABOUT)
            .map(|v| v.to_string())
            .unwrap_or_default();
        let page_drive = resource
            .get_drive()
            .map(|d| d.to_string())
            .unwrap_or_default();
        let Some(doc) = page_doc(store, &page) else {
            continue;
        };
        for (key, value) in doc.entries() {
            let Some(entry) = Entry::from_loro(&value) else {
                continue;
            };
            if entry.text.trim().is_empty() {
                continue;
            }
            let mut comment = json!({
                "id": format!("{page}#{key}"),
                "page": page,
                "drive": page_drive,
                "about": page_about,
                "author": entry.author,
                "mine": !me.is_empty() && same_agent(&entry.author, &me),
                "text": entry.text,
                "c": entry.created_at,
                "mentions": mentions(&entry.text),
            });
            if let Some(r) = &entry.reply_to {
                comment["reply_to"] = json!(r);
            }
            if let Some(e) = entry.edited_at {
                comment["edited"] = json!(e);
            }
            if let Some(loro::LoroValue::String(a)) = entry.extra.get(FIELD_ANCHOR) {
                comment["anchor"] = json!(a.to_string());
            }
            let c = entry.created_at;
            out.push((c, key, comment));
        }
    }
    out.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));
    Ok(out.into_iter().map(|(_, _, c)| c).collect())
}

/// Comment `text` (markdown, with the web app's mention markup) on `about` as
/// this device's agent, in `drive` (the audience; the drive of `about` when
/// `None`, as the web app does). `reply_to` is the `id` of the comment
/// answered. The entry goes on the newest page about `about` in that drive
/// with room, or on a new page in the drive's `Comments` folder. Returns the
/// entry's id (`<page>#<key>`).
///
/// `anchor` places the comment at a spot in `about`: the value of a W3C Web
/// Annotation `FragmentSelector`, for a PDF an RFC 3778 fragment such as
/// `page=3&viewrect=120,300,0,0` (PDF points from the top left). Stored as
/// the entry's `sel` field; a reader that does not know it shows a plain
/// comment.
pub async fn post_comment(
    node: &AtomicNode,
    pusher: &dyn LocalWritePusher,
    about: &str,
    drive: Option<&str>,
    text: &str,
    reply_to: Option<&str>,
    anchor: Option<&str>,
) -> AtomicResult<String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Cannot post an empty comment".into());
    }
    let store = node.db();
    let drive = match drive.filter(|d| !d.is_empty()) {
        Some(d) => d.to_string(),
        None => store
            .get_resource_shallow(&Subject::from(about))
            .ok()
            .and_then(|r| r.get_drive())
            .map(|d| d.to_string())
            .ok_or_else(|| format!("No drive known for {about}"))?,
    };
    let author = store.get_default_agent()?.subject.to_string();
    let mut entry = Entry::new(author, text, crate::utils::now());
    entry.reply_to = reply_to.filter(|r| !r.is_empty()).map(str::to_string);
    if let Some(anchor) = anchor.map(str::trim).filter(|a| !a.is_empty()) {
        entry.extra.insert(FIELD_ANCHOR.into(), anchor.into());
    }

    append_to_log(
        node,
        pusher,
        Log::Comments {
            about,
            drive: &drive,
        },
        &entry,
    )
    .await
}

/// The page and the entry of a comment `id` (`<page>#<key>`), if the entry is
/// this device's agent's own.
async fn own_entry(store: &Db, id: &str) -> AtomicResult<(crate::Resource, String, Entry)> {
    let (page, key) = id
        .rsplit_once('#')
        .ok_or_else(|| format!("Not a comment id: {id}"))?;
    let mut resource = store.get_resource(&Subject::from(page)).await?;
    let entry = resource
        .live_doc()?
        .get_entry(key)
        .as_ref()
        .and_then(Entry::from_loro)
        .ok_or_else(|| format!("No comment {id}"))?;
    let me = store.get_default_agent()?.subject.to_string();
    if !same_agent(&entry.author, &me) {
        return Err("Only the author can change a comment".into());
    }
    Ok((resource, key.to_string(), entry))
}

/// Replace the text of this agent's own comment `id`, marking it edited.
pub async fn edit_comment(
    node: &AtomicNode,
    pusher: &dyn LocalWritePusher,
    id: &str,
    text: &str,
) -> AtomicResult<()> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Cannot save an empty comment".into());
    }
    let (mut page, key, mut entry) = own_entry(node.db(), id).await?;
    entry.text = text.to_string();
    entry.edited_at = Some(crate::utils::now());
    page.live_doc()?.put_entry(&key, &entry)?;
    page.live_doc()?.commit();
    let response = node.save_locally(&mut page).await?;
    pusher.push(&response).await;
    Ok(())
}

/// Remove this agent's own comment `id`.
pub async fn delete_comment(
    node: &AtomicNode,
    pusher: &dyn LocalWritePusher,
    id: &str,
) -> AtomicResult<()> {
    let (mut page, key, _) = own_entry(node.db(), id).await?;
    page.live_doc()?.remove_entry(&key)?;
    page.live_doc()?.commit();
    let response = node.save_locally(&mut page).await?;
    pusher.push(&response).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{test_support::Device, NoPush};

    async fn doc_in(d: &Device, drive: &str, name: &str) -> String {
        d.store
            .create_resource(urls::FOLDER, drive, name, None)
            .await
            .unwrap()
    }

    #[test]
    fn mentions_are_read_from_the_markup() {
        let text = r#"Zie [@id="did:ad:a" label="Ada"] en [@ id="did:ad:b" label="Bo"], [@id="did:ad:a" label="Ada"]"#;
        assert_eq!(mentions(text), ["did:ad:a", "did:ad:b"]);
        assert!(mentions("geen [link](x)").is_empty());
    }

    #[tokio::test]
    async fn a_comment_lands_in_the_comments_folder_and_is_read_back() {
        let d = Device::new().await;
        let doc = doc_in(&d, &d.drive, "Raadsvoorstel").await;
        let first = post_comment(&d.node, &NoPush, &doc, None, "Eens", None, None)
            .await
            .unwrap();
        let second = post_comment(&d.node, &NoPush, &doc, None, "Ik niet", Some(&first), None)
            .await
            .unwrap();
        // One page, in the drive's Comments folder, about the document.
        let page = first.split('#').next().unwrap();
        assert_eq!(second.split('#').next().unwrap(), page);
        let page_resource = d.store.get_resource(&Subject::from(page)).await.unwrap();
        let folder = page_resource.get(urls::PARENT).unwrap().to_string();
        let drive = d
            .store
            .get_resource(&Subject::from(d.drive.as_str()))
            .await
            .unwrap();
        assert_eq!(
            drive.get(urls::COMMENTS_FOLDER).unwrap().to_string(),
            folder
        );
        assert_eq!(page_resource.get(urls::ABOUT).unwrap().to_string(), doc);

        let comments = read_comments(&d.store, Some(&doc), None).await.unwrap();
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[0]["text"], "Eens");
        assert_eq!(comments[0]["mine"], true);
        assert_eq!(comments[0]["about"], doc.as_str());
        assert_eq!(comments[0]["drive"], d.drive.as_str());
        assert_eq!(comments[1]["reply_to"], first.as_str());

        // All comments, once each however many drives there are, and none
        // about another resource.
        d.store.create_drive("Nog een").await.unwrap();
        d.store.set_active_drive(&d.drive).unwrap();
        assert_eq!(read_comments(&d.store, None, None).await.unwrap().len(), 2);
        let other = doc_in(&d, &d.drive, "Motie").await;
        assert!(read_comments(&d.store, Some(&other), None)
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn comments_in_another_drive_are_kept_apart() {
        let d = Device::new().await;
        let doc = doc_in(&d, &d.drive, "Raadsvoorstel").await;
        let team = d.store.create_drive("Fractie").await.unwrap();
        post_comment(&d.node, &NoPush, &doc, None, "Openbaar", None, None)
            .await
            .unwrap();
        post_comment(&d.node, &NoPush, &doc, Some(&team), "Alleen fractie", None, None)
            .await
            .unwrap();
        let all = read_comments(&d.store, Some(&doc), None).await.unwrap();
        assert_eq!(all.len(), 2);
        let in_team = read_comments(&d.store, Some(&doc), Some(&team))
            .await
            .unwrap();
        assert_eq!(in_team.len(), 1);
        assert_eq!(in_team[0]["text"], "Alleen fractie");
        assert_eq!(in_team[0]["drive"], team.as_str());
    }

    #[tokio::test]
    async fn a_placed_comment_keeps_its_anchor_through_an_edit() {
        let d = Device::new().await;
        let doc = doc_in(&d, &d.drive, "Motie").await;
        let at = "page=3&viewrect=120,300,0,0";
        let id = post_comment(&d.node, &NoPush, &doc, None, "Hier", None, Some(at))
            .await
            .unwrap();
        post_comment(&d.node, &NoPush, &doc, None, "Algemeen", None, None)
            .await
            .unwrap();
        edit_comment(&d.node, &NoPush, &id, "Precies hier").await.unwrap();
        let comments = read_comments(&d.store, Some(&doc), None).await.unwrap();
        assert_eq!(comments[0]["text"], "Precies hier");
        assert_eq!(comments[0]["anchor"], at);
        assert!(comments[1].get("anchor").is_none());
    }

    #[tokio::test]
    async fn an_own_comment_can_be_edited_and_deleted() {
        let d = Device::new().await;
        let doc = doc_in(&d, &d.drive, "Motie").await;
        let id = post_comment(&d.node, &NoPush, &doc, None, "Eerst", None, None)
            .await
            .unwrap();
        edit_comment(&d.node, &NoPush, &id, "Daarna").await.unwrap();
        let comments = read_comments(&d.store, Some(&doc), None).await.unwrap();
        assert_eq!(comments[0]["text"], "Daarna");
        assert!(comments[0]["edited"].is_i64());
        delete_comment(&d.node, &NoPush, &id).await.unwrap();
        assert!(read_comments(&d.store, Some(&doc), None)
            .await
            .unwrap()
            .is_empty());
        assert!(post_comment(&d.node, &NoPush, &doc, None, "  ", None, None)
            .await
            .is_err());
    }
}
