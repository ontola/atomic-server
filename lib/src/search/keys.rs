//! Binary key layouts for the FTS trees.

use crate::db::trees::Tree;

pub const SEARCH_INDEX_VERSION_KEY: &[u8] = b"search_index_v1";

#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Field {
    Title = 0,
    Description = 1,
    Body = 2,
}

impl Field {
    pub const ALL: [Field; 3] = [Field::Title, Field::Description, Field::Body];

    pub fn from_u8(id: u8) -> Option<Self> {
        match id {
            0 => Some(Field::Title),
            1 => Some(Field::Description),
            2 => Some(Field::Body),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct SearchDoc {
    pub drive: String,
    pub parent: String,
    pub field_lens: [u32; 3],
}

pub fn search_trees() -> [Tree; 4] {
    [
        Tree::SearchPostings,
        Tree::SearchDocs,
        Tree::SearchDocTokens,
        Tree::SearchTrigrams,
    ]
}

/// `field_id || token || 0x00 || subject`
pub fn posting_key(field: Field, token: &str, subject: &str) -> Vec<u8> {
    let mut key = posting_prefix(field, token);
    key.extend_from_slice(subject.as_bytes());
    key
}

/// `field_id || token || 0x00` — prefix-scan this to hit every doc for `token`,
/// or `field_id || prefix` (no 0x00) to hit every token starting with `prefix`.
pub fn posting_prefix(field: Field, token: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(1 + token.len() + 1);
    key.push(field as u8);
    key.extend_from_slice(token.as_bytes());
    key.push(0x00);
    key
}

/// Prefix scan for typeahead: `field_id || token_prefix` without the 0x00
/// terminator, so `avo` matches `avocado`.
pub fn posting_typeahead_prefix(field: Field, token_prefix: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(1 + token_prefix.len());
    key.push(field as u8);
    key.extend_from_slice(token_prefix.as_bytes());
    key
}

pub fn token_from_posting_key(key: &[u8], field: Field) -> Option<String> {
    if key.first().copied() != Some(field as u8) {
        return None;
    }
    let rest = &key[1..];
    let zero = rest.iter().position(|&b| b == 0)?;
    String::from_utf8(rest[..zero].to_vec()).ok()
}

/// `trigram || 0x00 || term`
pub fn trigram_key(gram: &str, term: &str) -> Vec<u8> {
    let mut key = trigram_prefix(gram);
    key.extend_from_slice(term.as_bytes());
    key
}

pub fn trigram_prefix(gram: &str) -> Vec<u8> {
    let mut key = Vec::with_capacity(gram.len() + 1);
    key.extend_from_slice(gram.as_bytes());
    key.push(0x00);
    key
}

pub fn encode_tf(tf: u32) -> Vec<u8> {
    tf.to_be_bytes().to_vec()
}

pub fn decode_tf(bytes: &[u8]) -> u32 {
    if bytes.len() >= 4 {
        u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    } else {
        1
    }
}

pub fn encode_doc(doc: &SearchDoc) -> Vec<u8> {
    let mut out = Vec::new();
    write_len_str(&mut out, &doc.drive);
    write_len_str(&mut out, &doc.parent);
    for len in doc.field_lens {
        out.extend_from_slice(&len.to_be_bytes());
    }
    out
}

pub fn decode_doc(bytes: &[u8]) -> SearchDoc {
    let mut i = 0;
    let drive = read_len_str(bytes, &mut i).unwrap_or_default();
    let parent = read_len_str(bytes, &mut i).unwrap_or_default();
    let mut field_lens = [0u32; 3];
    for slot in &mut field_lens {
        if i + 4 <= bytes.len() {
            *slot = u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
            i += 4;
        }
    }
    SearchDoc {
        drive,
        parent,
        field_lens,
    }
}

/// `[field u8][token_len u16 BE][token bytes]...`
pub fn encode_tokens(tokens: &[(u8, String)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (field, token) in tokens {
        out.push(*field);
        let bytes = token.as_bytes();
        let len = (bytes.len() as u16).to_be_bytes();
        out.extend_from_slice(&len);
        out.extend_from_slice(bytes);
    }
    out
}

pub fn decode_tokens(bytes: &[u8]) -> Vec<(u8, String)> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let field = bytes[i];
        i += 1;
        let len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        i += 2;
        if i + len > bytes.len() {
            break;
        }
        if let Ok(token) = std::str::from_utf8(&bytes[i..i + len]) {
            out.push((field, token.to_string()));
        }
        i += len;
    }
    out
}

fn write_len_str(out: &mut Vec<u8>, s: &str) {
    let bytes = s.as_bytes();
    out.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    out.extend_from_slice(bytes);
}

fn read_len_str(bytes: &[u8], i: &mut usize) -> Option<String> {
    if *i + 2 > bytes.len() {
        return None;
    }
    let len = u16::from_be_bytes([bytes[*i], bytes[*i + 1]]) as usize;
    *i += 2;
    if *i + len > bytes.len() {
        return None;
    }
    let s = std::str::from_utf8(&bytes[*i..*i + len]).ok()?.to_string();
    *i += len;
    Some(s)
}
