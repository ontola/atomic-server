//! Binary key layouts for the FTS trees.

use crate::db::trees::Tree;

/// Bumped with the key layout: v2 keys postings by an 8-byte document id
/// instead of the subject and folds the per-document token list into the
/// document row, so an index of the old layout is rebuilt once.
pub const SEARCH_INDEX_VERSION_KEY: &[u8] = b"search_index_v2";

/// Stable document id: the first 8 bytes of blake3 of the subject. Needs no
/// counter, so concurrent batches, replays and rebuilds all agree on it.
pub type DocId = u64;

pub fn doc_id(subject: &str) -> DocId {
    let hash = blake3::hash(subject.as_bytes());
    let mut id = [0u8; 8];
    id.copy_from_slice(&hash.as_bytes()[..8]);
    u64::from_be_bytes(id)
}

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

/// One token of a document: field, token, term frequency.
pub type DocToken = (u8, String, u32);

/// The row stored per document in `SearchDocs`, keyed by [`DocId`].
#[derive(Debug, Clone, Default)]
pub struct SearchDoc {
    pub subject: String,
    /// 0 when the document has none.
    pub drive: DocId,
    pub parent: DocId,
    pub field_lens: [u32; 3],
    /// Needed to remove the postings again; empty unless decoded with tokens.
    pub tokens: Vec<DocToken>,
}

pub fn search_trees() -> [Tree; 3] {
    [Tree::SearchPostings, Tree::SearchDocs, Tree::SearchTrigrams]
}

/// `field_id || token || 0x00 || doc_id (8 bytes BE)`
pub fn posting_key(field: Field, token: &str, id: DocId) -> Vec<u8> {
    let mut key = posting_prefix(field, token);
    key.extend_from_slice(&id.to_be_bytes());
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

/// Term frequency as a varint: one byte for anything under 128.
pub fn encode_tf(tf: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity(1);
    write_varint(&mut out, tf);
    out
}

pub fn decode_tf(bytes: &[u8]) -> u32 {
    let mut i = 0;
    read_varint(bytes, &mut i).unwrap_or(1)
}

/// `[field_lens varint x3][drive u64][parent u64][subject len+bytes]`, then
/// `[token count varint]` and per token `[field u8][tf varint][len varint][bytes]`.
pub fn encode_doc(doc: &SearchDoc) -> Vec<u8> {
    let mut out = Vec::with_capacity(32 + doc.subject.len() + doc.tokens.len() * 10);
    for len in doc.field_lens {
        write_varint(&mut out, len);
    }
    out.extend_from_slice(&doc.drive.to_be_bytes());
    out.extend_from_slice(&doc.parent.to_be_bytes());
    write_len_str(&mut out, &doc.subject);
    write_varint(&mut out, doc.tokens.len() as u32);
    for (field, token, tf) in &doc.tokens {
        out.push(*field);
        write_varint(&mut out, *tf);
        write_len_str(&mut out, token);
    }
    out
}

/// Decode a document row. The token list is only read when `with_tokens`:
/// scoring needs the lengths and scope of many documents and never the tokens.
pub fn decode_doc(bytes: &[u8], with_tokens: bool) -> SearchDoc {
    let mut i = 0;
    let mut field_lens = [0u32; 3];
    for slot in &mut field_lens {
        *slot = read_varint(bytes, &mut i).unwrap_or(0);
    }
    let drive = read_u64(bytes, &mut i).unwrap_or(0);
    let parent = read_u64(bytes, &mut i).unwrap_or(0);
    let subject = read_len_str(bytes, &mut i).unwrap_or_default();
    let mut tokens = Vec::new();
    if with_tokens {
        let count = read_varint(bytes, &mut i).unwrap_or(0);
        for _ in 0..count {
            let Some(&field) = bytes.get(i) else { break };
            i += 1;
            let Some(tf) = read_varint(bytes, &mut i) else {
                break;
            };
            let Some(token) = read_len_str(bytes, &mut i) else {
                break;
            };
            tokens.push((field, token, tf));
        }
    }
    SearchDoc {
        subject,
        drive,
        parent,
        field_lens,
        tokens,
    }
}

fn write_varint(out: &mut Vec<u8>, mut value: u32) {
    while value >= 0x80 {
        out.push((value & 0x7f) as u8 | 0x80);
        value >>= 7;
    }
    out.push(value as u8);
}

fn read_varint(bytes: &[u8], i: &mut usize) -> Option<u32> {
    let mut value = 0u32;
    let mut shift = 0;
    loop {
        let byte = *bytes.get(*i)?;
        *i += 1;
        value |= u32::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
        if shift > 28 {
            return None;
        }
    }
}

fn read_u64(bytes: &[u8], i: &mut usize) -> Option<u64> {
    let chunk = bytes.get(*i..*i + 8)?;
    *i += 8;
    Some(u64::from_be_bytes(chunk.try_into().ok()?))
}

fn write_len_str(out: &mut Vec<u8>, s: &str) {
    write_varint(out, s.len() as u32);
    out.extend_from_slice(s.as_bytes());
}

fn read_len_str(bytes: &[u8], i: &mut usize) -> Option<String> {
    let len = read_varint(bytes, i)? as usize;
    let s = std::str::from_utf8(bytes.get(*i..*i + len)?)
        .ok()?
        .to_string();
    *i += len;
    Some(s)
}
