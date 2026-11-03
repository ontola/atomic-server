//! Files as the web app stores them: the bytes are a content-addressed blob
//! (`atomic:blob:<blake3-hex>`) in the store, described by a `File` resource
//! (filename, filesize, mimetype, `internalId` = the hash, `blob`, and a
//! `downloadURL` at `<server>/download/files/<hash>` when the server is
//! known). The File is an ordinary child of its parent, so the data browser
//! shows and opens it; the server asks for the blob on the next sync.

use super::{own_commit_opts, LocalWritePusher};
use crate::{
    commit::CommitBuilder, errors::AtomicResult, runtime::AtomicNode, urls, Commit, Db, Storelike,
    Value,
};

/// The largest file [`upload_file`] takes and [`file_blob`] hands out.
pub const MAX_UPLOAD_BYTES: usize = 64 * 1024 * 1024;

/// Keep `bytes` as a blob and create a `File` for them under `parent`, as a
/// commit by this device's agent, queued in the outbox and handed to
/// `pusher`. `origin` is the server the File will be downloadable from, when
/// known. Returns the File's subject.
pub async fn upload_file(
    node: &AtomicNode,
    pusher: &dyn LocalWritePusher,
    parent: &str,
    origin: Option<&str>,
    filename: &str,
    mimetype: &str,
    bytes: &[u8],
) -> AtomicResult<String> {
    if parent.trim().is_empty() {
        return Err("No parent to keep the file under".into());
    }
    if bytes.is_empty() {
        return Err("The file is empty".into());
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(format!(
            "The file is larger than {} MB",
            MAX_UPLOAD_BYTES / 1024 / 1024
        )
        .into());
    }
    let mimetype = match mimetype.trim().to_ascii_lowercase() {
        m if m.is_empty() => "application/octet-stream".to_string(),
        m => m,
    };
    let filename = match filename.trim() {
        "" => "file",
        f => f,
    };
    let store = node.db();
    let agent = store.get_default_agent()?;
    let hash = blake3::hash(bytes);
    let hex = hash.to_hex().to_string();
    store.put_blob(hash.as_bytes(), bytes).await?;

    let mut builder = CommitBuilder::new("placeholder".into());
    builder.set(
        urls::IS_A.into(),
        Value::ResourceArray(vec![urls::FILE.into()]),
    );
    builder.set(urls::PARENT.into(), Value::AtomicUrl(parent.into()));
    builder.set(urls::FILENAME.into(), Value::String(filename.into()));
    builder.set(urls::FILESIZE.into(), Value::Integer(bytes.len() as i64));
    builder.set(urls::MIMETYPE.into(), Value::String(mimetype));
    builder.set(urls::INTERNAL_ID.into(), Value::String(hex.clone()));
    builder.set(
        urls::BLOB.into(),
        Value::AtomicUrl(crate::identifiers::blob_subject(&hex).into()),
    );
    if let Some(origin) = origin.filter(|o| o.starts_with("http")) {
        builder.set(
            urls::DOWNLOAD_URL.into(),
            Value::String(format!(
                "{}/download/files/{hex}",
                origin.trim_end_matches('/')
            )),
        );
    }
    let commit = Commit::create_did(builder, &agent, store).await?;
    let subject = commit.subject.to_string();
    let response = node.apply_local_commit(commit, &own_commit_opts()).await?;
    pusher.push(&response).await;
    Ok(subject)
}

/// The bytes of a File resource's blob when this store holds both the File
/// and its bytes, checked against the blob's hash. `None` when either is not
/// here (yet) or the file is larger than [`MAX_UPLOAD_BYTES`].
pub async fn file_blob(store: &Db, file: &str) -> AtomicResult<Option<Vec<u8>>> {
    let Ok(resource) = store.get_resource_shallow(&file.into()) else {
        return Ok(None);
    };
    let Some(hash) = resource.blob_hash() else {
        return Ok(None);
    };
    let bytes = store.get_blob(&hash).await?;
    Ok(bytes.filter(|b| {
        !b.is_empty() && b.len() <= MAX_UPLOAD_BYTES && blake3::hash(b).as_bytes() == &hash
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::{test_support::Device, NoPush};

    #[tokio::test]
    async fn an_uploaded_file_is_a_child_with_its_blob() {
        let d = Device::new().await;
        let bytes = b"%PDF-1.4 raadsvoorstel".to_vec();
        let file = upload_file(
            &d.node,
            &NoPush,
            &d.drive,
            Some("https://example.org/"),
            "voorstel.pdf",
            "application/pdf",
            &bytes,
        )
        .await
        .unwrap();
        let r = d.store.get_resource(&file.as_str().into()).await.unwrap();
        let hex = blake3::hash(&bytes).to_hex().to_string();
        assert_eq!(r.get(urls::PARENT).unwrap().to_string(), d.drive);
        assert_eq!(r.get(urls::FILENAME).unwrap().to_string(), "voorstel.pdf");
        assert_eq!(
            r.get(urls::MIMETYPE).unwrap().to_string(),
            "application/pdf"
        );
        assert_eq!(r.get(urls::INTERNAL_ID).unwrap().to_string(), hex);
        assert_eq!(
            r.get(urls::DOWNLOAD_URL).unwrap().to_string(),
            format!("https://example.org/download/files/{hex}")
        );
        assert_eq!(file_blob(&d.store, &file).await.unwrap(), Some(bytes));
        assert!(upload_file(&d.node, &NoPush, &d.drive, None, "x", "", b"")
            .await
            .is_err());
    }
}
