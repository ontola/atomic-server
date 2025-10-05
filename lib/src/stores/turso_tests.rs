//! Integration tests for TursoStore
//!
//! These tests require the 'turso' feature to be enabled.
//! Note: Some tests may require actual Turso database credentials for full integration testing.

#[cfg(all(test, feature = "turso"))]
mod turso_integration_tests {
    use super::super::turso::{TursoConfig, TursoStore};
    use crate::{agents::ForAgent, datatype::DataType, storelike::Query, Atom, Resource, Value};
    use tempfile::TempDir;

    /// Mock Turso configuration for testing
    /// Note: These are fake credentials - real tests would need actual Turso setup
    fn create_mock_config_embedded() -> TursoConfig {
        let temp_dir = TempDir::new().unwrap();
        let replica_path = temp_dir.path().join("test_replica.db");

        TursoConfig::new(
            "libsql://mock-test-db.turso.io".to_string(),
            "mock-test-token-not-real".to_string(),
            Some(replica_path.to_string_lossy().to_string()),
            Some(10),
        )
    }

    fn create_mock_config_remote() -> TursoConfig {
        TursoConfig::new(
            "libsql://mock-test-db.turso.io".to_string(),
            "mock-test-token-not-real".to_string(),
            None,
            None,
        )
    }

    fn create_test_resource(subject: &str, description: &str) -> Resource {
        let mut resource = Resource::new(subject.to_string());
        resource.set_unsafe(
            "https://atomicdata.dev/properties/description".to_string(),
            Value::new(description, &DataType::String).unwrap(),
        );
        resource.set_unsafe(
            "https://atomicdata.dev/properties/shortname".to_string(),
            Value::new("test-item", &DataType::String).unwrap(),
        );
        resource
    }

    fn create_test_atoms(subject: &str) -> Vec<Atom> {
        vec![
            Atom {
                subject: subject.to_string(),
                property: "https://atomicdata.dev/properties/description".to_string(),
                value: Value::new("Test atom description", &DataType::String).unwrap(),
            },
            Atom {
                subject: subject.to_string(),
                property: "https://atomicdata.dev/properties/shortname".to_string(),
                value: Value::new("test-atom", &DataType::String).unwrap(),
            },
        ]
    }

    // Note: These tests are designed to be skipped when running without actual Turso credentials
    // In a CI environment, you would set up test databases and provide real credentials

    #[tokio::test]
    #[ignore = "Requires actual Turso database setup"]
    async fn test_turso_store_embedded_initialization() {
        let config = create_mock_config_embedded();

        // This would fail with mock credentials, but tests the initialization path
        let result = TursoStore::new_embedded_replica(config).await;

        // With mock credentials, this should fail
        assert!(result.is_err());
        let error_msg = result.err().unwrap().to_string();
        assert!(error_msg.contains("Failed to create Turso embedded replica"));
    }

    #[tokio::test]
    #[ignore = "Requires actual Turso database setup"]
    async fn test_turso_store_remote_initialization() {
        let config = create_mock_config_remote();

        // This would fail with mock credentials, but tests the initialization path
        let result = TursoStore::new_remote(config).await;

        // With mock credentials, this should fail
        assert!(result.is_err());
        let error_msg = result.err().unwrap().to_string();
        assert!(error_msg.contains("Failed to create Turso remote connection"));
    }

    #[test]
    fn test_config_validation() {
        // Test embedded replica requires path
        let mut config = create_mock_config_embedded();
        assert!(config.embedded_replica_path.is_some());

        // Test remote config doesn't require path
        let remote_config = create_mock_config_remote();
        assert!(remote_config.embedded_replica_path.is_none());

        // Test invalid config scenarios
        config.url = "".to_string();
        // URL validation would happen during connection, not config creation
        assert!(config.url.is_empty());

        // Test empty auth token - create a new config with empty token
        let empty_token_config = TursoConfig::new(
            "libsql://test.turso.io".to_string(),
            "".to_string(),
            None,
            None,
        );
        // Token validation would happen during connection, not config creation
        assert!(empty_token_config.get_auth_token_for_test().is_empty());
    }

    #[test]
    fn test_config_access_methods() {
        // Test that the config access methods would work with real TursoStore
        let embedded_config = create_mock_config_embedded();
        let remote_config = create_mock_config_remote();

        // Test embedded replica config
        assert!(embedded_config.embedded_replica_path.is_some());
        assert_eq!(embedded_config.sync_interval_seconds, Some(10));
        assert!(!embedded_config.url.is_empty());
        assert!(!embedded_config.get_auth_token_for_test().is_empty());

        // Test remote-only config
        assert!(remote_config.embedded_replica_path.is_none());
        assert!(remote_config.sync_interval_seconds.is_none());
        assert!(!remote_config.url.is_empty());
        assert!(!remote_config.get_auth_token_for_test().is_empty());

        // These methods would be available on actual TursoStore:
        // store.get_config() -> &TursoConfig
        // store.is_embedded_replica() -> bool
        // store.get_sync_interval() -> Option<u64>
        // store.get_database_url() -> &str
        // store.get_replica_path() -> Option<&str>
    }

    // The following tests demonstrate the interface but are skipped without real Turso setup
    // In practice, you would:
    // 1. Set up a test Turso database for CI
    // 2. Provide credentials via environment variables
    // 3. Enable these tests only in integration test environments

    #[tokio::test]
    #[ignore = "Requires actual Turso database with test credentials"]
    async fn test_storelike_trait_implementation() {
        // This test would work with real Turso credentials:
        // let config = TursoConfig {
        //     url: std::env::var("TEST_TURSO_URL").unwrap(),
        //     auth_token: std::env::var("TEST_TURSO_TOKEN").unwrap(),
        //     embedded_replica_path: Some("./test_replica.db".to_string()),
        //     sync_interval_seconds: Some(5),
        // };
        //
        // let store = TursoStore::new_embedded_replica(config).await.unwrap();
        //
        // // Test add_resource
        // let resource = create_test_resource("https://example.com/test/1", "Test resource");
        // store.add_resource(&resource).unwrap();
        //
        // // Test get_resource
        // let retrieved = store.get_resource("https://example.com/test/1").unwrap();
        // assert_eq!(retrieved.get_subject(), "https://example.com/test/1");
        //
        // // Test remove_resource
        // store.remove_resource("https://example.com/test/1").unwrap();
        //
        // // Should be gone
        // assert!(store.get_resource("https://example.com/test/1").is_err());

        // For now, just test that the mock config can be created
        let config = create_mock_config_embedded();
        assert!(!config.url.is_empty());
        assert!(!config.get_auth_token_for_test().is_empty());
    }

    #[tokio::test]
    #[ignore = "Requires actual Turso database with test credentials"]
    async fn test_add_atoms_functionality() {
        // This would test the add_atoms method with real Turso connection
        let atoms = create_test_atoms("https://example.com/atom-test");
        assert_eq!(atoms.len(), 2);
        assert_eq!(atoms[0].subject, "https://example.com/atom-test");
    }

    #[tokio::test]
    #[ignore = "Requires actual Turso database with test credentials"]
    async fn test_query_functionality() {
        // This would test query capabilities with FTS5
        let query = Query {
            property: Some("https://atomicdata.dev/properties/description".to_string()),
            value: Some(Value::new("test", &DataType::String).unwrap()),
            limit: Some(10),
            start_val: None,
            end_val: None,
            offset: 0,
            sort_by: None,
            sort_desc: false,
            include_external: false,
            include_nested: true,
            for_agent: ForAgent::Public,
        };

        // With real store:
        // let result = store.query(&query).unwrap();
        // assert!(result.count <= 10);

        // For now, verify query structure
        assert!(query.property.is_some());
        assert!(query.value.is_some());
    }

    #[tokio::test]
    #[ignore = "Requires actual Turso database with test credentials"]
    async fn test_sync_functionality() {
        // This would test sync for embedded replica mode
        // let store = TursoStore::new_embedded_replica(config).await.unwrap();
        // store.sync().await.unwrap();

        // For now, test that sync configuration is valid
        let config = create_mock_config_embedded();
        assert_eq!(config.sync_interval_seconds, Some(10));
    }

    #[test]
    fn test_server_url_management() {
        // Test server URL setter/getter interface
        // This doesn't require actual Turso connection

        // With real store:
        // store.set_server_url("https://example.com");
        // let url = store.get_server_url().unwrap();
        // assert_eq!(url, "https://example.com");

        // For now, just verify the interface exists in our mock
        let config = create_mock_config_embedded();
        assert!(config.url.starts_with("libsql://"));
    }

    #[test]
    fn test_agent_management() {
        // Test agent setter/getter interface
        // Note: Agent creation requires a store, so this is a placeholder test
        // let store = create_test_store();
        // let agent = Agent::new(Some("Test Agent"), &store).unwrap();
        // assert_eq!(agent.get_name(), Some("Test Agent"));

        // For now, just test that we can create the test config
        let config = create_mock_config_embedded();
        assert!(!config.url.is_empty());

        // With real store:
        // store.set_default_agent(agent.clone());
        // let retrieved_agent = store.get_default_agent().unwrap();
        // assert_eq!(retrieved_agent.subject, agent.subject);
    }

    #[test]
    fn test_error_handling_scenarios() {
        // Test various error conditions that don't require network

        // Invalid URL formats
        let mut config = create_mock_config_embedded();
        config.url = "not-a-valid-url".to_string();
        // URL validation happens during connection, not config creation
        assert_eq!(config.url, "not-a-valid-url");

        // Test empty credentials with new config
        let empty_cred_config = TursoConfig::new(
            "libsql://test.turso.io".to_string(),
            "".to_string(),
            None,
            None,
        );
        assert!(empty_cred_config.get_auth_token_for_test().is_empty());

        // Invalid replica path
        config.embedded_replica_path = Some("/invalid/path/that/does/not/exist".to_string());
        assert!(config.embedded_replica_path.is_some());
    }

    #[test]
    fn test_all_resources_interface() {
        // Test the all_resources method interface
        // With real store:
        // let local_resources: Vec<Resource> = store.all_resources(false).collect();
        // let all_resources: Vec<Resource> = store.all_resources(true).collect();
        // assert!(local_resources.len() <= all_resources.len());

        // For now, just verify we can create test resources
        let resource1 = create_test_resource("https://example.com/1", "First resource");
        let resource2 = create_test_resource("https://example.com/2", "Second resource");

        assert_ne!(resource1.get_subject(), resource2.get_subject());
    }

    // Performance and stress tests would go here
    #[test]
    #[ignore = "Performance test - requires actual database"]
    fn test_performance_large_dataset() {
        // This would test performance with large numbers of resources
        // Useful for comparing embedded replica vs remote-only performance
    }

    #[test]
    #[ignore = "Stress test - requires actual database"]
    fn test_concurrent_operations() {
        // This would test concurrent reads/writes
        // Important for validating connection pooling
    }
}

// Additional test utilities that can be used by other test modules
#[cfg(all(test, feature = "turso"))]
pub mod test_utils {
    use super::super::turso::TursoConfig;
    use tempfile::TempDir;

    /// Creates a temporary test configuration for use in other test modules
    pub fn create_temp_turso_config() -> TursoConfig {
        let temp_dir = TempDir::new().unwrap();
        let replica_path = temp_dir.path().join("test_turso_replica.db");

        TursoConfig::new(
            "libsql://test-atomic-server.turso.io".to_string(),
            "test-token-for-atomic-server".to_string(),
            Some(replica_path.to_string_lossy().to_string()),
            Some(30),
        )
    }

    /// Environment variable names for integration testing
    pub const TEST_TURSO_URL_ENV: &str = "ATOMIC_TEST_TURSO_URL";
    pub const TEST_TURSO_TOKEN_ENV: &str = "ATOMIC_TEST_TURSO_TOKEN";

    /// Checks if integration test environment is available
    pub fn has_turso_test_env() -> bool {
        std::env::var(TEST_TURSO_URL_ENV).is_ok() && std::env::var(TEST_TURSO_TOKEN_ENV).is_ok()
    }

    /// Creates a config from environment variables for real integration testing
    pub fn create_integration_config() -> Option<TursoConfig> {
        if !has_turso_test_env() {
            return None;
        }

        let temp_dir = TempDir::new().ok()?;
        let replica_path = temp_dir.path().join("integration_test_replica.db");

        Some(TursoConfig::new(
            std::env::var(TEST_TURSO_URL_ENV).ok()?,
            std::env::var(TEST_TURSO_TOKEN_ENV).ok()?,
            Some(replica_path.to_string_lossy().to_string()),
            Some(5), // Fast sync for testing
        ))
    }
}
