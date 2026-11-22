//! Limits apply to the uncompressed package, including files not selected for install.
use atomic_lib::errors::{AtomicError, AtomicResult};
use std::io::{Cursor, Read, Seek};
use zip::ZipArchive;

const MAX_FILES: usize = 4096;
const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// Bound directory allocations before the ZIP parser opens a package. The parser
/// may try earlier end records if the last one is invalid. Check each candidate.
pub(super) fn open<B: AsRef<[u8]>>(source: B) -> AtomicResult<ZipArchive<Cursor<B>>> {
    let bytes = source.as_ref();
    check_package_size(bytes.len() as u64)?;
    for pos in memchr::memmem::find_iter(bytes, b"PK\x05\x06") {
        let Some(end) = bytes.get(pos..pos + 22) else {
            continue;
        };
        let zip64 = pos >= 20 && &bytes[pos - 20..pos - 16] == b"PK\x06\x07";
        let comment_len = usize::from(u16::from_le_bytes([end[20], end[21]]));
        if pos + 22 + comment_len > bytes.len() {
            continue;
        }
        // The ZIP32 reader allocates from the per-disk count. Both counts
        // describe the same directory in a single-disk plugin package.
        let disk = &end[4..6];
        let directory_disk = &end[6..8];
        let on_disk = u16::from_le_bytes([end[8], end[9]]);
        let total = u16::from_le_bytes([end[10], end[11]]);
        if zip64 || (disk == directory_disk && !counts_fit(on_disk, total)) {
            return Err("Use a ZIP32 plugin package with at most 4096 files".into());
        }
    }
    let mut zip = ZipArchive::new(Cursor::new(source))
        .map_err(|e| AtomicError::from(format!("Invalid plugin archive: {e}")))?;
    check_sizes(&mut zip)?;
    Ok(zip)
}

pub(super) fn check_package_size(size: u64) -> AtomicResult<()> {
    if size > MAX_PACKAGE_BYTES {
        return Err("Plugin archive is too large".into());
    }
    Ok(())
}

fn counts_fit(on_disk: u16, total: u16) -> bool {
    usize::from(on_disk.max(total)) <= MAX_FILES
}

fn account_file(remaining: &mut u64, name: &str, size: u64) -> AtomicResult<()> {
    let limit = if name == "plugin.json" {
        MAX_MANIFEST_BYTES
    } else {
        MAX_FILE_BYTES
    };
    if size > limit || size > *remaining {
        return Err("Plugin package exceeds its uncompressed size limit".into());
    }
    *remaining -= size;
    Ok(())
}

pub(super) fn check_sizes<R: Read + Seek>(zip: &mut ZipArchive<R>) -> AtomicResult<()> {
    if zip.len() > MAX_FILES {
        return Err("Plugin package contains too many files".into());
    }
    let mut remaining = MAX_PACKAGE_BYTES;
    for i in 0..zip.len() {
        let file = zip
            .by_index_raw(i)
            .map_err(|e| AtomicError::from(e.to_string()))?;
        if !matches!(
            file.compression(),
            zip::CompressionMethod::Stored | zip::CompressionMethod::Deflated
        ) {
            return Err("Plugin packages support stored and deflated files".into());
        }
        account_file(&mut remaining, file.name(), file.size())?;
    }
    Ok(())
}

/// The size charged to the package also bounds the decoder. Validate the complete
/// entry before handing its bytes to a parser, a compiler or the filesystem.
pub(super) fn read_file(reader: impl Read, declared: u64) -> AtomicResult<Vec<u8>> {
    if declared > MAX_FILE_BYTES {
        return Err("Plugin file exceeds its uncompressed size limit".into());
    }
    let mut bytes = Vec::new();
    reader
        .take(declared + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| AtomicError::from(format!("Could not read plugin file: {e}")))?;
    if bytes.len() as u64 != declared {
        return Err("Plugin file size differs from the package directory".into());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_directory_counts_are_bounded() {
        let limit = u16::try_from(MAX_FILES).unwrap();
        assert!(counts_fit(limit, limit));
        assert!(!counts_fit(limit + 1, limit));
        assert!(!counts_fit(limit, limit + 1));
    }

    #[test]
    fn opens_an_ordinary_package_and_reads_its_contents() {
        use std::io::Write;
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("plugin.json", zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"{}").unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        let mut zip = open(bytes).unwrap();
        let file = zip.by_name("plugin.json").unwrap();
        let size = file.size();
        assert_eq!(read_file(file, size).unwrap(), b"{}");
    }

    #[test]
    fn plugin_expansion_is_bounded_per_file_and_in_total() {
        let mut left = MAX_PACKAGE_BYTES;
        assert!(account_file(&mut left, "plugin.json", MAX_MANIFEST_BYTES + 1).is_err());
        assert!(account_file(&mut left, "ui.js", MAX_FILE_BYTES + 1).is_err());
        account_file(&mut left, "plugin.wasm", MAX_FILE_BYTES).unwrap();
        account_file(&mut left, "assets/data", MAX_FILE_BYTES).unwrap();
        assert!(account_file(&mut left, "ui.css", 1).is_err());
        assert_eq!(read_file(&b"abc"[..], 3).unwrap(), b"abc");
        assert!(read_file(&b"abc"[..], 2).is_err());
        assert!(read_file(&b"abc"[..], 4).is_err());
    }
}
