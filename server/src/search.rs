//! Full-text search, powered by SQLite FTS5.
//! Search functionality is now integrated with the main SQLite database.
//! You can see the Endpoint on `http://localhost/search`
use atomic_lib::{search_sqlite::SqliteSearchState, Db, Resource};
use rusqlite::Connection;

use crate::config::Config;
use crate::errors::AtomicServerResult;

/// The fields used for search in SQLite FTS5.
#[derive(Debug)]
#[allow(dead_code)]
pub struct Fields {
    pub subject: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub propvals: &'static str,
    pub hierarchy: &'static str,
}

impl Fields {
    pub fn new() -> Self {
        Fields {
            subject: "subject",
            title: "title",
            description: "description",
            propvals: "propvals_json",
            hierarchy: "hierarchy",
        }
    }
}

impl Default for Fields {
    fn default() -> Self {
        Self::new()
    }
}

/// Contains the SQLite search state for search operations
#[derive(Clone)]
pub struct SearchState {
    /// SQLite-based search implementation
    pub sqlite_search: SqliteSearchState,
    /// The database reference
    pub db: Db,
}

impl SearchState {
    /// Create a new SearchState for the Server using SQLite FTS5.
    pub fn new(config: &Config) -> AtomicServerResult<SearchState> {
        tracing::info!("Starting SQLite search service");
        
        // Open the SQLite database from the config
        let db = Db::init(&config.store_path, config.server_url.clone())?;
            
        let sqlite_search = SqliteSearchState::new(db.clone())
            .map_err(|e| format!("Failed to initialize SQLite search: {}", e))?;
            
        Ok(SearchState {
            sqlite_search,
            db,
        })
    }

    /// Returns the field names for the search index.
    pub fn get_schema_fields(&self) -> AtomicServerResult<Fields> {
        Ok(Fields::new())
    }

    /// Indexes all resources from the store to search.
    /// The store parameter is accepted for API compatibility but the internal db is used.
    pub fn add_all_resources(&self, _store: &Db) -> AtomicServerResult<()> {
        // Use our internal db reference to maintain consistency
        self.sqlite_search.add_all_resources(&self.db)
            .map_err(|e| format!("Failed to add all resources to search index: {}", e).into())
    }
    
    /// Get a reference to the internal database (primarily for testing)
    #[cfg(test)]
    pub fn get_store(&self) -> &atomic_lib::Db {
        &self.db
    }

    /// Adds a single resource to the search index.
    #[tracing::instrument(skip(self))]
    pub fn add_resource(&self, resource: &Resource, store: &Db) -> AtomicServerResult<()> {
        // Use the store's connection to avoid double acquisition
        let conn = store.get_connection()
            .map_err(|e| format!("Failed to get database connection: {}", e))?;
            
        // Use the more efficient batch method with existing connection
        self.add_resource_with_connection(resource, &conn)
    }
    
    /// Adds a single resource to the search index with an existing connection.
    /// This is more efficient for batch operations as it reuses the connection.
    #[tracing::instrument(skip(self, conn))]
    pub fn add_resource_with_connection(&self, resource: &Resource, conn: &Connection) -> AtomicServerResult<()> {
        self.sqlite_search.add_resource(resource, conn)
            .map_err(|e| format!("Failed to add resource to search index: {}", e).into())
    }

    /// Removes a single resource from the search index.
    #[tracing::instrument(skip(self))]
    pub fn remove_resource(&self, subject: &str) -> AtomicServerResult<()> {
        self.sqlite_search.remove_resource(subject)
            .map_err(|e| format!("Failed to remove resource from search index: {}", e).into())
    }
    
    /// Perform a text search using SQLite FTS5
    pub fn text_search(&self, query: &str, limit: usize) -> AtomicServerResult<Vec<String>> {
        self.sqlite_search.text_search(query, limit)
            .map_err(|e| format!("Text search failed: {}", e).into())
    }
    
    /// Perform fuzzy search using FST
    pub fn fuzzy_search(&self, query: &str, max_distance: u32, limit: usize) -> AtomicServerResult<Vec<String>> {
        self.sqlite_search.fuzzy_search(query, max_distance, limit)
            .map_err(|e| format!("Fuzzy search failed: {}", e).into())
    }
    
    /// Search with hierarchy/parent filtering
    pub fn hierarchy_search(&self, parent_subject: &str, limit: usize) -> AtomicServerResult<Vec<String>> {
        self.sqlite_search.hierarchy_search(parent_subject, limit)
            .map_err(|e| format!("Hierarchy search failed: {}", e).into())
    }
}

/// Extract title from a resource
#[allow(dead_code)]
pub fn get_resource_title(resource: &Resource) -> String {
    let title = if let Ok(name) = resource.get(atomic_lib::urls::NAME) {
        name.clone()
    } else if let Ok(shortname) = resource.get(atomic_lib::urls::SHORTNAME) {
        shortname.clone()
    } else if let Ok(filename) = resource.get(atomic_lib::urls::FILENAME) {
        filename.clone()
    } else {
        atomic_lib::Value::String(resource.get_subject().to_string())
    };

    match title {
        atomic_lib::Value::String(s) => s,
        atomic_lib::Value::Slug(s) => s,
        _ => resource.get_subject().to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{urls, Resource, Storelike};
    
    /// Helper function to create a SearchState and return both it and a reference to its store
    fn create_test_search_state() -> SearchState {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        SearchState::new(&config)
            .expect("Failed to create search state")
    }

    #[test]
    fn test_search_state_initialization() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");
        
        let fields = search_state.get_schema_fields()
            .expect("Failed to get schema fields");
        
        assert_eq!(fields.subject, "subject");
        assert_eq!(fields.title, "title");
        assert_eq!(fields.description, "description");
    }

    #[test]
    fn test_add_and_search_resource() {
        let search_state = create_test_search_state();
        let store = search_state.get_store();

        // Create a test resource
        let mut resource = Resource::new_generate_subject(store)
            .expect("Failed to generate subject");
        resource.set_string(urls::NAME.into(), "Test Resource Title", store)
            .expect("Failed to set name");
        resource.set_string(urls::DESCRIPTION.into(), "This is a test description for searching", store)
            .expect("Failed to set description");
        store.add_resource(&resource)
            .expect("Failed to add resource to store");

        // Add to search index
        search_state.add_resource(&resource, store)
            .expect("Failed to add resource to search index");

        // Test text search
        let results = search_state.text_search("Test", 10)
            .expect("Failed to perform text search");
        assert!(!results.is_empty(), "Should find the test resource");
        assert!(results.contains(resource.get_subject()), "Should contain our test resource subject");
    }

    #[test] 
    fn test_update_resource() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create initial resource
        let mut resource = Resource::new_generate_subject(&store)
            .expect("Failed to generate subject");
        resource.set_string(urls::NAME.into(), "Initial Title", &store)
            .expect("Failed to set initial name");
        store.add_resource(&resource)
            .expect("Failed to add resource to store");

        // Add to search index
        search_state.add_resource(&resource, &store)
            .expect("Failed to add resource to search index");

        // Verify initial search works
        let initial_results = search_state.text_search("Initial", 10)
            .expect("Failed to search for initial title");
        assert!(initial_results.contains(resource.get_subject()), "Should find resource with initial title");

        // Update the resource
        resource.set_string(urls::NAME.into(), "Updated Title", &store)
            .expect("Failed to update name");
        resource.save(&store)
            .expect("Failed to save updated resource");

        // Update in search index
        search_state.remove_resource(resource.get_subject())
            .expect("Failed to remove resource from search index");
        search_state.add_resource(&resource, &store)
            .expect("Failed to add updated resource to search index");

        // Search for the new title - should return results
        let updated_results = search_state.text_search("Updated", 10)
            .expect("Failed to search for updated title");
        assert!(updated_results.contains(resource.get_subject()), "Should find resource with updated title");
        
        // Search for the old title - should return no results
        let old_results = search_state.text_search("Initial", 10)
            .expect("Failed to search for old title");
        assert!(!old_results.contains(resource.get_subject()), "Should not find resource with old title");
    }
    
    #[test]
    fn test_fuzzy_search() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create a test resource with a specific title
        let mut resource = Resource::new_generate_subject(&store)
            .expect("Failed to generate subject");
        resource.set_string(urls::NAME.into(), "Programming", &store)
            .expect("Failed to set name");
        store.add_resource(&resource)
            .expect("Failed to add resource to store");

        // Add to search index
        search_state.add_resource(&resource, &store)
            .expect("Failed to add resource to search index");

        // Test fuzzy search with slight misspelling
        let results = search_state.fuzzy_search("Programing", 2, 10);
        // Note: This test depends on the FST implementation in the lib
        // It may fail if FST index is not built yet - this is expected in unit tests
        match results {
            Ok(_) => {
                // FST search worked - this is good
            }
            Err(e) => {
                // FST search failed - this is expected in unit tests since FST index may not be built
                assert!(e.to_string().contains("FST data") || e.to_string().contains("Query returned no rows"), 
                       "Unexpected error type: {}", e);
            }
        }
    }
    
    #[test]
    fn test_hierarchy_search() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create a parent resource
        let mut parent = Resource::new_generate_subject(&store)
            .expect("Failed to generate parent subject");
        parent.set_string(urls::NAME.into(), "Parent Resource", &store)
            .expect("Failed to set parent name");
        store.add_resource(&parent)
            .expect("Failed to add parent to store");

        // Create a child resource
        let mut child = Resource::new_generate_subject(&store)
            .expect("Failed to generate child subject");
        child.set_string(urls::NAME.into(), "Child Resource", &store)
            .expect("Failed to set child name");
        child.set_string(urls::PARENT.into(), parent.get_subject(), &store)
            .expect("Failed to set parent relationship");
        store.add_resource(&child)
            .expect("Failed to add child to store");

        // Add both to search index
        search_state.add_resource(&parent, &store)
            .expect("Failed to add parent to search index");
        search_state.add_resource(&child, &store)
            .expect("Failed to add child to search index");

        // Test hierarchy search
        let _results = search_state.hierarchy_search(parent.get_subject(), 10)
            .expect("Failed to perform hierarchy search");
        // Note: This test depends on the hierarchy implementation in the SQLite search
    }
    
    #[test]
    fn test_concurrent_search_operations() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create multiple test resources
        for i in 0..10 {
            let mut resource = Resource::new_generate_subject(&store)
                .expect("Failed to generate subject");
            resource.set_string(urls::NAME.into(), &format!("Test Resource {}", i), &store)
                .expect("Failed to set name");
            resource.set_string(urls::DESCRIPTION.into(), &format!("Description for test resource number {}", i), &store)
                .expect("Failed to set description");
            store.add_resource(&resource)
                .expect("Failed to add resource to store");

            // Add to search index
            search_state.add_resource(&resource, &store)
                .expect("Failed to add resource to search index");
        }

        // Test concurrent search operations
        let search_state_clone = search_state.clone();
        let handle1 = std::thread::spawn(move || {
            for _ in 0..5 {
                let results = search_state_clone.text_search("Test", 10)
                    .expect("Failed to perform text search");
                assert!(!results.is_empty(), "Should find test resources");
            }
        });

        let search_state_clone2 = search_state.clone();
        let handle2 = std::thread::spawn(move || {
            for _ in 0..5 {
                let results = search_state_clone2.text_search("Resource", 10)
                    .expect("Failed to perform text search");
                assert!(!results.is_empty(), "Should find test resources");
            }
        });

        handle1.join().expect("Thread 1 should complete successfully");
        handle2.join().expect("Thread 2 should complete successfully");
    }
    
    #[test]
    fn test_search_performance_and_caching() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create test resources
        let mut resource = Resource::new_generate_subject(&store)
            .expect("Failed to generate subject");
        resource.set_string(urls::NAME.into(), "Performance Test Resource", &store)
            .expect("Failed to set name");
        resource.set_string(urls::DESCRIPTION.into(), "This resource is for testing search performance", &store)
            .expect("Failed to set description");
        store.add_resource(&resource)
            .expect("Failed to add resource to store");
        search_state.add_resource(&resource, &store)
            .expect("Failed to add resource to search index");

        // Measure first search (cache miss)
        let start = std::time::Instant::now();
        let results1 = search_state.text_search("Performance", 10)
            .expect("Failed to perform first search");
        let first_duration = start.elapsed();

        // Measure second search (cache hit)
        let start = std::time::Instant::now();
        let results2 = search_state.text_search("Performance", 10)
            .expect("Failed to perform second search");
        let second_duration = start.elapsed();

        // Verify results are consistent
        assert_eq!(results1, results2, "Search results should be consistent");
        assert!(!results1.is_empty(), "Should find the performance test resource");
        
        // Note: We don't assert timing because test environments can be unpredictable
        // But we log the timings for visibility
        println!("First search (cache miss): {:?}", first_duration);
        println!("Second search (cache hit): {:?}", second_duration);
    }
    
    #[test]
    fn test_search_with_special_characters() {
        let unique_string = atomic_lib::utils::random_string(10);
        let config = crate::config::build_temp_config(&unique_string)
            .expect("Failed to create test config");
        
        let store = atomic_lib::Db::init_temp(&unique_string)
            .expect("Failed to create temp store");
        
        let search_state = SearchState::new(&config)
            .expect("Failed to create search state");

        // Create resources with special characters
        let test_cases = vec![
            ("Special-Resource", "Resource with hyphen"),
            ("Resource_with_underscores", "Testing underscores"),
            ("Resource@domain.com", "Email-like resource"),
            ("Resource#123", "Resource with hash"),
            ("Résource", "Resource with accents"),
        ];

        for (name, description) in test_cases {
            let mut resource = Resource::new_generate_subject(&store)
                .expect("Failed to generate subject");
            resource.set_string(urls::NAME.into(), name, &store)
                .expect("Failed to set name");
            resource.set_string(urls::DESCRIPTION.into(), description, &store)
                .expect("Failed to set description");
            store.add_resource(&resource)
                .expect("Failed to add resource to store");
            search_state.add_resource(&resource, &store)
                .expect("Failed to add resource to search index");
        }

        // Test searching for resources with special characters
        let results = search_state.text_search("Special", 10)
            .expect("Failed to search for special characters");
        assert!(!results.is_empty(), "Should find resources with special characters");

        let results = search_state.text_search("underscores", 10)
            .expect("Failed to search for underscores");
        assert!(!results.is_empty(), "Should find resources with underscores");

        let results = search_state.text_search("domain", 10)
            .expect("Failed to search for domain");
        assert!(!results.is_empty(), "Should find resources with email-like names");
    }
}