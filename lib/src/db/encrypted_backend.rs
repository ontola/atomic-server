//! At-rest encryption for the client-side redb store.
//!
//! `EncryptedBackend` wraps any `redb::StorageBackend` and encrypts data in
//! fixed-size logical blocks with XChaCha20-Poly1305. The browser uses it to
//! keep a signed-in agent's OPFS cache unreadable after sign-out or an agent
//! switch: drop the key and the file is ciphertext.
//!
//! On-disk layout:
//!
//! ```text
//! [ header: 64 bytes ][ block 0 ][ block 1 ] ...
//! block  = nonce (24) + ciphertext (4096) + tag (16)  = 4136 bytes
//! header = magic (8) + version (4) + block size (4)
//!        + logical length (8) + key check nonce+tag (40)
//! ```
//!
//! Every block is encrypted with a fresh random nonce on each write, with the
//! block index as associated data so blocks cannot be transplanted. A block
//! whose stored nonce is all zeroes has never been written (the inner backend
//! zero-fills on grow) and reads as plaintext zeroes — a random nonce is never
//! all-zero. The logical file length lives in the header because the physical
//! length is block-padded.
//!
//! Invariant: within the last partial block, bytes at logical offsets >= the
//! logical length are always zero. `set_len` re-encrypts the trailing block on
//! shrink to uphold this, so a later grow exposes zeroes, not stale plaintext.

use std::io;
use std::sync::atomic::{AtomicU64, Ordering};

use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    XChaCha20Poly1305, XNonce,
};
use redb::StorageBackend;

const MAGIC: &[u8; 8] = b"ATOMENC1";
const VERSION: u32 = 1;
const HEADER_LEN: u64 = 64;
const BLOCK: usize = 4096;
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const PHYS_BLOCK: usize = NONCE_LEN + BLOCK + TAG_LEN;
/// Offset of the logical-length field inside the header.
const LEN_FIELD_OFFSET: u64 = 16;
const KEY_CHECK_AAD: &[u8] = b"atomic-encdb-keycheck-v1";

pub struct EncryptedBackend<B: StorageBackend> {
    inner: B,
    cipher: XChaCha20Poly1305,
    logical_len: AtomicU64,
}

impl<B: StorageBackend> std::fmt::Debug for EncryptedBackend<B> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EncryptedBackend")
            .field("inner", &self.inner)
            .finish_non_exhaustive()
    }
}

fn err_data(msg: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, msg.into())
}

fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    // Loop guards the (2^-192) all-zero draw, which is the unwritten-block
    // sentinel and must never appear on a written block.
    while nonce.iter().all(|b| *b == 0) {
        fill_random(&mut nonce);
    }
    nonce
}

#[cfg(target_arch = "wasm32")]
fn fill_random(buf: &mut [u8]) {
    getrandom::fill(buf).expect("randomness unavailable");
}

#[cfg(not(target_arch = "wasm32"))]
fn fill_random(buf: &mut [u8]) {
    use rand::RngCore;
    rand::rngs::OsRng.fill_bytes(buf);
}

/// Associated data binding a ciphertext to its block position.
fn block_aad(block_index: u64) -> [u8; 16] {
    let mut aad = [0u8; 16];
    aad[..8].copy_from_slice(b"encblk-1");
    aad[8..].copy_from_slice(&block_index.to_le_bytes());
    aad
}

impl<B: StorageBackend> EncryptedBackend<B> {
    /// Wrap `inner` with encryption under `key`. An empty inner file is
    /// initialized with a fresh header; a non-empty one must carry a valid
    /// header and pass the key check, otherwise this fails — an existing
    /// plaintext redb file is rejected rather than silently corrupted.
    pub fn new(inner: B, key: &[u8; 32]) -> io::Result<Self> {
        let cipher = XChaCha20Poly1305::new(key.into());

        if inner.len()? == 0 {
            let backend = EncryptedBackend {
                inner,
                cipher,
                logical_len: AtomicU64::new(0),
            };
            backend.write_fresh_header()?;
            return Ok(backend);
        }

        let mut header = [0u8; HEADER_LEN as usize];
        inner.read(0, &mut header)?;

        if &header[0..8] != MAGIC {
            return Err(err_data(
                "not an encrypted atomic database (bad magic bytes)",
            ));
        }
        let version = u32::from_le_bytes(header[8..12].try_into().unwrap());
        if version != VERSION {
            return Err(err_data(format!(
                "unsupported encrypted database version {version}"
            )));
        }
        let block_size = u32::from_le_bytes(header[12..16].try_into().unwrap());
        if block_size as usize != BLOCK {
            return Err(err_data(format!(
                "unsupported encrypted database block size {block_size}"
            )));
        }
        let logical_len = u64::from_le_bytes(header[16..24].try_into().unwrap());

        let key_check_nonce = XNonce::from_slice(&header[24..24 + NONCE_LEN]);
        let key_check_ct = &header[24 + NONCE_LEN..24 + NONCE_LEN + TAG_LEN];
        cipher
            .decrypt(
                key_check_nonce,
                Payload {
                    msg: key_check_ct,
                    aad: KEY_CHECK_AAD,
                },
            )
            .map_err(|_| err_data("wrong encryption key for local database"))?;

        Ok(EncryptedBackend {
            inner,
            cipher,
            logical_len: AtomicU64::new(logical_len),
        })
    }

    fn write_fresh_header(&self) -> io::Result<()> {
        let mut header = [0u8; HEADER_LEN as usize];
        header[0..8].copy_from_slice(MAGIC);
        header[8..12].copy_from_slice(&VERSION.to_le_bytes());
        header[12..16].copy_from_slice(&(BLOCK as u32).to_le_bytes());
        header[16..24].copy_from_slice(&0u64.to_le_bytes());

        // Encrypting an empty message yields just the 16-byte tag; storing it
        // lets a later open distinguish "wrong key" from corruption.
        let nonce_bytes = random_nonce();
        let tag = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &[],
                    aad: KEY_CHECK_AAD,
                },
            )
            .map_err(|_| err_data("key check encryption failed"))?;
        header[24..24 + NONCE_LEN].copy_from_slice(&nonce_bytes);
        header[24 + NONCE_LEN..24 + NONCE_LEN + TAG_LEN].copy_from_slice(&tag);

        self.inner.set_len(HEADER_LEN)?;
        self.inner.write(0, &header)
    }

    fn persist_logical_len(&self, len: u64) -> io::Result<()> {
        self.logical_len.store(len, Ordering::SeqCst);
        self.inner.write(LEN_FIELD_OFFSET, &len.to_le_bytes())
    }

    fn phys_offset(block_index: u64) -> u64 {
        HEADER_LEN + block_index * PHYS_BLOCK as u64
    }

    /// Physical length required to hold `logical_len` bytes.
    fn phys_len_for(logical_len: u64) -> u64 {
        HEADER_LEN + logical_len.div_ceil(BLOCK as u64) * PHYS_BLOCK as u64
    }

    /// Decrypt one block into a plaintext buffer. Blocks the inner backend has
    /// only zero-filled (never written) read as all zeroes.
    fn read_block(&self, block_index: u64, out: &mut [u8; BLOCK]) -> io::Result<()> {
        let mut phys = [0u8; PHYS_BLOCK];
        self.inner.read(Self::phys_offset(block_index), &mut phys)?;

        let (nonce, ct) = phys.split_at(NONCE_LEN);
        if nonce.iter().all(|b| *b == 0) {
            out.fill(0);
            return Ok(());
        }

        let plain = self
            .cipher
            .decrypt(
                XNonce::from_slice(nonce),
                Payload {
                    msg: ct,
                    aad: &block_aad(block_index),
                },
            )
            .map_err(|_| {
                err_data(format!(
                    "block {block_index} failed authentication (wrong key or corrupted data)"
                ))
            })?;
        out.copy_from_slice(&plain);
        Ok(())
    }

    fn write_block(&self, block_index: u64, plain: &[u8; BLOCK]) -> io::Result<()> {
        let nonce_bytes = random_nonce();
        let ct = self
            .cipher
            .encrypt(
                XNonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plain.as_slice(),
                    aad: &block_aad(block_index),
                },
            )
            .map_err(|_| err_data("block encryption failed"))?;

        let mut phys = [0u8; PHYS_BLOCK];
        phys[..NONCE_LEN].copy_from_slice(&nonce_bytes);
        phys[NONCE_LEN..].copy_from_slice(&ct);
        self.inner.write(Self::phys_offset(block_index), &phys)
    }

    /// Grow the inner file so all blocks covering `logical_len` exist
    /// (zero-filled where new, which reads back as the unwritten sentinel).
    fn ensure_phys_capacity(&self, logical_len: u64) -> io::Result<()> {
        let needed = Self::phys_len_for(logical_len);
        if self.inner.len()? < needed {
            self.inner.set_len(needed)?;
        }
        Ok(())
    }
}

impl<B: StorageBackend> StorageBackend for EncryptedBackend<B> {
    fn len(&self) -> io::Result<u64> {
        Ok(self.logical_len.load(Ordering::SeqCst))
    }

    fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
        if out.is_empty() {
            return Ok(());
        }
        let end = offset + out.len() as u64;
        if end > self.logical_len.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                format!("read of {} bytes at {offset} beyond logical end", out.len()),
            ));
        }

        let mut block = [0u8; BLOCK];
        let first = offset / BLOCK as u64;
        let last = (end - 1) / BLOCK as u64;
        for index in first..=last {
            self.read_block(index, &mut block)?;

            let block_start = index * BLOCK as u64;
            let copy_from = offset.max(block_start);
            let copy_to = end.min(block_start + BLOCK as u64);
            let src = (copy_from - block_start) as usize..(copy_to - block_start) as usize;
            let dst = (copy_from - offset) as usize..(copy_to - offset) as usize;
            out[dst].copy_from_slice(&block[src]);
        }
        Ok(())
    }

    fn write(&self, offset: u64, data: &[u8]) -> io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let end = offset + data.len() as u64;
        self.ensure_phys_capacity(end)?;
        // Persist the extended length before the data lands: a crash in
        // between leaves unwritten (zero-reading) tail blocks, which redb
        // recovers from, whereas a too-short length would truncate a commit.
        if end > self.logical_len.load(Ordering::SeqCst) {
            self.persist_logical_len(end)?;
        }

        let mut block = [0u8; BLOCK];
        let first = offset / BLOCK as u64;
        let last = (end - 1) / BLOCK as u64;
        for index in first..=last {
            let block_start = index * BLOCK as u64;
            let copy_from = offset.max(block_start);
            let copy_to = end.min(block_start + BLOCK as u64);

            let full_cover = copy_from == block_start && copy_to == block_start + BLOCK as u64;
            if full_cover {
                let src = (copy_from - offset) as usize..(copy_to - offset) as usize;
                block.copy_from_slice(&data[src]);
            } else {
                self.read_block(index, &mut block)?;
                let src = (copy_from - offset) as usize..(copy_to - offset) as usize;
                let dst = (copy_from - block_start) as usize..(copy_to - block_start) as usize;
                block[dst].copy_from_slice(&data[src]);
            }
            self.write_block(index, &block)?;
        }
        Ok(())
    }

    fn set_len(&self, len: u64) -> io::Result<()> {
        let old = self.logical_len.load(Ordering::SeqCst);

        if len < old && !len.is_multiple_of(BLOCK as u64) {
            // Zero the truncated tail inside the now-last block so a future
            // grow reads zeroes instead of stale plaintext.
            let index = len / BLOCK as u64;
            let mut block = [0u8; BLOCK];
            self.read_block(index, &mut block)?;
            block[(len % BLOCK as u64) as usize..].fill(0);
            self.write_block(index, &block)?;
        }

        let needed = Self::phys_len_for(len);
        if len < old {
            self.inner.set_len(needed)?;
        } else {
            self.ensure_phys_capacity(len)?;
        }
        self.persist_logical_len(len)
    }

    fn sync_data(&self) -> io::Result<()> {
        self.inner.sync_data()
    }

    fn close(&self) -> io::Result<()> {
        self.inner.close()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Minimal shared in-memory backend so a "file" can be reopened by a
    /// second EncryptedBackend, which redb's own InMemoryBackend (owned,
    /// non-cloneable) doesn't allow.
    #[derive(Debug, Clone, Default)]
    struct SharedMem(Arc<Mutex<Vec<u8>>>);

    impl StorageBackend for SharedMem {
        fn len(&self) -> io::Result<u64> {
            Ok(self.0.lock().unwrap().len() as u64)
        }

        fn read(&self, offset: u64, out: &mut [u8]) -> io::Result<()> {
            let data = self.0.lock().unwrap();
            let start = offset as usize;
            let end = start + out.len();
            if end > data.len() {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "short read"));
            }
            out.copy_from_slice(&data[start..end]);
            Ok(())
        }

        fn write(&self, offset: u64, buf: &[u8]) -> io::Result<()> {
            let mut data = self.0.lock().unwrap();
            let end = offset as usize + buf.len();
            if end > data.len() {
                data.resize(end, 0);
            }
            data[offset as usize..end].copy_from_slice(buf);
            Ok(())
        }

        fn set_len(&self, len: u64) -> io::Result<()> {
            self.0.lock().unwrap().resize(len as usize, 0);
            Ok(())
        }

        fn sync_data(&self) -> io::Result<()> {
            Ok(())
        }

        fn close(&self) -> io::Result<()> {
            Ok(())
        }
    }

    const KEY: [u8; 32] = [7u8; 32];

    #[test]
    fn roundtrip_within_one_block() {
        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        backend.write(0, b"hello world").unwrap();
        assert_eq!(backend.len().unwrap(), 11);

        let mut out = [0u8; 11];
        backend.read(0, &mut out).unwrap();
        assert_eq!(&out, b"hello world");
    }

    #[test]
    fn roundtrip_across_block_boundaries() {
        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        let data: Vec<u8> = (0..BLOCK * 3 + 500).map(|i| (i % 251) as u8).collect();
        backend.write(100, &data).unwrap();

        let mut out = vec![0u8; data.len()];
        backend.read(100, &mut out).unwrap();
        assert_eq!(out, data);

        // Unaligned read spanning a boundary.
        let mut out = vec![0u8; 1000];
        backend.read(BLOCK as u64 - 500 + 100, &mut out).unwrap();
        assert_eq!(out, data[BLOCK - 500..BLOCK + 500]);
    }

    #[test]
    fn partial_overwrite_preserves_surroundings() {
        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        backend.write(0, &[1u8; BLOCK * 2]).unwrap();
        backend.write(BLOCK as u64 - 10, &[2u8; 20]).unwrap();

        let mut out = vec![0u8; BLOCK * 2];
        backend.read(0, &mut out).unwrap();
        assert!(out[..BLOCK - 10].iter().all(|b| *b == 1));
        assert!(out[BLOCK - 10..BLOCK + 10].iter().all(|b| *b == 2));
        assert!(out[BLOCK + 10..].iter().all(|b| *b == 1));
    }

    #[test]
    fn grown_regions_read_as_zeroes() {
        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        backend.write(0, &[9u8; 100]).unwrap();
        backend.set_len(BLOCK as u64 * 2).unwrap();

        let mut out = vec![0u8; BLOCK * 2 - 100];
        backend.read(100, &mut out).unwrap();
        assert!(out.iter().all(|b| *b == 0));
    }

    #[test]
    fn shrink_then_grow_zeroes_stale_tail() {
        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        backend.write(0, &[9u8; 2000]).unwrap();
        backend.set_len(1000).unwrap();
        backend.set_len(2000).unwrap();

        let mut out = [0u8; 1000];
        backend.read(1000, &mut out).unwrap();
        assert!(out.iter().all(|b| *b == 0), "stale plaintext leaked back");

        let mut out = [0u8; 1000];
        backend.read(0, &mut out).unwrap();
        assert!(out.iter().all(|b| *b == 9), "kept prefix must survive");
    }

    #[test]
    fn reopen_with_same_key_sees_data() {
        let mem = SharedMem::default();
        {
            let backend = EncryptedBackend::new(mem.clone(), &KEY).unwrap();
            backend.write(0, b"persisted").unwrap();
        }
        let backend = EncryptedBackend::new(mem, &KEY).unwrap();
        assert_eq!(backend.len().unwrap(), 9);
        let mut out = [0u8; 9];
        backend.read(0, &mut out).unwrap();
        assert_eq!(&out, b"persisted");
    }

    #[test]
    fn reopen_with_wrong_key_fails_fast() {
        let mem = SharedMem::default();
        EncryptedBackend::new(mem.clone(), &KEY)
            .unwrap()
            .write(0, b"secret")
            .unwrap();

        let err = EncryptedBackend::new(mem, &[8u8; 32]).unwrap_err();
        assert!(err.to_string().contains("wrong encryption key"));
    }

    #[test]
    fn plaintext_file_is_rejected() {
        let mem = SharedMem::default();
        mem.set_len(1024).unwrap();
        mem.write(0, b"just some plaintext redb bytes").unwrap();

        let err = EncryptedBackend::new(mem, &KEY).unwrap_err();
        assert!(err.to_string().contains("bad magic"));
    }

    #[test]
    fn transplanted_block_fails_authentication() {
        let mem = SharedMem::default();
        let backend = EncryptedBackend::new(mem.clone(), &KEY).unwrap();
        backend.write(0, &[1u8; BLOCK * 2]).unwrap();

        // Copy block 0's physical bytes over block 1.
        let mut phys = vec![0u8; PHYS_BLOCK];
        mem.read(HEADER_LEN, &mut phys).unwrap();
        mem.write(HEADER_LEN + PHYS_BLOCK as u64, &phys).unwrap();

        let mut out = [0u8; BLOCK];
        let err = backend.read(BLOCK as u64, &mut out).unwrap_err();
        assert!(err.to_string().contains("failed authentication"));
    }

    #[test]
    fn ciphertext_never_contains_plaintext() {
        let mem = SharedMem::default();
        let backend = EncryptedBackend::new(mem.clone(), &KEY).unwrap();
        let needle = b"very-recognizable-plaintext-marker";
        backend.write(0, needle).unwrap();

        let raw = mem.0.lock().unwrap();
        assert!(
            !raw.windows(needle.len()).any(|w| w == needle),
            "plaintext leaked into the physical file"
        );
    }

    /// Randomized model check: EncryptedBackend must behave exactly like a
    /// plain byte vector under an arbitrary mix of writes, reads and set_len.
    #[test]
    fn model_check_against_reference_vec() {
        use rand::{Rng, SeedableRng};
        let mut rng = rand::rngs::StdRng::seed_from_u64(0xA70A11C);

        let backend = EncryptedBackend::new(SharedMem::default(), &KEY).unwrap();
        let mut model: Vec<u8> = Vec::new();
        let max = BLOCK * 5;

        for _ in 0..300 {
            match rng.gen_range(0..3) {
                0 => {
                    let offset = rng.gen_range(0..max);
                    let len = rng.gen_range(0..BLOCK * 2);
                    let data: Vec<u8> = (0..len).map(|_| rng.gen()).collect();
                    backend.write(offset as u64, &data).unwrap();
                    if offset + len > model.len() {
                        model.resize(offset + len, 0);
                    }
                    model[offset..offset + len].copy_from_slice(&data);
                }
                1 => {
                    if model.is_empty() {
                        continue;
                    }
                    let offset = rng.gen_range(0..model.len());
                    let len = rng.gen_range(0..=model.len() - offset);
                    let mut out = vec![0u8; len];
                    backend.read(offset as u64, &mut out).unwrap();
                    assert_eq!(out, model[offset..offset + len]);
                }
                _ => {
                    let len = rng.gen_range(0..max);
                    backend.set_len(len as u64).unwrap();
                    model.resize(len, 0);
                }
            }
            assert_eq!(backend.len().unwrap(), model.len() as u64);
        }

        let mut out = vec![0u8; model.len()];
        backend.read(0, &mut out).unwrap();
        assert_eq!(out, model);
    }

    /// End-to-end: a real redb database over the encrypted backend, closed and
    /// reopened with the right and wrong keys.
    #[test]
    fn redb_database_roundtrip_over_encryption() {
        use redb::ReadableDatabase;
        const TABLE: redb::TableDefinition<&str, &str> = redb::TableDefinition::new("t");
        let mem = SharedMem::default();

        {
            let backend = EncryptedBackend::new(mem.clone(), &KEY).unwrap();
            let db = redb::Database::builder()
                .create_with_backend(backend)
                .unwrap();
            let tx = db.begin_write().unwrap();
            {
                let mut table = tx.open_table(TABLE).unwrap();
                table.insert("greeting", "hello encrypted world").unwrap();
            }
            tx.commit().unwrap();
        }

        {
            let backend = EncryptedBackend::new(mem.clone(), &KEY).unwrap();
            let db = redb::Database::builder()
                .create_with_backend(backend)
                .unwrap();
            let tx = db.begin_read().unwrap();
            let table = tx.open_table(TABLE).unwrap();
            assert_eq!(
                table.get("greeting").unwrap().unwrap().value(),
                "hello encrypted world"
            );
        }

        assert!(EncryptedBackend::new(mem, &[9u8; 32]).is_err());
    }
}
