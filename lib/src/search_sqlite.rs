//! SQLite-based search implementation using FTS5 and FST for fuzzy matching
//! This replaces the Tantivy-based search to eliminate file locking issues

#[cfg(feature = "db")]
use crate::{errors::AtomicResult, Db, Resource, Storelike};

#[cfg(feature = "db")]
use fst::{automaton, IntoStreamer, Map, MapBuilder, Streamer};
#[cfg(feature = "db")]
use rusqlite::{params, Connection, Row};

/// SQLite-based search state that uses FTS5 for full-text search and FST for fuzzy matching
#[cfg(feature = "db")]
#[derive(Clone)]
pub struct SqliteSearchState {
    /// Reference to the main database
    pub db: Db,
}

#[cfg(feature = "db")]
impl SqliteSearchState {
    /// Create a new SqliteSearchState
    pub fn new(db: Db) -> AtomicResult<Self> {
        let search_state = SqliteSearchState { db };

        // Initialize search metadata if needed
        search_state.initialize_search_metadata()?;

        Ok(search_state)
    }

    /// Initialize search metadata table with default values
    fn initialize_search_metadata(&self) -> AtomicResult<()> {
        let conn = self.db.get_connection()?;

        conn.execute(
            "INSERT OR IGNORE INTO search_metadata (key, value) VALUES ('version', '1')",
            [],
        )
        .map_err(|e| format!("Failed to initialize search metadata: {}", e))?;

        Ok(())
    }

    /// Index all resources from the store into the FTS5 search index
    pub fn add_all_resources(&self, store: &Db) -> AtomicResult<()> {
        tracing::info!("Building SQLite FTS5 search index...");

        let conn = self.db.get_connection()?;

        // Clear existing search index
        conn.execute("DELETE FROM search_index", [])
            .map_err(|e| format!("Failed to clear search index: {}", e))?;

        let resources = store
            .all_resources(true)
            .filter(|resource| !resource.get_subject().contains("/commits/"));

        let mut indexed_count = 0;
        for resource in resources {
            self.add_resource(&resource, &conn)?;
            indexed_count += 1;

            if indexed_count % 1000 == 0 {
                tracing::info!("Indexed {} resources", indexed_count);
            }
        }

        tracing::info!(
            "FTS5 search index finished! Indexed {} resources",
            indexed_count
        );

        // Build FST index for fuzzy search
        self.build_fst_index(&conn)?;

        Ok(())
    }

    /// Add a single resource to the FTS5 search index
    pub fn add_resource(&self, resource: &Resource, conn: &Connection) -> AtomicResult<()> {
        let subject = resource.get_subject().to_string();
        let title = get_resource_title(resource);

        let description =
            if let Ok(crate::Value::Markdown(desc)) = resource.get(crate::urls::DESCRIPTION) {
                desc.to_string()
            } else {
                String::new()
            };

        let propvals_json = resource.to_json_ad().unwrap_or_else(|_| "{}".to_string());

        // Build hierarchy path for faceted search
        let hierarchy = resource_to_hierarchy_path(resource, &self.db)?;

        conn.execute(
            "INSERT OR REPLACE INTO search_index (subject, title, description, propvals_json, hierarchy) 
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![subject, title, description, propvals_json, hierarchy],
        ).map_err(|e| format!("Failed to insert resource into search index: {}", e))?;

        Ok(())
    }

    /// Remove a resource from the search index
    pub fn remove_resource(&self, subject: &str) -> AtomicResult<()> {
        let conn = self.db.get_connection()?;

        conn.execute(
            "DELETE FROM search_index WHERE subject = ?1",
            params![subject],
        )
        .map_err(|e| format!("Failed to remove resource from search index: {}", e))?;

        Ok(())
    }

    /// Build FST index for fuzzy search from all indexed terms
    fn build_fst_index(&self, conn: &Connection) -> AtomicResult<()> {
        tracing::info!("Building FST index for fuzzy search...");

        // Extract all unique terms from the FTS5 index
        let mut terms = std::collections::HashMap::new();

        let mut stmt = conn
            .prepare("SELECT title, description FROM search_index")
            .map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let rows = stmt
            .query_map([], |row: &Row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("Failed to query search index: {}", e))?;

        for row in rows {
            let (title, description) = row.map_err(|e| format!("Failed to get row data: {}", e))?;

            // Tokenize and collect terms
            extract_terms(&title, &mut terms);
            extract_terms(&description, &mut terms);
        }

        // Build FST from collected terms
        let mut fst_builder = MapBuilder::memory();
        let mut sorted_terms: Vec<_> = terms.into_iter().collect();
        sorted_terms.sort_by(|a, b| a.0.cmp(&b.0));

        for (term, frequency) in sorted_terms {
            fst_builder
                .insert(&term, frequency as u64)
                .map_err(|e| format!("Failed to insert term into FST: {}", e))?;
        }

        let fst_bytes = fst_builder
            .into_inner()
            .map_err(|e| format!("Failed to build FST: {}", e))?;

        // Store FST in database
        conn.execute(
            "INSERT OR REPLACE INTO fst_index (term, fst_data) VALUES ('main', ?1)",
            params![fst_bytes],
        )
        .map_err(|e| format!("Failed to store FST index: {}", e))?;

        tracing::info!("FST index built successfully");
        Ok(())
    }

    /// Perform a text search using FTS5
    pub fn text_search(&self, query: &str, limit: usize) -> AtomicResult<Vec<String>> {
        let conn = self.db.get_connection()?;

        // Use FTS5 MATCH syntax for full-text search
        let fts_query = format!("title:{} OR description:{}", query, query);

        let mut stmt = conn
            .prepare(
                "SELECT subject FROM search_index WHERE search_index MATCH ?1 
             ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare search statement: {}", e))?;

        let rows = stmt
            .query_map(
                params![fts_query, limit],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("Failed to execute search: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Failed to get search result: {}", e))?);
        }

        Ok(results)
    }

    /// Perform fuzzy search using FST
    pub fn fuzzy_search(
        &self,
        query: &str,
        max_distance: u32,
        limit: usize,
    ) -> AtomicResult<Vec<String>> {
        let conn = self.db.get_connection()?;

        // Get FST data
        let fst_data: Vec<u8> = conn
            .query_row(
                "SELECT fst_data FROM fst_index WHERE term = 'main'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("Failed to get FST data: {}", e))?;

        // Load FST from bytes
        let fst_map = Map::new(fst_data).map_err(|e| format!("Failed to load FST: {}", e))?;

        // Perform fuzzy search using FST automaton
        let mut fuzzy_terms = Vec::new();

        // Use subsequence automaton which provides fuzzy matching capabilities
        // The max_distance parameter is used to limit results later
        let automaton = automaton::Subsequence::new(query);
        let mut stream = fst_map.search(automaton).into_stream();
        let mut term_count = 0;

        while let Some((term, _frequency)) = stream.next() {
            if term_count >= limit {
                break;
            }
            let term_str = String::from_utf8_lossy(term);

            // Simple edit distance check (Levenshtein distance approximation)
            let edit_distance = calculate_edit_distance(query, &term_str);
            if edit_distance <= max_distance {
                fuzzy_terms.push(term_str.to_string());
                term_count += 1;
            }
        }

        // Use fuzzy terms to search in FTS5
        if fuzzy_terms.is_empty() {
            return Ok(Vec::new());
        }

        let fts_query = fuzzy_terms
            .iter()
            .map(|term| format!("title:{} OR description:{}", term, term))
            .collect::<Vec<_>>()
            .join(" OR ");

        let mut stmt = conn
            .prepare(
                "SELECT DISTINCT subject FROM search_index WHERE search_index MATCH ?1 
             ORDER BY rank LIMIT ?2",
            )
            .map_err(|e| format!("Failed to prepare fuzzy search statement: {}", e))?;

        let rows = stmt
            .query_map(
                params![fts_query, limit],
                |row| row.get::<_, String>(0),
            )
            .map_err(|e| format!("Failed to execute fuzzy search: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Failed to get fuzzy search result: {}", e))?);
        }

        Ok(results)
    }

    /// Search with hierarchy/parent filtering
    pub fn hierarchy_search(
        &self,
        parent_subject: &str,
        limit: usize,
    ) -> AtomicResult<Vec<String>> {
        let conn = self.db.get_connection()?;

        let mut stmt = conn.prepare(
            "SELECT subject FROM search_index WHERE hierarchy LIKE ?1 ORDER BY subject LIMIT ?2"
        ).map_err(|e| format!("Failed to prepare hierarchy search statement: {}", e))?;

        let hierarchy_pattern = format!("%{}%", parent_subject);
        let rows = stmt
            .query_map(params![hierarchy_pattern, limit], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| format!("Failed to execute hierarchy search: {}", e))?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(|e| format!("Failed to get hierarchy search result: {}", e))?);
        }

        Ok(results)
    }
}

/// Extract title from resource
#[cfg(feature = "db")]
fn get_resource_title(resource: &Resource) -> String {
    if let Ok(crate::Value::String(title)) = resource.get(crate::urls::NAME) {
        title.to_string()
    } else {
        resource.get_subject().to_string()
    }
}

/// Build hierarchy path for a resource
#[cfg(feature = "db")]
fn resource_to_hierarchy_path(resource: &Resource, _store: &Db) -> AtomicResult<String> {
    let mut hierarchy_parts = Vec::new();
    let mut current_subject = resource.get_subject().to_string();

    // Build hierarchy by following parent relationships
    let mut depth = 0;
    while depth < 10 {
        // Prevent infinite loops
        hierarchy_parts.push(current_subject.clone());

        // Try to find parent
        if let Ok(crate::Value::AtomicUrl(parent_url)) = resource.get(crate::urls::PARENT) {
            current_subject = parent_url.to_string();
            depth += 1;
        } else {
            break;
        }
    }

    // Reverse to get root -> leaf order
    hierarchy_parts.reverse();
    Ok(hierarchy_parts.join("/"))
}

/// Extract and count terms from text
#[cfg(feature = "db")]
fn extract_terms(text: &str, terms: &mut std::collections::HashMap<String, u32>) {
    // Simple tokenization - split on whitespace and punctuation
    for word in text.split_whitespace() {
        let cleaned = word
            .trim_matches(|c: char| !c.is_alphanumeric())
            .to_lowercase();
        if cleaned.len() > 2 {
            // Only index terms longer than 2 characters
            *terms.entry(cleaned).or_insert(0) += 1;
        }
    }
}

/// Calculate edit distance (Levenshtein distance) between two strings
#[cfg(feature = "db")]
fn calculate_edit_distance(s1: &str, s2: &str) -> u32 {
    let len1 = s1.chars().count();
    let len2 = s2.chars().count();

    if len1 == 0 {
        return len2 as u32;
    }
    if len2 == 0 {
        return len1 as u32;
    }

    let s1_chars: Vec<char> = s1.chars().collect();
    let s2_chars: Vec<char> = s2.chars().collect();

    let mut matrix = vec![vec![0; len2 + 1]; len1 + 1];

    // Initialize first row and column
    for (i, row) in matrix.iter_mut().enumerate().take(len1 + 1) {
        row[0] = i;
    }
    for j in 0..=len2 {
        matrix[0][j] = j;
    }

    // Fill the matrix
    for i in 1..=len1 {
        for j in 1..=len2 {
            let cost = if s1_chars[i - 1] == s2_chars[j - 1] {
                0
            } else {
                1
            };
            matrix[i][j] = std::cmp::min(
                std::cmp::min(
                    matrix[i - 1][j] + 1, // deletion
                    matrix[i][j - 1] + 1, // insertion
                ),
                matrix[i - 1][j - 1] + cost, // substitution
            );
        }
    }

    matrix[len1][len2] as u32
}

#[cfg(not(feature = "db"))]
pub struct SqliteSearchState;

#[cfg(not(feature = "db"))]
impl SqliteSearchState {
    pub fn new(_db: ()) -> crate::errors::AtomicResult<Self> {
        Err("Search requires the 'db' feature".into())
    }
}
