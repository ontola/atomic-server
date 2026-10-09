{{#title Uploading, downloading and describing files with Atomic Data}}
# Uploading, downloading and describing files with Atomic Data

The Atomic Data model (Atomic Schema) is great for describing structured data, but for many types of existing data, we already have a different way to represent them: files.
In Atomic Data, files have two URLs.
One _describes_ the file and its metadata, and the other is a URL that downloads the file.
This allows us to present a better view when a user wants to take a look at some file, and learn about its context before downloading it.

## The File class

_url: [https://atomicdata.dev/classes/File](https://atomicdata.dev/classes/File)_

Files always have a downloadURL.
They often also have a filename, a filesize, a checksum, a mimetype, and an internal ID (more on that later).
They also often have a [`parent`](https://atomicdata.dev/properties/parent), which can be used to set permissions / rights.
If the file is an image they will also get an `imageWidth` and `imageHeight` property.

## Uploading a file

In the web app, drop files onto a folder or drive page to upload them there.
You need write access to the destination.

In `atomic-server`, a `/upload` endpoint exists for uploading a file.

- Decide where you want to add the file in the [hierarchy](hierarchy.md) of your server. You can add a file to any resource - your file will refer to this resource as its [`parent`](https://atomicdata.dev/properties/parent). Make sure you have `write` rights on this parent.
- Use that parent to add a query parameter to the server's `/upload` endpoint, e.g. `/upload?parent=https%3A%2F%2Fatomicdata.dev%2Ffiles`.
- Send an HTTP `POST` request to the server's `/upload` endpoint containing [`multi-part-form-data`](https://developer.mozilla.org/en-US/docs/Web/API/FormData/Using_FormData_Objects). You can upload multiple files in one request. Add [authentication](authentication.md) headers, and sign the HTTP request with the
- The server will check your authentication headers, your permissions, and will persist your uploaded file(s). It will now create File resources.
- The server will reply with an array of created Atomic Data Files

## Editing an uploaded text file

Open an uploaded Markdown (`.md` or `.markdown`) or plain text (`.txt`) file and
select **Convert to document** to edit its contents in the document editor.
This action is available when you can edit the file. Markdown formatting becomes
editable document formatting; plain text keeps its literal characters and line
breaks.

Conversion keeps the resource's link, location, description, and permissions.
The original uploaded bytes remain stored, but editing the document does not
change those bytes. Other file formats continue to open as files.

## Downloading a file

Simply send an HTTP GET request to the File's [`download-url`](https://atomicdata.dev/properties/downloadURL) (make sure to authenticate this request).

### Image compression

AtomicServer can automatically generate compressed versions of images in modern image formats (WebP, AVIF).
To do this add one or more of the following query parameters to the download URL:

| Query parameter | Description |
| --- | --- |
| f | The format of the image. Can be `webp` or `avif`. |
| q | The quality used to encode the image. Can be a number between 0 and 100. (Only works when `f` is set to `webp` or `avif`). Default is 75|
| w | The width of the image. Height will be scaled based on the width to keep the right aspect-ratio |

Example: `https://atomicdata.dev/download/files/af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262?f=avif&q=60&w=500` (the path segment is the file's BLAKE3 hash).

## Storage model: content-addressed blobs

Files are stored using a [content-addressed](https://en.wikipedia.org/wiki/Content-addressable_storage) model. Every file's bytes are hashed with [BLAKE3](https://github.com/BLAKE3-team/BLAKE3), and the bytes are stored under that hash in a key-value blob store. The hash is the blob's identity — its canonical form is an [identifier](identifiers.md):

```text
atomic:blob:{blake3}
```

where `{blake3}` is the 32-byte BLAKE3 hash, hex-encoded. The legacy `did:ad:blob:` spelling is accepted forever. See [Blob identifiers](identifiers.md#blob-identifiers) for the full identifier definition.

This separates the file's *metadata* (the File resource — filename, mimetype, parent, ACL) from its *data* (the bytes), and lets the same blob be referenced by any number of File resources without duplication. The File resource points at its blob via a `blob` property whose value is a `atomic:blob:` reference. Bytes flow over the peer-to-peer sync protocol independently of the resource graph: a peer that receives a File resource looks up the blob locally, and if it doesn't have the bytes, asks any connected peer for them.

The HTTP form `<origin>/download/files/{blake3}` is a deployment-specific alias for the underlying identifier and remains the URL clients use over plain HTTP.

## Authorization model: the hash is not a capability

A blob hash is an *identity*, never a credential. A server only hands out the bytes behind a hash to a requester who passes both of these checks:

1. **Read access.** The requester can read at least one resource that references the blob: a File whose `internalId` or `blob` is the hash, or a chunked File listing it in `chunks`. Reading goes through the normal [hierarchy](hierarchy.md) authorization.
2. **Proof of possession.** That referencing resource's drive has *proven it holds the bytes*. A server records a claim `(hash, drive)` only when the bytes were handed to it on behalf of that drive: an authenticated upload into the drive, a `PUT /blob/{hash}` signed by an agent that may write the referencing File, or a sync pull of the bytes for that drive from an admitted peer. A claim is never part of a resource, cannot be written by a commit and is not visible over the API.

Without the second check the first would be worthless: `internalId`, `blob` and `chunks` are ordinary properties, so anyone who knows (or guesses) a hash could create a File of their own that names it and download somebody else's private bytes. Such a File exists, is readable by its creator, and still unlocks nothing, because its drive never supplied the bytes. A second user who uploads identical bytes supplies them for their own drive, gets their own claim, and reads their own File; nothing is shared with the first user.

Every refusal is the same "not found" as for a hash the server does not hold, so a hash cannot be used to probe for existence or to confirm that someone stores a particular file. The checks are the same for the HTTP routes (`/download/files/{blake3}`, `/download/atomic:blob:{blake3}`, `/download/{file}`) and for the `BLOB_REQUEST` frame of the sync protocols.

Consequences:

1. **Blobs are facts, not resources.** They have no subject metadata, no parent, no ACL, no class. They are addressed only by content hash.
2. **The File resource, together with the claim of its drive, is where read permission is enforced.**
3. **Knowing a blob identifier grants nothing**, in contrast to a presigned URL. People who can write in a drive can still reference any blob that drive holds, so write access to a drive is read access to the files stored for it.

Stores created before claims existed are migrated once on start: every File already in the store claims its blob for its drive, so no existing file becomes unreadable.

### A note on existence side-channels

Because a refusal looks like a missing blob and requires proof the requester cannot forge, an attacker who knows the hash of some byte-string cannot learn whether a server stores it, nor read it. Uploading the bytes yourself only ever claims them for your own drive.

## Discussion

- [Discussion on specification](https://github.com/ontola/atomic-data-docs/issues/57)
- [Discussion on Rust server implementation](https://github.com/ontola/atomic-server/issues/72)
- [Discussion on Typescript client implementation](https://github.com/atomicdata-dev/atomic-data-browser/issues/121)

## Server file storage

By default, file bytes are stored in the local database. Operators can select
S3-compatible storage with `ATOMIC_BLOB_BACKEND=s3`, `ATOMIC_S3_BUCKET`,
`ATOMIC_S3_REGION`, and optionally `ATOMIC_S3_ENDPOINT`. Set the paired
`ATOMIC_S3_ACCESS_KEY_ID` / `ATOMIC_S3_SECRET_ACCESS_KEY` credentials, or use
instance credentials. `ATOMIC_S3_PREFIX` defaults to `blobs`;
`ATOMIC_S3_PATH_STYLE=true` selects path-style addressing for services such as
MinIO. HTTPS is required unless `ATOMIC_S3_ALLOW_HTTP=true` is explicitly set
for local testing.

Uploads, downloads, peer sync and image renditions all use the selected
backend. In S3 mode there is no local file cache or fallback: an unavailable
object store causes an error. The server checks read/write access before
serving traffic, then migrates existing database blobs one at a time, verifying
each remote copy before removing its local row. Database pages become reusable
but the database file may not shrink. Keep the bucket and prefix stable across
node replacements, and use an S3-capable binary for rollback after migration.

This is primary storage for hosted files. It does not provide client-encrypted
Vault backups, and the server still buffers file contents in memory while
proxying requests.

Drive usage counts each referenced blob once within that drive. When two drives
reference identical content, each drive counts its full size toward its quota,
while the shared S3 namespace stores one object. Account/drive usage totals
therefore describe logical usage, not the physical size of the bucket.
