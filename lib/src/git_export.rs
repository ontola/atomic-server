//! Snapshot a drive as a git working tree (and optionally a git repo).
//!
//! This is a *projection* of current state — markdown, files, JSON-AD — not a
//! replica of Loro history or signed commits. See `planning/drive-as-git.md`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::agents::ForAgent;
use crate::db::trees::Tree;
use crate::errors::AtomicResult;
use crate::storelike::Query;
use crate::values::SubResource;
use crate::{urls, Db, Resource, Storelike, Subject, Value};

/// On-disk format identifier written to `index.json`.
pub const FORMAT_ID: &str = "atomic-git-export";
/// Layout version. Bump when `index.json` or the path mapping changes.
pub const FORMAT_VERSION: u32 = 1;

const FORMAT_DOC: &str = r#"# atomic-git-export v1

This directory is an Atomic Data drive exported as a git working tree.
See planning/drive-as-git.md in the Atomic repo for the design.

## Layout

- Human-readable files follow the drive's folder tree (markdown, binaries, JSON).
- `.atomic/index.json` maps each resource DID to its path and kind.
- `.atomic/resources/` holds pretty JSON-AD for every resource (no Loro binary).
- `.atomic/drive.json` is the drive resource.
- `.atomic/loro/` (optional) holds raw Loro snapshots.

Identity lives in DIDs, not paths. Re-import without genesis certificates
mints new DIDs — this is an interchange format, not a vault restore.
"#;

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
pub struct IndexEntry {
    pub id: String,
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

/// Result of [`import_as_new_drive`].
#[derive(Debug, Clone)]
pub struct ImportReport {
    pub drive: String,
    pub created: usize,
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

    let mut files_written = 0usize;
    let exported_at = crate::utils::now();

    let mut index_entries = Vec::new();
    let mut id_order: Vec<String> = by_id.keys().cloned().collect();
    id_order.sort();

    for id in &id_order {
        let resource = by_id.get_mut(id).expect("id from by_id");
        let kind = *kinds.get(id).unwrap_or(&EntryKind::Resource);
        let rel = paths.get(id).cloned().unwrap_or_else(|| String::new());
        let class = classes(resource).into_iter().next();
        let parent = resource.get(urls::PARENT).ok().map(|v| v.to_string());

        index_entries.push(IndexEntry {
            id: id.clone(),
            path: rel.clone(),
            kind,
            class,
            parent,
        });

        write_sidecar(dest, resource)?;
        files_written += 1;

        if opts.include_loro_snapshots {
            if let Some(snapshot) = resource.materialized_state() {
                if !snapshot.is_empty() {
                    std::fs::write(
                        dest.join(".atomic/loro")
                            .join(format!("{}.bin", did_stem(id))),
                        snapshot,
                    )?;
                    files_written += 1;
                }
            }
        }

        if id == &drive.pure_id() {
            continue;
        }

        files_written += write_projection(store, dest, resource, &rel, kind, opts)?;
    }

    index_entries.sort_by(|a, b| a.path.cmp(&b.path).then(a.id.cmp(&b.id)));
    let index = ExportIndex {
        format: FORMAT_ID.into(),
        version: FORMAT_VERSION,
        drive: drive.pure_id(),
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
        resource_to_pretty_json_ad(&drive_resource)?,
    )?;
    files_written += 1;

    std::fs::write(dest.join(".atomic/FORMAT.md"), FORMAT_DOC)?;
    files_written += 1;

    let readme = format!(
        "# {}\n\nThis directory is an [Atomic Data](https://atomicdata.dev) drive exported as a git repository.\n\nHuman-readable files follow the drive hierarchy. Machine identity (DIDs, classes, ACLs) lives under `.atomic/`.\n\nSee `.atomic/FORMAT.md` for the layout.\n",
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

/// Create a new drive from an `atomic-git-export` directory. Mints new DIDs.
pub async fn import_as_new_drive(store: &Db, src: &Path) -> AtomicResult<ImportReport> {
    let index = read_index(src)?;
    let drive_name = std::fs::read_to_string(src.join("README.md"))
        .ok()
        .and_then(|text| {
            text.lines()
                .next()
                .map(|line| line.trim_start_matches('#').trim().to_string())
        })
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "Imported drive".into());

    let drive = store.create_drive(&drive_name).await?;
    let mut old_to_new: HashMap<String, String> = HashMap::new();
    old_to_new.insert(index.drive.clone(), drive.clone());

    let mut entries = index.entries;
    entries.sort_by_key(|entry| {
        entry
            .path
            .chars()
            .filter(|c| *c == '/' || *c == std::path::MAIN_SEPARATOR)
            .count()
    });

    let mut created = 0usize;
    for entry in entries {
        if entry.id == index.drive {
            continue;
        }
        let parent_old = entry.parent.as_deref().unwrap_or(&index.drive);
        let parent_new = old_to_new
            .get(parent_old)
            .cloned()
            .unwrap_or_else(|| drive.clone());
        let name = basename_for_import(&entry);
        let new_id = match entry.kind {
            EntryKind::Folder | EntryKind::Drive => {
                store
                    .create_resource(urls::FOLDER, &parent_new, &name, None)
                    .await?
            }
            EntryKind::File => import_file(store, src, &entry, &parent_new, &name).await?,
            EntryKind::Document => import_document(store, src, &entry, &parent_new, &name).await?,
            EntryKind::Resource => {
                let class = entry.class.as_deref().unwrap_or(urls::CLASS);
                // CLASS is wrong as a fallback; use a generic bookmark-like
                // resource only when the sidecar didn't record isA. Prefer
                // creating with the recorded class, else a Folder-less JSON
                // document via description.
                let class = if class == urls::CLASS {
                    urls::BOOKMARK
                } else {
                    class
                };
                store
                    .create_resource(class, &parent_new, &name, None)
                    .await?
            }
        };
        old_to_new.insert(entry.id, new_id);
        created += 1;
    }

    Ok(ImportReport { drive, created })
}

/// Build a small drive used by the example and tests: folder, document, file, bookmark.
pub async fn write_sample_drive(store: &Db) -> AtomicResult<String> {
    let drive = store.create_drive("Git Export Demo").await?;

    let notes = store
        .create_resource(urls::FOLDER, &drive, "Notes", None)
        .await?;

    let doc_id = store
        .create_resource(
            urls::DOCUMENT_V2,
            &notes,
            "Hello",
            Some(vec![(
                urls::DESCRIPTION,
                Value::Markdown("A fallback body if the Loro document is empty.".into()),
            )]),
        )
        .await?;

    let mut doc_resource = store.get_resource(&Subject::from(doc_id.as_str())).await?;
    let loro = crate::loro::AtomicLoroDoc::new();
    for (prop, value) in doc_resource.get_propvals().clone() {
        if prop == urls::LORO_UPDATE {
            continue;
        }
        loro.set_property(&prop, &value)?;
    }
    loro.doc()
        .get_text("documentContent")
        .insert(
            0,
            "# Hello from Atomic\n\nThis document was exported as markdown.",
        )
        .map_err(|e| format!("loro text insert: {e}"))?;
    loro.commit();
    doc_resource.apply_state_doc(loro)?;
    // `apply_state_doc` does not dirty the commit builder; touch a property so
    // `save_locally` actually signs and persists the Loro snapshot.
    doc_resource
        .set(
            urls::DESCRIPTION.into(),
            Value::Markdown(
                "# Hello from Atomic\n\nThis document was exported as markdown.".into(),
            ),
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
                (urls::FILENAME, Value::String("hello.txt".into())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
                ),
                (urls::INTERNAL_ID, Value::String(hash_hex)),
                (urls::FILESIZE, Value::Integer(bytes.len() as i64)),
                (urls::MIMETYPE, Value::String("text/plain".into())),
            ]),
        )
        .await?;

    store
        .create_resource(
            urls::BOOKMARK,
            &drive,
            "Atomic Data",
            Some(vec![(
                urls::URL,
                Value::String("https://atomicdata.dev".into()),
            )]),
        )
        .await?;

    Ok(drive)
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

fn write_sidecar(dest: &Path, resource: &Resource) -> AtomicResult<()> {
    let path = dest.join(".atomic/resources").join(format!(
        "{}.json",
        did_stem(&resource.get_subject().pure_id())
    ));
    std::fs::write(path, resource_to_pretty_json_ad(resource)?)?;
    Ok(())
}

fn write_projection(
    store: &Db,
    dest: &Path,
    resource: &mut Resource,
    rel: &str,
    kind: EntryKind,
    opts: &ExportOptions,
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
            std::fs::write(path, resource_to_pretty_json_ad(resource)?)?;
            Ok(1)
        }
    }
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

fn resource_to_pretty_json_ad(resource: &Resource) -> AtomicResult<String> {
    let mut propvals = resource.get_propvals().clone();
    propvals.remove(urls::LORO_UPDATE);
    let json = crate::serialize::propvals_to_json_ad_map(
        &propvals,
        Some(resource.get_subject().to_string()),
        "http://localhost",
        false,
    )?;
    Ok(serde_json::to_string_pretty(&sort_json(json))? + "\n")
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

fn basename_for_import(entry: &IndexEntry) -> String {
    let path = entry.path.trim_end_matches('/');
    let name = path.rsplit('/').next().unwrap_or(path);
    let name = name.strip_suffix("/index.md").unwrap_or(name);
    let name = match entry.kind {
        EntryKind::Document => name.strip_suffix(".md").unwrap_or(name),
        EntryKind::Resource => name.strip_suffix(".json").unwrap_or(name),
        _ => name,
    };
    if name.is_empty() {
        "untitled".into()
    } else {
        name.to_string()
    }
}

async fn import_file(
    store: &Db,
    src: &Path,
    entry: &IndexEntry,
    parent: &str,
    name: &str,
) -> AtomicResult<String> {
    let bytes = std::fs::read(src.join(&entry.path)).unwrap_or_default();
    let hash = blake3::hash(&bytes);
    let hash_hex = hash.to_hex().to_string();
    store.kv.insert(Tree::Blobs, hash.as_bytes(), &bytes)?;
    store
        .create_resource(
            urls::FILE,
            parent,
            name,
            Some(vec![
                (urls::FILENAME, Value::String(name.into())),
                (
                    urls::BLOB,
                    Value::AtomicUrl(format!("did:ad:blob:{hash_hex}").into()),
                ),
                (urls::INTERNAL_ID, Value::String(hash_hex)),
                (urls::FILESIZE, Value::Integer(bytes.len() as i64)),
            ]),
        )
        .await
}

async fn import_document(
    store: &Db,
    src: &Path,
    entry: &IndexEntry,
    parent: &str,
    name: &str,
) -> AtomicResult<String> {
    let markdown = std::fs::read_to_string(src.join(&entry.path)).unwrap_or_default();
    let id = store
        .create_resource(
            urls::DOCUMENT_V2,
            parent,
            name,
            Some(vec![(
                urls::DESCRIPTION,
                Value::Markdown(markdown.trim().to_string()),
            )]),
        )
        .await?;
    let mut resource = store.get_resource(&Subject::from(id.as_str())).await?;
    let loro = crate::loro::AtomicLoroDoc::new();
    for (prop, value) in resource.get_propvals().clone() {
        if prop == urls::LORO_UPDATE {
            continue;
        }
        loro.set_property(&prop, &value)?;
    }
    loro.doc()
        .get_text("documentContent")
        .insert(0, markdown.trim())
        .map_err(|e| format!("loro text insert: {e}"))?;
    loro.commit();
    resource.apply_state_doc(loro)?;
    resource.save_locally(store).await?;
    Ok(id)
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

fn did_stem(id: &str) -> String {
    id.replace([':', '/', '\\'], "_")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Storelike;

    #[tokio::test]
    async fn exports_a_drive_as_a_git_repo() {
        let store = Db::init_temp("git_export_repo").await.unwrap();
        let drive = write_sample_drive(&store).await.unwrap();
        let dest = PathBuf::from(format!(
            ".temp/git-export-{}",
            crate::utils::random_string(8)
        ));
        let _ = std::fs::remove_dir_all(&dest);

        let report = export_drive(
            &store,
            &Subject::from(drive.as_str()),
            &dest,
            &ExportOptions::default(),
        )
        .await
        .unwrap();

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
        let blob = std::fs::read(dest.join("hello.txt")).unwrap();
        assert_eq!(blob, b"hello git export\n");

        let index: ExportIndex = serde_json::from_str(
            &std::fs::read_to_string(dest.join(".atomic/index.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(index.format, FORMAT_ID);
        assert!(index.entries.iter().any(|e| e.kind == EntryKind::Document));
        assert!(index.entries.iter().any(|e| e.kind == EntryKind::File));

        let sha = report.git_commit.expect("git commit");
        assert!(sha.len() >= 40, "{sha}");
        let log = run_git(&dest, &["log", "-1", "--pretty=%s"]).unwrap();
        assert!(log.contains("Git Export Demo"), "{log}");

        // Keep the tree for inspection; tests share `.temp/`.
    }

    #[tokio::test]
    async fn reimport_mints_a_new_drive_with_the_same_tree() {
        let store = Db::init_temp("git_export_import").await.unwrap();
        let drive = write_sample_drive(&store).await.unwrap();
        let dest = PathBuf::from(format!(
            ".temp/git-import-src-{}",
            crate::utils::random_string(8)
        ));
        let _ = std::fs::remove_dir_all(&dest);
        export_drive(
            &store,
            &Subject::from(drive.as_str()),
            &dest,
            &ExportOptions {
                init_git: false,
                ..ExportOptions::default()
            },
        )
        .await
        .unwrap();

        let imported = import_as_new_drive(&store, &dest).await.unwrap();
        assert_ne!(imported.drive, drive, "new DIDs");
        assert!(imported.created >= 4);

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
