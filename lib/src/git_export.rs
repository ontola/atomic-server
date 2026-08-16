//! Snapshot a drive as a git working tree (and optionally a git repo).
//!
//! Content-reversible interchange: markdown + JSON-AD keyed by `localId`.
//! Not a replica of Loro history, signed commits, or original DIDs.
//! See `planning/drive-as-git.md`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::agents::ForAgent;
use crate::db::trees::Tree;
use crate::errors::AtomicResult;
use crate::parse::{ParseOpts, SaveOpts};
use crate::storelike::Query;
use crate::values::SubResource;
use crate::{urls, Db, Resource, Storelike, Subject, Value};

/// On-disk format identifier written to `index.json`.
pub const FORMAT_ID: &str = "atomic-git-export";
/// Layout version. Bump when `index.json` or the path mapping changes.
pub const FORMAT_VERSION: u32 = 2;

const FORMAT_DOC: &str = r#"# atomic-git-export v2

This directory is an Atomic Data drive exported as a git working tree.
See planning/drive-as-git.md in the Atomic repo for the design.

## Layout

- Human-readable files follow the drive's folder tree (markdown, binaries, JSON).
- `.atomic/index.json` maps each `localId` to its path and kind.
- `.atomic/resources/` holds pretty JSON-AD keyed by `localId` (no `@id`, no Loro binary).
- `.atomic/drive.json` is the drive resource (also `localId`-keyed).
- `.atomic/loro/` (optional) holds raw Loro snapshots.

Identity is `localId` (stable path, or an explicit property). Re-import mints
new DIDs the first time and is idempotent after that. Document bodies live in
the `.md` files (lossless markdown+HTML). File bytes keep `did:ad:blob:{blake3}`.
"#;

const STRIP_PROPS: &[&str] = &[
    urls::LORO_UPDATE,
    urls::LAST_COMMIT,
    urls::PREVIOUS_COMMIT,
    urls::SIGNATURE,
    urls::CREATED_AT,
    urls::CREATED_BY,
    urls::IS_GENESIS,
    urls::GENESIS,
    urls::DRIVE_PROP,
    urls::DOCUMENT_CONTENT,
];

/// How a resource is projected into the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Drive,
    Folder,
    File,
    Document,
    Resource,
}

/// One resource in `.atomic/index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub local_id: String,
    pub path: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// Root of `.atomic/index.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportIndex {
    pub format: String,
    pub version: u32,
    pub drive: String,
    pub exported_at: i64,
    pub entries: Vec<IndexEntry>,
}

/// Options for [`export_drive`].
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Write File blob bytes at the human path. Default true.
    pub include_blobs: bool,
    /// Write raw Loro snapshots under `.atomic/loro/`. Default false.
    pub include_loro_snapshots: bool,
    /// Run `git init` + commit in `dest`. Default true.
    pub init_git: bool,
    /// Override the git commit message.
    pub git_message: Option<String>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_blobs: true,
            include_loro_snapshots: false,
            init_git: true,
            git_message: None,
        }
    }
}

/// Result of [`export_drive`].
#[derive(Debug, Clone)]
pub struct ExportReport {
    pub dest: PathBuf,
    pub resources: usize,
    pub files_written: usize,
    pub git_commit: Option<String>,
}

/// Result of [`import_as_new_drive`] / [`import_into_drive`].
#[derive(Debug, Clone)]
pub struct ImportReport {
    pub drive: String,
    pub created: usize,
    /// `localId` → minted or reused DID.
    pub subjects: BTreeMap<String, String>,
}

/// Export `drive` into `dest` as an `atomic-git-export` tree, optionally a git repo.
pub async fn export_drive(
    store: &Db,
    drive: &Subject,
    dest: &Path,
    opts: &ExportOptions,
) -> AtomicResult<ExportReport> {
    std::fs::create_dir_all(dest)?;
    std::fs::create_dir_all(dest.join(".atomic/resources"))?;
    if opts.include_loro_snapshots {
        std::fs::create_dir_all(dest.join(".atomic/loro"))?;
    }

    let drive_resource = store.get_resource(drive).await?;
    let drive_name = display_name(&drive_resource);
    let resources = collect_drive_resources(store, drive).await?;

    let mut children_of: HashMap<String, Vec<String>> = HashMap::new();
    let mut by_id: HashMap<String, Resource> = HashMap::new();
    for resource in resources {
        let id = resource.get_subject().pure_id();
        if let Ok(parent) = resource.get(urls::PARENT) {
            children_of
                .entry(parent.to_string())
                .or_default()
                .push(id.clone());
        }
        by_id.insert(id, resource);
    }

    let mut paths: HashMap<String, String> = HashMap::new();
    let mut kinds: HashMap<String, EntryKind> = HashMap::new();
    assign_paths(
        &drive.pure_id(),
        "",
        &by_id,
        &children_of,
        &mut paths,
        &mut kinds,
    );

    let local_ids = assign_local_ids(&by_id, &paths, &drive.pure_id());
    let did_to_local: HashMap<String, String> = local_ids
        .iter()
        .map(|(did, local)| (did.clone(), local.clone()))
        .collect();

    let mut files_written = 0usize;
    let exported_at = crate::utils::now();

    let mut index_entries = Vec::new();
    let mut id_order: Vec<String> = by_id.keys().cloned().collect();
    id_order.sort();

    for id in &id_order {
        let resource = by_id.get_mut(id).expect("id from by_id");
        let kind = *kinds.get(id).unwrap_or(&EntryKind::Resource);
        let rel = paths.get(id).cloned().unwrap_or_default();
        let local_id = local_ids.get(id).cloned().unwrap_or_else(|| rel.clone());
        let class = classes(resource).into_iter().next();
        let parent = resource
            .get(urls::PARENT)
            .ok()
            .map(|v| v.to_string())
            .and_then(|did| did_to_local.get(&did).cloned());

        index_entries.push(IndexEntry {
            local_id: local_id.clone(),
            path: rel.clone(),
            kind,
            class,
            parent,
        });

        write_sidecar(dest, resource, &local_id, &did_to_local, &drive.pure_id())?;
        files_written += 1;

        if opts.include_loro_snapshots {
            if let Some(snapshot) = resource.materialized_state() {
                if !snapshot.is_empty() {
                    std::fs::write(
                        dest.join(".atomic/loro")
                            .join(format!("{}.bin", sidecar_stem(&local_id))),
                        snapshot,
                    )?;
                    files_written += 1;
                }
            }
        }

        if id == &drive.pure_id() {
            continue;
        }

        files_written += write_projection(
            store,
            dest,
            resource,
            &rel,
            kind,
            opts,
            &did_to_local,
            &drive.pure_id(),
        )?;
    }

    index_entries.sort_by(|a, b| a.path.cmp(&b.path).then(a.local_id.cmp(&b.local_id)));
    let drive_local = local_ids
        .get(&drive.pure_id())
        .cloned()
        .unwrap_or_else(|| "drive".into());
    let index = ExportIndex {
        format: FORMAT_ID.into(),
        version: FORMAT_VERSION,
        drive: drive_local,
        exported_at,
        entries: index_entries,
    };
    std::fs::write(
        dest.join(".atomic/index.json"),
        serde_json::to_string_pretty(&index)? + "\n",
    )?;
    files_written += 1;

    std::fs::write(
        dest.join(".atomic/drive.json"),
        resource_to_portable_json_ad(&drive_resource, &did_to_local, &drive.pure_id())?,
    )?;
    files_written += 1;

    std::fs::write(dest.join(".atomic/FORMAT.md"), FORMAT_DOC)?;
    files_written += 1;

    let readme = format!(
        "# {}\n\nThis directory is an [Atomic Data](https://atomicdata.dev) drive exported as a git repository.\n\nHuman-readable files follow the drive hierarchy. Identity is `localId` under `.atomic/`.\n\nSee `.atomic/FORMAT.md` for the layout.\n",
        drive_name
    );
    std::fs::write(dest.join("README.md"), readme)?;
    files_written += 1;

    std::fs::write(dest.join(".gitignore"), ".DS_Store\n")?;
    files_written += 1;

    let git_commit = if opts.init_git {
        let message = opts
            .git_message
            .clone()
            .unwrap_or_else(|| format!("Atomic export of {drive_name}"));
        Some(git_init_and_commit(dest, &message)?)
    } else {
        None
    };

    Ok(ExportReport {
        dest: dest.to_path_buf(),
        resources: by_id.len(),
        files_written,
        git_commit,
    })
}

/// Create a new drive from an `atomic-git-export` directory. Mints new DIDs
/// on first import; a second import into the same drive reuses them.
pub async fn import_as_new_drive(store: &Db, src: &Path) -> AtomicResult<ImportReport> {
    let index = read_index(src)?;
    let drive_name = drive_name_from_export(src, &index);
    let drive = store.create_drive(&drive_name).await?;
    import_into_drive(store, src, &Subject::from(drive.as_str())).await
}

/// Import (or re-import) an export into an existing drive. Idempotent: the
/// same `localId`s resolve to the same DIDs.
pub async fn import_into_drive(
    store: &Db,
    src: &Path,
    drive: &Subject,
) -> AtomicResult<ImportReport> {
    let index = read_index(src)?;
    if index.format != FORMAT_ID {
        return Err(format!("unknown export format {}", index.format).into());
    }

    let mut drive_resource = store.get_resource(drive).await?;
    if drive_resource.get(urls::LOCAL_ID).is_err() {
        drive_resource
            .set(
                urls::LOCAL_ID.into(),
                Value::String(index.drive.clone()),
                store,
            )
            .await?;
        drive_resource.save_locally(store).await?;
    }

    insert_file_blobs(store, src, &index)?;

    let mut objects = Vec::new();
    for entry in &index.entries {
        if entry.kind == EntryKind::Drive || entry.local_id == index.drive {
            continue;
        }
        let sidecar = read_sidecar(src, &entry.local_id)?;
        objects.push(sidecar);
    }

    let json = serde_json::Value::Array(objects);
    let mut reserved = std::collections::HashMap::new();
    reserved.insert(index.drive.clone(), drive.pure_id());
    let parse_opts = ParseOpts {
        importer: Some(drive.clone()),
        save: SaveOpts::Commit,
        signer: Some(store.get_default_agent()?),
        for_agent: ForAgent::Sudo,
        overwrite_outside: false,
        reserved_local_ids: reserved,
        ..ParseOpts::default()
    };
    let imported =
        crate::parse::parse_json_ad_string(&serde_json::to_string(&json)?, store, &parse_opts)
            .await?;

    let mut subjects = BTreeMap::new();
    subjects.insert(index.drive.clone(), drive.pure_id());
    for resource in &imported {
        if let Ok(Value::String(local_id)) = resource.get(urls::LOCAL_ID) {
            subjects.insert(local_id.clone(), resource.get_subject().pure_id());
        }
    }

    let rewrite = |s: &str| subjects.get(s).cloned();
    let mut created = 0usize;
    for entry in &index.entries {
        if entry.kind == EntryKind::Drive {
            continue;
        }
        created += 1;
        if entry.kind != EntryKind::Document {
            continue;
        }
        let Some(did) = subjects.get(&entry.local_id) else {
            continue;
        };
        let markdown = std::fs::read_to_string(src.join(&entry.path)).unwrap_or_default();
        if markdown.trim().is_empty() {
            continue;
        }
        let mut pm = crate::git_md::parse(&markdown);
        crate::git_md::rewrite_pm_refs(&mut pm, &rewrite);
        let mut resource = store.get_resource(&Subject::from(did.as_str())).await?;
        resource.set_document_json(&pm)?;
        if resource.get(urls::DESCRIPTION).is_err() {
            resource
                .set(
                    urls::DESCRIPTION.into(),
                    Value::Markdown(markdown.trim().to_string()),
                    store,
                )
                .await?;
        } else {
            // Touch a property so `save_locally` persists the Loro body when
            // the commit builder was not dirtied by `set_document_json`.
            let name = resource
                .get(urls::NAME)
                .ok()
                .and_then(value_string)
                .unwrap_or_else(|| entry.local_id.clone());
            resource
                .set(urls::NAME.into(), Value::String(name), store)
                .await?;
        }
        resource.save_locally(store).await?;
    }

    Ok(ImportReport {
        drive: drive.pure_id(),
        created,
        subjects,
    })
}

/// Build a small drive used by the example and tests: folder, document, file, bookmark.
pub async fn write_sample_drive(store: &Db) -> AtomicResult<String> {
    let drive = store.create_drive("Git Export Demo").await?;
    let mut drive_resource = store.get_resource(&Subject::from(drive.as_str())).await?;
    drive_resource
        .set(urls::LOCAL_ID.into(), Value::String("drive".into()), store)
        .await?;
    drive_resource.save_locally(store).await?;

    let notes = store
        .create_resource(
            urls::FOLDER,
            &drive,
            "Notes",
            Some(vec![(urls::LOCAL_ID, Value::String("Notes".into()))]),
        )
        .await?;

    let bookmark = store
        .create_resource(
            urls::BOOKMARK,
            &drive,
            "Atomic Data",
            Some(vec![
                (urls::LOCAL_ID, Value::String("Atomic Data.json".into())),
                (urls::URL, Value::String("https://atomicdata.dev".into())),
            ]),
        )
        .await?;

    let doc_id = store
        .create_resource(
            urls::DOCUMENT_V2,
            &notes,
            "Hello",
            Some(vec![
                (urls::LOCAL_ID, Value::String("Notes/Hello.md".into())),
                (
                    urls::DESCRIPTION,
                    Value::Markdown("A fallback body if the Loro document is empty.".into()),
                ),
            ]),
        )
        .await?;

    let doc_json = serde_json::json!({
        "type": "doc",
        "content": [
            {
                "type": "heading",
                "attrs": { "level": 1 },
                "content": [{ "type": "text", "text": "Hello from Atomic" }]
            },
            {
                "type": "paragraph",
                "content": [
                    { "type": "text", "text": "bold", "marks": [{ "type": "bold" }] },
                    { "type": "text", "text": " and " },
                    { "type": "text", "text": "italic", "marks": [{ "type": "italic" }] }
                ]
            },
            {
                "type": "bulletList",
                "content": [{
                    "type": "listItem",
                    "content": [{
                        "type": "paragraph",
                        "content": [{ "type": "text", "text": "one" }]
                    }]
                }]
            },
            {
                "type": "atomic-data-resource",
                "attrs": { "subject": bookmark }
            }
        ]
    });

    let mut doc_resource = store.get_resource(&Subject::from(doc_id.as_str())).await?;
    doc_resource.set_document_json(&doc_json)?;
    doc_resource
        .set(
            urls::DESCRIPTION.into(),
            Value::Markdown("Hello from Atomic".into()),
            store,
        )
        .await?;
    doc_resource.save_locally(store).await?;

    let bytes = b"hello git export\n";
    let hash = blake3::hash(bytes);
    let hash_hex = hash.to_hex().to_string();
    store.kv.insert(Tree::Blobs, hash.as_bytes(), bytes)?;
    store
        .create_resource(
            urls::FILE,
            &drive,
            "hello.txt",
            Some(vec![
                (urls::LOCAL_ID, Value::String("hello.txt".into())),
                (urls::FILENAME, Value::String("hello.txt".into())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
                ),
                (urls::INTERNAL_ID, Value::String(hash_hex)),
                (urls::FILESIZE, Value::Integer(bytes.len() as i64)),
                (urls::MIMETYPE, Value::String("text/plain".into())),
                (urls::DOWNLOAD_URL, Value::String("hello.txt".into())),
            ]),
        )
        .await?;

    Ok(drive)
}

fn assign_local_ids(
    by_id: &HashMap<String, Resource>,
    paths: &HashMap<String, String>,
    drive_id: &str,
) -> HashMap<String, String> {
    let mut local_ids = HashMap::new();
    let mut used = HashSet::new();
    let mut ids: Vec<String> = by_id.keys().cloned().collect();
    ids.sort();
    for id in ids {
        let resource = by_id.get(&id).expect("id from by_id");
        let existing = resource
            .get(urls::LOCAL_ID)
            .ok()
            .and_then(value_string)
            .filter(|s| !s.is_empty());
        let desired = existing.unwrap_or_else(|| {
            let path = paths.get(&id).cloned().unwrap_or_default();
            if path.is_empty() {
                if id == drive_id {
                    "drive".into()
                } else {
                    sanitize_name(&display_name(resource))
                }
            } else {
                path
            }
        });
        let unique = if used.insert(desired.clone()) {
            desired
        } else {
            let mut n = 2;
            loop {
                let candidate = format!("{desired}~{n}");
                if used.insert(candidate.clone()) {
                    break candidate;
                }
                n += 1;
            }
        };
        local_ids.insert(id, unique);
    }
    local_ids
}

async fn collect_drive_resources(store: &Db, drive: &Subject) -> AtomicResult<Vec<Resource>> {
    let mut seen = HashSet::new();
    let mut queue = vec![drive.pure_id()];
    let mut out = Vec::new();

    while let Some(current) = queue.pop() {
        if !seen.insert(current.clone()) {
            continue;
        }
        let subject = Subject::from(current.as_str());
        if subject.is_commit_did() {
            continue;
        }
        let resource = store.get_resource(&subject).await?;
        let q = Query {
            property: Some(urls::PARENT.into()),
            value: Some(Value::AtomicUrl(current.clone().into())),
            filters: Vec::new(),
            limit: None,
            start_val: None,
            end_val: None,
            offset: 0,
            sort_by: None,
            sort_desc: false,
            include_external: true,
            include_nested: false,
            for_agent: ForAgent::Sudo,
            aggregation: None,
            expression_filters: Vec::new(),
            drive: None,
        };
        if let Ok(result) = store.query(&q).await {
            for child in result.subjects {
                queue.push(child.pure_id());
            }
        }
        out.push(resource);
    }

    Ok(out)
}

fn assign_paths(
    id: &str,
    dir: &str,
    by_id: &HashMap<String, Resource>,
    children_of: &HashMap<String, Vec<String>>,
    paths: &mut HashMap<String, String>,
    kinds: &mut HashMap<String, EntryKind>,
) {
    let Some(resource) = by_id.get(id) else {
        return;
    };
    let child_ids = children_of.get(id).cloned().unwrap_or_default();
    let kind = classify(resource, child_ids.len());
    kinds.insert(id.to_string(), kind);

    if dir.is_empty() {
        paths.insert(id.to_string(), String::new());
    }

    let mut used: HashSet<String> = HashSet::new();
    let mut kids = child_ids;
    kids.sort();
    for child_id in kids {
        let Some(child) = by_id.get(&child_id) else {
            continue;
        };
        let child_count = children_of.get(&child_id).map(|c| c.len()).unwrap_or(0);
        let child_kind = classify(child, child_count);
        let base = unique_name(
            &projection_basename(child, child_kind, child_count),
            &mut used,
        );
        let rel = if dir.is_empty() {
            base
        } else {
            format!("{dir}/{base}")
        };
        paths.insert(child_id.clone(), rel.clone());
        kinds.insert(child_id.clone(), child_kind);

        if writes_directory(child_kind, child_count) {
            let next_dir = rel.trim_end_matches("/index.md").to_string();
            assign_paths(&child_id, &next_dir, by_id, children_of, paths, kinds);
        }
    }
}

fn classify(resource: &Resource, child_count: usize) -> EntryKind {
    let classes = classes(resource);
    if classes.iter().any(|c| c == urls::DRIVE) {
        EntryKind::Drive
    } else if classes.iter().any(|c| c == urls::FOLDER) {
        EntryKind::Folder
    } else if classes.iter().any(|c| c == urls::FILE) {
        EntryKind::File
    } else if classes.iter().any(|c| c == urls::DOCUMENT_V2) {
        EntryKind::Document
    } else if child_count > 0 {
        EntryKind::Folder
    } else {
        EntryKind::Resource
    }
}

fn writes_directory(kind: EntryKind, child_count: usize) -> bool {
    match kind {
        EntryKind::Drive | EntryKind::Folder => true,
        EntryKind::File => false,
        EntryKind::Document => child_count > 0,
        EntryKind::Resource => child_count > 0,
    }
}

fn projection_basename(resource: &Resource, kind: EntryKind, child_count: usize) -> String {
    let name = sanitize_name(&display_name(resource));
    match kind {
        EntryKind::File => name,
        EntryKind::Document if child_count > 0 => format!("{name}/index.md"),
        EntryKind::Document => ensure_ext(&name, "md"),
        EntryKind::Folder | EntryKind::Drive => name,
        EntryKind::Resource if child_count > 0 => name,
        EntryKind::Resource => ensure_ext(&name, "json"),
    }
}

fn unique_name(desired: &str, used: &mut HashSet<String>) -> String {
    if used.insert(desired.to_string()) {
        return desired.to_string();
    }
    let (stem, ext) = split_ext(desired);
    let mut n = 2;
    loop {
        let candidate = if ext.is_empty() {
            format!("{stem} ({n})")
        } else {
            format!("{stem} ({n}).{ext}")
        };
        if used.insert(candidate.clone()) {
            return candidate;
        }
        n += 1;
    }
}

fn split_ext(name: &str) -> (String, String) {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !stem.contains('/') => {
            (stem.to_string(), ext.to_string())
        }
        _ => (name.to_string(), String::new()),
    }
}

fn ensure_ext(name: &str, ext: &str) -> String {
    if name.rsplit_once('.').is_some_and(|(_, e)| e == ext) {
        name.to_string()
    } else {
        format!("{name}.{ext}")
    }
}

fn sidecar_stem(local_id: &str) -> String {
    local_id.replace([':', '/', '\\'], "_")
}

fn sidecar_path(dest: &Path, local_id: &str) -> PathBuf {
    dest.join(".atomic/resources")
        .join(format!("{}.json", sidecar_stem(local_id)))
}

fn write_sidecar(
    dest: &Path,
    resource: &Resource,
    local_id: &str,
    did_to_local: &HashMap<String, String>,
    drive_did: &str,
) -> AtomicResult<()> {
    std::fs::write(
        sidecar_path(dest, local_id),
        resource_to_portable_json_ad(resource, did_to_local, drive_did)?,
    )?;
    Ok(())
}

fn write_projection(
    store: &Db,
    dest: &Path,
    resource: &mut Resource,
    rel: &str,
    kind: EntryKind,
    opts: &ExportOptions,
    did_to_local: &HashMap<String, String>,
    drive_did: &str,
) -> AtomicResult<usize> {
    if rel.is_empty() {
        return Ok(0);
    }
    match kind {
        EntryKind::Drive | EntryKind::Folder => {
            std::fs::create_dir_all(dest.join(rel))?;
            Ok(0)
        }
        EntryKind::File => {
            if !opts.include_blobs {
                return Ok(0);
            }
            let Some(bytes) = read_file_bytes(store, resource) else {
                return Ok(0);
            };
            let path = dest.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, bytes)?;
            Ok(1)
        }
        EntryKind::Document => {
            let body = document_export_markdown(resource, did_to_local);
            let path = dest.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, body)?;
            Ok(1)
        }
        EntryKind::Resource => {
            let path = dest.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(
                path,
                resource_to_portable_json_ad(resource, did_to_local, drive_did)?,
            )?;
            Ok(1)
        }
    }
}

fn document_export_markdown(
    resource: &mut Resource,
    did_to_local: &HashMap<String, String>,
) -> String {
    if let Some(mut json) = resource.document_json() {
        crate::git_md::rewrite_pm_refs(&mut json, &|s| did_to_local.get(s).cloned());
        let md = crate::git_md::serialize(&json);
        if !md.trim().is_empty() {
            return md;
        }
    }
    let mut body = resource.document_markdown();
    if body.trim().is_empty() {
        if let Ok(value) = resource.get(urls::DESCRIPTION) {
            body = match value {
                Value::Markdown(s) | Value::String(s) => format!("{}\n", s.trim()),
                _ => String::new(),
            };
        }
    }
    if body.trim().is_empty() {
        body = format!("# {}\n", display_name(resource));
    }
    body
}

fn read_file_bytes(store: &Db, resource: &Resource) -> Option<Vec<u8>> {
    if let Ok(Value::ResourceArray(chunks)) = resource.get(urls::CHUNKS) {
        if !chunks.is_empty() {
            let mut out = Vec::new();
            for chunk in chunks {
                out.extend_from_slice(&blob_by_did(store, &chunk.to_string())?);
            }
            return Some(out);
        }
    }
    if let Ok(internal_id) = resource.get(urls::INTERNAL_ID) {
        if let Some(hex) = value_string(internal_id) {
            if let Some(bytes) = blob_by_hash_hex(store, &hex) {
                return Some(bytes);
            }
        }
    }
    if let Ok(blob) = resource.get(urls::BLOB) {
        return blob_by_did(store, &blob.to_string());
    }
    None
}

fn blob_by_did(store: &Db, did: &str) -> Option<Vec<u8>> {
    let subject = Subject::from(did);
    let hex = subject.blob_hash_hex()?;
    blob_by_hash_hex(store, hex)
}

fn blob_by_hash_hex(store: &Db, hex: &str) -> Option<Vec<u8>> {
    let bytes = hex::decode(hex).ok()?;
    store.kv.get(Tree::Blobs, &bytes).ok().flatten()
}

fn resource_to_portable_json_ad(
    resource: &Resource,
    did_to_local: &HashMap<String, String>,
    drive_did: &str,
) -> AtomicResult<String> {
    let mut propvals = resource.get_propvals().clone();
    for key in STRIP_PROPS {
        propvals.remove(*key);
    }
    let local_id = resource
        .get(urls::LOCAL_ID)
        .ok()
        .and_then(value_string)
        .or_else(|| did_to_local.get(&resource.get_subject().pure_id()).cloned())
        .unwrap_or_else(|| resource.get_subject().pure_id());
    propvals.insert(urls::LOCAL_ID.into(), Value::String(local_id.clone()));
    if classes(resource).iter().any(|c| c == urls::FILE)
        && !propvals.contains_key(urls::DOWNLOAD_URL)
    {
        let filename = resource
            .get(urls::FILENAME)
            .ok()
            .and_then(value_string)
            .unwrap_or_else(|| local_id.clone());
        propvals.insert(urls::DOWNLOAD_URL.into(), Value::String(filename));
    }

    if let Ok(parent) = resource.get(urls::PARENT) {
        let parent_s = parent.to_string();
        if parent_s == drive_did {
            // Importer is the drive; JSON-AD import fills parent in.
            propvals.remove(urls::PARENT);
        } else if let Some(local) = did_to_local.get(&parent_s) {
            propvals.insert(urls::PARENT.into(), Value::String(local.clone()));
        }
    }

    rewrite_propval_refs(&mut propvals, did_to_local);

    let mut json =
        crate::serialize::propvals_to_json_ad_map(&propvals, None, "http://localhost", false)?;
    rewrite_json_refs(&mut json, did_to_local);
    Ok(serde_json::to_string_pretty(&sort_json(json))? + "\n")
}

fn rewrite_propval_refs(
    propvals: &mut crate::resources::PropVals,
    did_to_local: &HashMap<String, String>,
) {
    for (key, value) in propvals.clone() {
        if key == urls::LOCAL_ID || STRIP_PROPS.contains(&key.as_str()) {
            continue;
        }
        if let Some(next) = rewrite_value(value, did_to_local) {
            propvals.insert(key, next);
        }
    }
}

fn rewrite_value(value: Value, did_to_local: &HashMap<String, String>) -> Option<Value> {
    match value {
        Value::AtomicUrl(subject) => {
            let s = subject.to_string();
            if s.starts_with("did:ad:blob:") {
                return None;
            }
            did_to_local
                .get(&s)
                .map(|local| Value::String(local.clone()))
        }
        Value::ResourceArray(items) => {
            let mut changed = false;
            let next: Vec<SubResource> = items
                .into_iter()
                .map(|item| {
                    let s = item.to_string();
                    if let Some(local) = did_to_local.get(&s) {
                        changed = true;
                        SubResource::from(local.as_str())
                    } else {
                        item
                    }
                })
                .collect();
            changed.then_some(Value::ResourceArray(next))
        }
        _ => None,
    }
}

fn rewrite_json_refs(value: &mut serde_json::Value, did_to_local: &HashMap<String, String>) {
    match value {
        serde_json::Value::String(s) => {
            if s.starts_with("did:ad:blob:") {
                return;
            }
            if let Some(local) = did_to_local.get(s) {
                *s = local.clone();
            }
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                rewrite_json_refs(item, did_to_local);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, val) in map.iter_mut() {
                if key == "@id" {
                    continue;
                }
                rewrite_json_refs(val, did_to_local);
            }
        }
        _ => {}
    }
}

fn sort_json(value: serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut sorted = serde_json::Map::new();
            let keys: BTreeMap<_, _> = map.into_iter().collect();
            for (key, val) in keys {
                sorted.insert(key, sort_json(val));
            }
            serde_json::Value::Object(sorted)
        }
        serde_json::Value::Array(arr) => {
            serde_json::Value::Array(arr.into_iter().map(sort_json).collect())
        }
        other => other,
    }
}

fn git_init_and_commit(dest: &Path, message: &str) -> AtomicResult<String> {
    run_git(dest, &["init"])?;
    run_git(dest, &["add", "-A"])?;
    run_git(
        dest,
        &[
            "-c",
            "user.name=Atomic Export",
            "-c",
            "user.email=export@atomic.local",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            message,
        ],
    )?;
    let sha = run_git(dest, &["rev-parse", "HEAD"])?;
    Ok(sha.trim().to_string())
}

fn run_git(cwd: &Path, args: &[&str]) -> AtomicResult<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git {:?} failed to start: {e}", args))?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        )
        .into());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn read_index(src: &Path) -> AtomicResult<ExportIndex> {
    let path = src.join(".atomic/index.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("not an atomic-git-export (missing {}): {e}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

fn read_sidecar(src: &Path, local_id: &str) -> AtomicResult<serde_json::Value> {
    let path = sidecar_path(src, local_id);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("missing sidecar {}: {e}", path.display()))?;
    Ok(serde_json::from_str(&text)?)
}

fn drive_name_from_export(src: &Path, index: &ExportIndex) -> String {
    if let Ok(drive_json) = std::fs::read_to_string(src.join(".atomic/drive.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&drive_json) {
            if let Some(name) = value.get(urls::NAME).and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    return name.to_string();
                }
            }
        }
    }
    std::fs::read_to_string(src.join("README.md"))
        .ok()
        .and_then(|text| {
            text.lines()
                .next()
                .map(|line| line.trim_start_matches('#').trim().to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| index.drive.clone())
}

fn insert_file_blobs(store: &Db, src: &Path, index: &ExportIndex) -> AtomicResult<()> {
    for entry in &index.entries {
        if entry.kind != EntryKind::File || entry.path.is_empty() {
            continue;
        }
        let bytes = std::fs::read(src.join(&entry.path)).unwrap_or_default();
        let hash = blake3::hash(&bytes);
        store.kv.insert(Tree::Blobs, hash.as_bytes(), &bytes)?;
    }
    Ok(())
}

fn classes(resource: &Resource) -> Vec<String> {
    match resource.get(urls::IS_A) {
        Ok(Value::ResourceArray(array)) => array.iter().map(SubResource::to_string).collect(),
        _ => Vec::new(),
    }
}

fn display_name(resource: &Resource) -> String {
    for property in [urls::FILENAME, urls::NAME, urls::SHORTNAME] {
        if let Ok(value) = resource.get(property) {
            if let Some(string) = value_string(value) {
                if !string.is_empty() {
                    return string;
                }
            }
        }
    }
    let subject = resource.get_subject().as_str();
    subject
        .rsplit(|c| c == '/' || c == ':')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(subject)
        .to_string()
}

fn value_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) | Value::Markdown(s) | Value::Slug(s) => Some(s.clone()),
        Value::AtomicUrl(subject) => Some(subject.to_string()),
        _ => None,
    }
}

fn sanitize_name(name: &str) -> String {
    if name.is_empty() {
        return "_".to_string();
    }
    if name == "." || name == ".." {
        return name.replace('.', "\u{2024}");
    }
    let sanitized: String = name
        .chars()
        .map(|character| match character {
            '/' | '\\' => '\u{ff0f}',
            '\0'..='\u{1f}' | '\u{7f}' => '\u{fffd}',
            '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}' => '\u{fffd}',
            other => other,
        })
        .collect();
    if sanitized.len() > 255 {
        sanitized.chars().take(80).collect()
    } else {
        sanitized
    }
}

/// File contents of an export tree, ignoring `.git` and `exportedAt`.
pub fn export_tree_snapshot(root: &Path) -> AtomicResult<BTreeMap<String, String>> {
    let mut out = BTreeMap::new();
    collect_tree(root, root, &mut out)?;
    Ok(out)
}

fn collect_tree(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) -> AtomicResult<()> {
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect();
    entries.sort_by_key(|e| e.as_ref().map(|e| e.file_name()).unwrap_or_default());
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if rel == ".git" || rel.starts_with(".git/") {
            continue;
        }
        if entry.file_type()?.is_dir() {
            collect_tree(root, &path, out)?;
            continue;
        }
        let mut text = match std::fs::read_to_string(&path) {
            Ok(s) => s,
            Err(_) => format!("<binary {} bytes>", std::fs::metadata(&path)?.len()),
        };
        if rel == ".atomic/index.json" {
            if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(obj) = value.as_object_mut() {
                    obj.remove("exportedAt");
                }
                text = serde_json::to_string_pretty(&value)? + "\n";
            }
        }
        out.insert(rel, text);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Storelike;

    fn temp_dir(prefix: &str) -> PathBuf {
        let dest = PathBuf::from(format!(".temp/{prefix}-{}", crate::utils::random_string(8)));
        let _ = std::fs::remove_dir_all(&dest);
        dest
    }

    async fn export_sample(store: &Db, dest: &Path, git: bool) -> ExportReport {
        let drive = write_sample_drive(store).await.unwrap();
        export_drive(
            store,
            &Subject::from(drive.as_str()),
            dest,
            &ExportOptions {
                init_git: git,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn exports_a_drive_as_a_git_repo() {
        let store = Db::init_temp("git_export_repo").await.unwrap();
        let dest = temp_dir("git-export");
        let report = export_sample(&store, &dest, true).await;

        assert!(
            report.resources >= 4,
            "drive + folder + doc + file + bookmark"
        );
        assert!(dest.join("README.md").exists());
        assert!(dest.join(".atomic/index.json").exists());
        assert!(dest.join(".atomic/drive.json").exists());
        assert!(dest.join("Notes/Hello.md").exists(), "document markdown");
        assert!(dest.join("hello.txt").exists(), "file blob");
        let markdown = std::fs::read_to_string(dest.join("Notes/Hello.md")).unwrap();
        assert!(
            markdown.contains("Hello from Atomic"),
            "prosemirror body, got: {markdown}"
        );
        assert!(
            markdown.contains("<a data-type=\"resource-block\" href=\"Atomic Data.json\">"),
            "embed rewritten to localId, got: {markdown}"
        );
        let blob = std::fs::read(dest.join("hello.txt")).unwrap();
        assert_eq!(blob, b"hello git export\n");

        let index: ExportIndex = serde_json::from_str(
            &std::fs::read_to_string(dest.join(".atomic/index.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(index.format, FORMAT_ID);
        assert_eq!(index.version, FORMAT_VERSION);
        assert_eq!(index.drive, "drive");
        assert!(index.entries.iter().any(|e| e.kind == EntryKind::Document));
        assert!(index.entries.iter().any(|e| e.kind == EntryKind::File));
        assert!(index.entries.iter().any(|e| e.local_id == "Notes/Hello.md"));

        let sidecar =
            std::fs::read_to_string(dest.join(".atomic/resources/Notes_Hello.md.json")).unwrap();
        assert!(!sidecar.contains("\"@id\""), "{sidecar}");
        assert!(sidecar.contains("Notes/Hello.md"), "{sidecar}");
        assert!(
            !sidecar.contains("did:ad:") || sidecar.contains("did:ad:blob:"),
            "sidecars should not keep resource DIDs: {sidecar}"
        );

        let sha = report.git_commit.expect("git commit");
        assert!(sha.len() >= 40, "{sha}");
        let log = run_git(&dest, &["log", "-1", "--pretty=%s"]).unwrap();
        assert!(log.contains("Git Export Demo"), "{log}");
    }

    #[tokio::test]
    async fn reimport_mints_a_new_drive_with_the_same_tree() {
        let store = Db::init_temp("git_export_import").await.unwrap();
        let dest = temp_dir("git-import-src");
        let original = write_sample_drive(&store).await.unwrap();
        export_drive(
            &store,
            &Subject::from(original.as_str()),
            &dest,
            &ExportOptions {
                init_git: false,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap();

        let imported = import_as_new_drive(&store, &dest).await.unwrap();
        assert_ne!(imported.drive, original, "new DIDs");
        assert!(imported.created >= 4);
        assert!(imported.subjects.contains_key("Notes/Hello.md"));
        assert!(imported.subjects.contains_key("hello.txt"));

        let q = Query {
            property: Some(urls::PARENT.into()),
            value: Some(Value::AtomicUrl(imported.drive.clone().into())),
            filters: Vec::new(),
            limit: None,
            start_val: None,
            end_val: None,
            offset: 0,
            sort_by: None,
            sort_desc: false,
            include_external: true,
            include_nested: false,
            for_agent: ForAgent::Sudo,
            aggregation: None,
            expression_filters: Vec::new(),
            drive: None,
        };
        let kids = store.query(&q).await.unwrap();
        let names: Vec<String> = {
            let mut names = Vec::new();
            for subject in kids.subjects {
                let resource = store.get_resource(&subject).await.unwrap();
                names.push(display_name(&resource));
            }
            names.sort();
            names
        };
        assert!(names.iter().any(|n| n == "Notes"), "{names:?}");
        assert!(
            names.iter().any(|n| n == "hello.txt" || n == "hello"),
            "{names:?}"
        );
        assert!(names.iter().any(|n| n.contains("Atomic")), "{names:?}");

        let doc_did = imported.subjects.get("Notes/Hello.md").unwrap();
        let mut doc = store
            .get_resource(&Subject::from(doc_did.as_str()))
            .await
            .unwrap();
        let json = doc.document_json().expect("imported document body");
        let embed = json["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["type"] == "atomic-data-resource")
            .expect("resource-block");
        let href = embed["attrs"]["subject"].as_str().unwrap();
        assert!(
            href.starts_with("did:ad:"),
            "embed rewritten to DID, got {href}"
        );
        assert_eq!(
            href,
            imported.subjects.get("Atomic Data.json").unwrap(),
            "embed points at imported bookmark"
        );
    }

    #[tokio::test]
    async fn export_import_export_is_stable() {
        let store = Db::init_temp("git_export_stable").await.unwrap();
        let first = temp_dir("git-stable-a");
        let second = temp_dir("git-stable-b");
        let original = write_sample_drive(&store).await.unwrap();
        export_drive(
            &store,
            &Subject::from(original.as_str()),
            &first,
            &ExportOptions {
                init_git: false,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap();

        let imported = import_as_new_drive(&store, &first).await.unwrap();
        export_drive(
            &store,
            &Subject::from(imported.drive.as_str()),
            &second,
            &ExportOptions {
                init_git: false,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap();

        let a = export_tree_snapshot(&first).unwrap();
        let b = export_tree_snapshot(&second).unwrap();
        let keys_a: Vec<_> = a.keys().collect();
        let keys_b: Vec<_> = b.keys().collect();
        assert_eq!(keys_a, keys_b, "same files");
        for key in a.keys() {
            assert_eq!(
                a.get(key),
                b.get(key),
                "mismatch at {key}\n--- a ---\n{}\n--- b ---\n{}",
                a.get(key).unwrap(),
                b.get(key).unwrap()
            );
        }
    }

    #[tokio::test]
    async fn reimport_into_same_drive_keeps_dids() {
        let store = Db::init_temp("git_export_idempotent").await.unwrap();
        let dest = temp_dir("git-idempotent");
        let original = write_sample_drive(&store).await.unwrap();
        export_drive(
            &store,
            &Subject::from(original.as_str()),
            &dest,
            &ExportOptions {
                init_git: false,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap();

        let first = import_as_new_drive(&store, &dest).await.unwrap();
        let second = import_into_drive(&store, &dest, &Subject::from(first.drive.as_str()))
            .await
            .unwrap();
        assert_eq!(first.drive, second.drive);
        assert_eq!(first.subjects, second.subjects);
    }

    #[test]
    fn sanitizes_path_segments() {
        assert_eq!(sanitize_name("a/b"), "a\u{ff0f}b");
        assert_eq!(sanitize_name(".."), "\u{2024}\u{2024}");
        assert_eq!(sanitize_name(""), "_");
    }

    #[test]
    fn collision_suffix_keeps_extension() {
        let mut used = HashSet::new();
        assert_eq!(unique_name("cat.jpg", &mut used), "cat.jpg");
        assert_eq!(unique_name("cat.jpg", &mut used), "cat (2).jpg");
    }
}
