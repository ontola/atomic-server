//! KV-backed full-text search for [`crate::Db`].
//!
//! Indexes title (name / shortname / filename), description, and Loro document
//! body into the existing store trees so OPFS / redb / sled all get the same
//! engine. Queries AND tokens together, rank with BM25, and match a 1-edit
//! prefix-fuzzy bar (`avacado` finds `avocado`, `avo` typeahead works).
//! Property filters reuse the PropValSub index (exact `property:"value"`, AND).
//! Empty `q` + filters lists matching subjects (file picker, class selector).
//!
//! See `planning/local-search.md`.

use std::collections::{HashMap, HashSet};

use crate::{
    client::search::SearchOpts,
    db::{
        prop_val_sub_index::find_in_prop_val_sub_index,
        trees::{Method, Operation, Transaction, Tree},
        Db,
    },
    errors::AtomicResult,
    urls, Resource, Storelike, Subject, Value,
};

mod fuzzy;
mod keys;
mod tokenize;

pub use fuzzy::{min_prefix_levenshtein, one_edits};
pub use tokenize::tokenize;

use keys::{
    decode_doc, decode_tf, decode_tokens, encode_doc, encode_tf, encode_tokens, posting_key,
    posting_prefix, posting_typeahead_prefix, search_trees, token_from_posting_key, trigram_key,
    trigram_prefix, Field, SearchDoc, SEARCH_INDEX_VERSION_KEY,
};

/// A ranked hit from [`query`].
#[derive(Debug, Clone, PartialEq)]
pub struct SearchHit {
    pub subject: Subject,
    pub score: f32,
}

const BM25_K1: f32 = 1.2;
const BM25_B: f32 = 0.75;
/// Typical title+description length in tokens. Used as avgdl; per-doc `dl`
/// still length-normalizes. Good enough that we don't need a `SearchMeta` tree.
const AVGDL: f32 = 32.0;
const DEFAULT_LIMIT: u32 = 30;
const MAX_PARENT_WALK: usize = 64;
/// Generate the full 1-edit neighborhood (and prefix-scan it) up to this
/// token length. Longer tokens use trigrams + verify.
const EDIT_GEN_MAX_LEN: usize = 12;
const MIN_FUZZY_LEN: usize = 2;

/// Index (or re-index) a resource into the FTS trees.
/// Skips commits and documents with no searchable text. Replaces any previous
/// posting lists for the same subject.
pub fn index_resource(
    store: &Db,
    resource: &Resource,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    if skip_resource(resource) {
        return Ok(());
    }

    let subject = resource.get_subject().pure_id();
    unindex_subject(store, &subject, transaction)?;

    let fields = extract_fields(resource);
    if fields.iter().all(|(_, text)| text.is_empty()) {
        return Ok(());
    }

    let drive = resource
        .get_drive()
        .map(|d| d.pure_id())
        .unwrap_or_default();
    let parent = resource
        .get(urls::PARENT)
        .ok()
        .map(|v| Subject::from(v.to_string()).pure_id())
        .unwrap_or_default();

    let mut token_list: Vec<(u8, String)> = Vec::new();
    let mut field_lens = [0u32; 3];
    let mut unique_terms: HashSet<String> = HashSet::new();

    for (field, text) in fields {
        if text.is_empty() {
            continue;
        }
        let tokens = tokenize(&text);
        field_lens[field as usize] = tokens.len() as u32;
        let mut tf: HashMap<String, u32> = HashMap::new();
        for token in tokens {
            *tf.entry(token).or_insert(0) += 1;
        }
        for (token, count) in tf {
            unique_terms.insert(token.clone());
            token_list.push((field as u8, token.clone()));
            transaction.push(Operation {
                tree: Tree::SearchPostings,
                method: Method::Insert,
                key: posting_key(field, &token, &subject),
                val: Some(encode_tf(count)),
            });
        }
    }

    for term in unique_terms {
        for gram in trigrams(&term) {
            transaction.push(Operation {
                tree: Tree::SearchTrigrams,
                method: Method::Insert,
                key: trigram_key(&gram, &term),
                val: Some(Vec::new()),
            });
        }
    }

    let doc = SearchDoc {
        drive,
        parent,
        field_lens,
    };
    transaction.push(Operation {
        tree: Tree::SearchDocs,
        method: Method::Insert,
        key: subject.as_bytes().to_vec(),
        val: Some(encode_doc(&doc)),
    });
    transaction.push(Operation {
        tree: Tree::SearchDocTokens,
        method: Method::Insert,
        key: subject.as_bytes().to_vec(),
        val: Some(encode_tokens(&token_list)),
    });

    Ok(())
}

/// Index many resources, committing every `chunk` documents. Used by benches
/// and bulk rebuilds.
pub fn index_resources(store: &Db, resources: &[Resource], chunk: usize) -> AtomicResult<()> {
    let mut transaction = Transaction::new();
    let chunk = chunk.max(1);
    for (i, resource) in resources.iter().enumerate() {
        index_resource(store, resource, &mut transaction)?;
        if (i + 1) % chunk == 0 {
            store.apply_transaction(&mut transaction)?;
            transaction.clear();
        }
    }
    if !transaction.is_empty() {
        store.apply_transaction(&mut transaction)?;
    }
    Ok(())
}

/// Drop every posting for `subject`. Idempotent if the subject is not indexed.
pub fn unindex_subject(
    store: &Db,
    subject: &str,
    transaction: &mut Transaction,
) -> AtomicResult<()> {
    let Some(token_bytes) = store.kv.get(Tree::SearchDocTokens, subject.as_bytes())? else {
        return Ok(());
    };
    let tokens = decode_tokens(&token_bytes);
    for (field_id, token) in tokens {
        let field = Field::from_u8(field_id).unwrap_or(Field::Title);
        transaction.push(Operation {
            tree: Tree::SearchPostings,
            method: Method::Delete,
            key: posting_key(field, &token, subject),
            val: None,
        });
    }
    transaction.push(Operation {
        tree: Tree::SearchDocTokens,
        method: Method::Delete,
        key: subject.as_bytes().to_vec(),
        val: None,
    });
    transaction.push(Operation {
        tree: Tree::SearchDocs,
        method: Method::Delete,
        key: subject.as_bytes().to_vec(),
        val: None,
    });
    Ok(())
}

/// Wipe and rebuild the FTS trees from every stored resource.
pub fn build_search_index(store: &Db) -> AtomicResult<()> {
    tracing::info!("Building full-text search index");
    for tree in search_trees() {
        store.kv.clear_tree(tree)?;
    }
    for (count, resource) in store.all_resources(true).enumerate() {
        let mut transaction = Transaction::new();
        index_resource(store, &resource, &mut transaction)?;
        store.apply_transaction(&mut transaction)?;
        if count > 0 && count % 1000 == 0 {
            tracing::info!("Search index: {} resources", count);
        }
        if count > 0 && count % 10000 == 0 {
            store.kv.flush()?;
        }
    }
    mark_search_ready(store)?;
    tracing::info!("Full-text search index finished");
    Ok(())
}

/// Rebuild once on stores that predate this index. New stores are filled
/// incrementally by [`index_resource`]; we only scan when the FTS trees are
/// empty but resources already exist (an upgraded file).
pub fn maybe_rebuild_search_index(store: &Db) -> AtomicResult<()> {
    if store
        .kv
        .get(Tree::PluginMeta, SEARCH_INDEX_VERSION_KEY)?
        .is_some()
    {
        return Ok(());
    }
    let n_search = store.kv.len(Tree::SearchDocs).unwrap_or(0);
    let n_resources = store.kv.len(Tree::Resources).unwrap_or(0);
    if n_search == 0 && n_resources > 0 {
        tracing::info!(
            "Search index missing on a store with {} resources; rebuilding",
            n_resources
        );
        build_search_index(store)?;
    }
    mark_search_ready(store)
}

fn mark_search_ready(store: &Db) -> AtomicResult<()> {
    store
        .kv
        .insert(Tree::PluginMeta, SEARCH_INDEX_VERSION_KEY, b"1")
}

/// Ranked full-text search over the KV index.
///
/// Empty `query_str` with no filters returns nothing. Empty `query_str` with
/// filters lists PropValSub matches (then parent-scoped), which is what the
/// file picker and class selector send.
pub fn query(store: &Db, query_str: &str, opts: &SearchOpts) -> AtomicResult<Vec<SearchHit>> {
    let tokens: Vec<String> = tokenize(query_str);
    let filter_pairs = opts_filter_pairs(opts);
    let filter_set = if filter_pairs.is_empty() {
        None
    } else {
        Some(subjects_matching_filters(store, &filter_pairs)?)
    };

    let limit = opts.limit.unwrap_or(DEFAULT_LIMIT) as usize;
    let parents: Vec<String> = opts
        .parents
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|p| Subject::from(p).pure_id())
        .collect();

    if tokens.is_empty() {
        let Some(allowed) = filter_set else {
            return Ok(Vec::new());
        };
        return filter_only_hits(store, allowed, &parents, limit);
    }

    let n_docs = store.kv.len(Tree::SearchDocs).unwrap_or(0) as f32;
    if n_docs == 0.0 {
        return Ok(Vec::new());
    }

    // Per query token: subject → best score for that token.
    let mut per_token: Vec<HashMap<String, f32>> = Vec::with_capacity(tokens.len());
    for token in &tokens {
        per_token.push(score_token(store, token, n_docs)?);
    }

    // AND: a doc must score on every query token.
    let mut subjects: HashSet<String> = per_token[0].keys().cloned().collect();
    for map in per_token.iter().skip(1) {
        subjects.retain(|s| map.contains_key(s));
    }
    if let Some(allowed) = &filter_set {
        subjects.retain(|s| allowed.contains(s));
    }

    let mut hits: Vec<SearchHit> = Vec::new();
    let mut doc_cache: HashMap<String, SearchDoc> = HashMap::new();

    for subject in subjects {
        if !parents.is_empty() && !subject_in_parents(store, &subject, &parents, &mut doc_cache)? {
            continue;
        }
        let mut score = 0.0;
        for map in &per_token {
            score += map.get(&subject).copied().unwrap_or(0.0);
        }
        hits.push(SearchHit {
            subject: Subject::from(subject),
            score,
        });
    }

    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.subject.as_str().cmp(b.subject.as_str()))
    });
    hits.truncate(limit);

    Ok(hits)
}

fn opts_filter_pairs(opts: &SearchOpts) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(map) = &opts.filters {
        for (key, value) in map {
            if !value.is_empty() {
                out.push((key.clone(), value.clone()));
            }
        }
    }
    if let Some(pairs) = &opts.filter_pairs {
        for (key, value) in pairs {
            if !value.is_empty() {
                out.push((key.clone(), value.clone()));
            }
        }
    }
    out
}

/// Parse the HTTP `filters=` string: exact `property:"value"` pairs joined
/// by ` AND `. Property URLs are taken literally — there is no query
/// language and no special-character escaping.
pub fn parse_search_filters(filters: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut rest = filters;
    while !rest.is_empty() {
        let (clause, next) = split_filter_clause(rest);
        rest = next;
        if let Some(pair) = parse_filter_clause(clause) {
            pairs.push(pair);
        }
    }
    pairs
}

fn split_filter_clause(input: &str) -> (&str, &str) {
    let mut in_quotes = false;
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] as char {
            '"' => in_quotes = !in_quotes,
            ' ' if !in_quotes && input[i..].starts_with(" AND ") => {
                return (&input[..i], &input[i + 5..]);
            }
            _ => {}
        }
        i += 1;
    }
    (input, "")
}

fn parse_filter_clause(clause: &str) -> Option<(String, String)> {
    let clause = clause.trim();
    if clause.is_empty() {
        return None;
    }
    // `:"` is the delimiter so property URLs (`https://…`) stay intact.
    let idx = clause.find(":\"")?;
    let key = clause[..idx].trim();
    let rest = &clause[idx + 2..];
    let end = rest.find('"').unwrap_or(rest.len());
    let value = rest[..end].trim();
    if key.is_empty() || value.is_empty() {
        return None;
    }
    Some((key.to_string(), value.to_string()))
}

fn subjects_matching_filters(
    store: &Db,
    pairs: &[(String, String)],
) -> AtomicResult<HashSet<String>> {
    let mut result: Option<HashSet<String>> = None;
    for (prop, val) in pairs {
        let value = Value::String(val.clone());
        let mut set = HashSet::new();
        for atom in find_in_prop_val_sub_index(store, prop, Some(&value)) {
            set.insert(atom?.subject.to_string());
        }
        result = Some(match result {
            None => set,
            Some(prev) => prev.intersection(&set).cloned().collect(),
        });
    }
    Ok(result.unwrap_or_default())
}

fn filter_only_hits(
    store: &Db,
    allowed: HashSet<String>,
    parents: &[String],
    limit: usize,
) -> AtomicResult<Vec<SearchHit>> {
    let mut hits = Vec::new();
    let mut doc_cache: HashMap<String, SearchDoc> = HashMap::new();
    let mut subjects: Vec<String> = allowed.into_iter().collect();
    subjects.sort();
    for subject in subjects {
        if !parents.is_empty() && !subject_in_parents(store, &subject, parents, &mut doc_cache)? {
            continue;
        }
        hits.push(SearchHit {
            subject: Subject::from(subject),
            score: 1.0,
        });
        if hits.len() >= limit {
            break;
        }
    }
    Ok(hits)
}

fn subject_in_parents(
    store: &Db,
    subject: &str,
    parents: &[String],
    cache: &mut HashMap<String, SearchDoc>,
) -> AtomicResult<bool> {
    let doc = load_doc(store, subject, cache)?;
    if in_scope(subject, &doc, parents, store, cache)? {
        return Ok(true);
    }
    // Not in SearchDocs (no searchable text) — walk the resource itself.
    resource_in_parents(store, subject, parents)
}

fn resource_in_parents(store: &Db, subject: &str, parents: &[String]) -> AtomicResult<bool> {
    let mut current = subject.to_string();
    let mut seen = HashSet::new();
    for _ in 0..MAX_PARENT_WALK {
        if !seen.insert(current.clone()) {
            break;
        }
        if parents.iter().any(|p| p == &current) {
            return Ok(true);
        }
        let Ok(resource) = store.get_resource_shallow(&current.as_str().into()) else {
            break;
        };
        if let Some(drive) = resource.get_drive() {
            let drive_id = drive.pure_id();
            if parents
                .iter()
                .any(|p| p == &drive_id || p == drive.as_str())
            {
                return Ok(true);
            }
        }
        let parent = resource
            .get(urls::PARENT)
            .ok()
            .map(|v| Subject::from(v.to_string()).pure_id())
            .unwrap_or_default();
        if parent.is_empty() {
            break;
        }
        if parents.contains(&parent) {
            return Ok(true);
        }
        current = parent;
    }
    Ok(false)
}

fn score_token(store: &Db, q: &str, n_docs: f32) -> AtomicResult<HashMap<String, f32>> {
    let mut scores: HashMap<String, f32> = HashMap::new();
    let mut seen_terms: HashSet<(u8, String)> = HashSet::new();

    // Always prefix-scan the original token (typeahead).
    collect_prefix(store, q, q, &mut seen_terms)?;

    if q.chars().count() >= MIN_FUZZY_LEN && q.chars().count() <= EDIT_GEN_MAX_LEN {
        for variant in one_edits(q) {
            collect_prefix(store, &variant, q, &mut seen_terms)?;
        }
    } else if q.chars().count() > EDIT_GEN_MAX_LEN {
        collect_trigram_candidates(store, q, &mut seen_terms)?;
    }

    for (field_id, term) in seen_terms {
        let field = Field::from_u8(field_id).unwrap_or(Field::Title);
        let kind = classify_match(q, &term);
        let boost = field.boost(kind);
        let prefix = posting_prefix(field, &term);
        let mut df = 0u32;
        let mut postings: Vec<(String, u32)> = Vec::new();
        for pair in store.kv.scan_prefix(Tree::SearchPostings, &prefix) {
            let (key, val) = pair?;
            let subject = match subject_from_posting(&key, &prefix) {
                Some(s) => s,
                None => continue,
            };
            df += 1;
            postings.push((subject, decode_tf(&val)));
        }
        if df == 0 {
            continue;
        }
        let idf = ((n_docs - df as f32 + 0.5) / (df as f32 + 0.5) + 1.0).ln();
        for (subject, tf) in postings {
            let dl = doc_len(store, &subject).unwrap_or(AVGDL);
            let tf_norm = (tf as f32 * (BM25_K1 + 1.0))
                / (tf as f32 + BM25_K1 * (1.0 - BM25_B + BM25_B * (dl / AVGDL)));
            let add = boost * idf * tf_norm;
            scores
                .entry(subject)
                .and_modify(|s| *s += add)
                .or_insert(add);
        }
    }

    Ok(scores)
}

#[derive(Clone, Copy)]
enum MatchKind {
    Exact,
    Prefix,
    Fuzzy,
}

impl Field {
    fn boost(self, kind: MatchKind) -> f32 {
        match (self, kind) {
            (Field::Title, MatchKind::Exact) => 10.0,
            (Field::Title, MatchKind::Prefix) => 6.0,
            (Field::Title, MatchKind::Fuzzy) => 4.0,
            (Field::Description | Field::Body, MatchKind::Exact) => 2.0,
            (Field::Description | Field::Body, MatchKind::Prefix) => 1.5,
            (Field::Description | Field::Body, MatchKind::Fuzzy) => 1.0,
        }
    }
}

fn classify_match(query: &str, term: &str) -> MatchKind {
    if term == query {
        MatchKind::Exact
    } else if term.starts_with(query) {
        MatchKind::Prefix
    } else {
        MatchKind::Fuzzy
    }
}

fn collect_prefix(
    store: &Db,
    prefix_token: &str,
    query: &str,
    out: &mut HashSet<(u8, String)>,
) -> AtomicResult<()> {
    if prefix_token.is_empty() {
        return Ok(());
    }
    for field in Field::ALL {
        let prefix = posting_typeahead_prefix(field, prefix_token);
        for pair in store.kv.scan_prefix(Tree::SearchPostings, &prefix) {
            let (key, _) = pair?;
            if let Some(term) = token_from_posting_key(&key, field) {
                if term.starts_with(prefix_token) || min_prefix_levenshtein(query, &term) <= 1 {
                    out.insert((field as u8, term));
                }
            }
        }
    }
    Ok(())
}

fn collect_trigram_candidates(
    store: &Db,
    q: &str,
    out: &mut HashSet<(u8, String)>,
) -> AtomicResult<()> {
    let grams = trigrams(q);
    if grams.is_empty() {
        return Ok(());
    }
    let mut counts: HashMap<String, usize> = HashMap::new();
    for gram in &grams {
        for pair in store
            .kv
            .scan_prefix(Tree::SearchTrigrams, &trigram_prefix(gram))
        {
            let (key, _) = pair?;
            if let Some(term) = term_from_trigram_key(&key, gram) {
                *counts.entry(term).or_insert(0) += 1;
            }
        }
    }
    let required = grams.len().saturating_sub(3).max(1);
    for (term, n) in counts {
        if n >= required && min_prefix_levenshtein(q, &term) <= 1 {
            for field in Field::ALL {
                out.insert((field as u8, term.clone()));
            }
        }
    }
    Ok(())
}

fn skip_resource(resource: &Resource) -> bool {
    let subject = resource.get_subject();
    if subject.is_commit_did() {
        return true;
    }
    if subject.as_str().contains("/commits/") {
        return true;
    }
    resource.is_native()
}

fn extract_fields(resource: &Resource) -> Vec<(Field, String)> {
    let title = title_text(resource);
    let description = description_text(resource);
    let body = body_text(resource);
    vec![
        (Field::Title, title),
        (Field::Description, description),
        (Field::Body, body),
    ]
}

fn title_text(resource: &Resource) -> String {
    if let Ok(v) = resource.get(urls::NAME) {
        return stringy(v);
    }
    if let Ok(v) = resource.get(urls::SHORTNAME) {
        return stringy(v);
    }
    if let Ok(v) = resource.get(urls::FILENAME) {
        return stringy(v);
    }
    String::new()
}

fn description_text(resource: &Resource) -> String {
    resource
        .get(urls::DESCRIPTION)
        .ok()
        .map(stringy)
        .unwrap_or_default()
}

fn body_text(resource: &Resource) -> String {
    if let Some(snapshot) = resource.materialized_state() {
        if let Ok(doc) = crate::loro::AtomicLoroDoc::from_snapshot(&snapshot) {
            let text = doc.extract_document_plain_text();
            if !text.is_empty() {
                return text;
            }
        }
    }
    // `set_unsafe` materializes a properties-only live doc, after which
    // `materialized_state` prefers that over the `loroUpdate` propval. A
    // snapshot stored as `LORO_UPDATE` can still carry `documentContent`.
    if let Ok(Value::LoroDoc(snapshot)) = resource.get(urls::LORO_UPDATE) {
        if let Ok(doc) = crate::loro::AtomicLoroDoc::from_snapshot(snapshot) {
            return doc.extract_document_plain_text();
        }
    }
    String::new()
}

fn stringy(value: &Value) -> String {
    match value {
        Value::String(s) | Value::Markdown(s) | Value::Slug(s) | Value::Date(s) | Value::Uri(s) => {
            s.clone()
        }
        Value::LocalizedText(map) => map.values().cloned().collect::<Vec<_>>().join(" "),
        Value::AtomicUrl(_)
        | Value::ResourceArray(_)
        | Value::NestedResource(_)
        | Value::LoroDoc(_) => String::new(),
        other => other.to_string(),
    }
}

fn trigrams(term: &str) -> Vec<String> {
    let chars: Vec<char> = term.chars().collect();
    if chars.len() < 3 {
        return if chars.is_empty() {
            Vec::new()
        } else {
            vec![term.to_string()]
        };
    }
    chars.windows(3).map(|w| w.iter().collect()).collect()
}

fn subject_from_posting(key: &[u8], prefix: &[u8]) -> Option<String> {
    if key.len() <= prefix.len() {
        return None;
    }
    String::from_utf8(key[prefix.len()..].to_vec()).ok()
}

fn term_from_trigram_key(key: &[u8], gram: &str) -> Option<String> {
    let prefix = trigram_prefix(gram);
    if key.len() <= prefix.len() {
        return None;
    }
    String::from_utf8(key[prefix.len()..].to_vec()).ok()
}

fn load_doc(
    store: &Db,
    subject: &str,
    cache: &mut HashMap<String, SearchDoc>,
) -> AtomicResult<SearchDoc> {
    if let Some(doc) = cache.get(subject) {
        return Ok(doc.clone());
    }
    let bytes = store
        .kv
        .get(Tree::SearchDocs, subject.as_bytes())?
        .unwrap_or_default();
    let doc = decode_doc(&bytes);
    cache.insert(subject.to_string(), doc.clone());
    Ok(doc)
}

fn doc_len(store: &Db, subject: &str) -> Option<f32> {
    let bytes = store.kv.get(Tree::SearchDocs, subject.as_bytes()).ok()??;
    let doc = decode_doc(&bytes);
    let len = doc.field_lens.iter().sum::<u32>();
    if len == 0 {
        Some(AVGDL)
    } else {
        Some(len as f32)
    }
}

fn in_scope(
    subject: &str,
    doc: &SearchDoc,
    parents: &[String],
    store: &Db,
    cache: &mut HashMap<String, SearchDoc>,
) -> AtomicResult<bool> {
    for scope in parents {
        if subject == scope {
            return Ok(true);
        }
        if !doc.drive.is_empty() && doc.drive == *scope {
            return Ok(true);
        }
    }
    let mut current = subject.to_string();
    let mut seen = HashSet::new();
    for _ in 0..MAX_PARENT_WALK {
        if !seen.insert(current.clone()) {
            break;
        }
        let node = if current == subject {
            doc.clone()
        } else {
            load_doc(store, &current, cache)?
        };
        if parents.contains(&current) {
            return Ok(true);
        }
        if node.parent.is_empty() {
            break;
        }
        if parents.contains(&node.parent) {
            return Ok(true);
        }
        current = node.parent;
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
