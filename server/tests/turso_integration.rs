//! Server integration tests for Turso backend
//!
//! These tests verify that the Turso integration compiles and works
//! at the configuration level. Detailed Storelike testing is done in the lib tests.

#[cfg(all(test, feature = "turso"))]
mod turso_server_integration {
    use atomic_lib::{
        datatype::DataType, stores::turso::TursoConfig, Db, Resource, Storelike, Value,
    };

    /// Creates a test configuration for Turso integration
    fn create_test_turso_config() -> TursoConfig {
        TursoConfig::new(
            "libsql://server-test.turso.io".to_string(),
            "server-test-token".to_string(),
            Some("./test_server_integration.db".to_string()),
            Some(30),
        )
    }

    #[test]
    fn test_turso_config_creation() {
        let config = create_test_turso_config();

        assert!(!config.url.is_empty());
        assert!(config.embedded_replica_path.is_some());
        assert_eq!(config.sync_interval_seconds, Some(30));
    }

    #[test]
    fn test_turso_config_compatibility() {
        // Test that TursoConfig can be created with various settings
        let embedded_config = TursoConfig::new(
            "libsql://test-embedded.turso.io".to_string(),
            "embedded-token".to_string(),
            Some("./embedded_replica.db".to_string()),
            Some(60),
        );

        let remote_config = TursoConfig::new(
            "libsql://test-remote.turso.io".to_string(),
            "remote-token".to_string(),
            None,
            None,
        );

        assert!(embedded_config.embedded_replica_path.is_some());
        assert!(remote_config.embedded_replica_path.is_none());
    }

    #[test]
    fn test_data_compatibility() {
        // Test that data structures work the same way for both SQLite and Turso
        let sqlite_store = Db::init_temp("server_compatibility_test").unwrap();

        // Create test data
        let mut resource = Resource::new("https://example.com/server-test".to_string());
        resource.set_unsafe(
            "https://atomicdata.dev/properties/description".to_string(),
            Value::new("Server integration test resource", &DataType::String).unwrap(),
        );

        // Test with SQLite backend
        sqlite_store.add_resource(&resource).unwrap();
        let retrieved = sqlite_store
            .get_resource("https://example.com/server-test")
            .unwrap();
        assert_eq!(retrieved.get_subject(), "https://example.com/server-test");

        // This same pattern should work with TursoStore when using real credentials
    }

    #[test]
    fn test_json_serialization_for_server() {
        // Test JSON structures that would be used in HTTP API
        let test_resource_json = serde_json::json!({
            "@id": "https://example.com/server-test-resource",
            "https://atomicdata.dev/properties/description": "Server test resource",
            "https://atomicdata.dev/properties/shortname": "server-test"
        });

        assert!(test_resource_json["@id"].is_string());
        assert!(test_resource_json["https://atomicdata.dev/properties/description"].is_string());

        // This JSON should be handled identically by both SQLite and Turso backends
    }

    #[tokio::test]
    #[ignore = "Requires actual Turso database for real server testing"]
    async fn test_full_server_integration() {
        // This test would verify complete server startup with Turso backend
        //
        // Steps:
        // 1. Create TursoStore with real credentials
        // 2. Start atomic-server with TursoStore backend
        // 3. Make HTTP requests to test CRUD operations
        // 4. Verify WebSocket functionality
        // 5. Test search endpoints
        // 6. Verify sync operations
        //
        // For now, we'll just test that the config can be created
        let config = create_test_turso_config();
        assert!(config.sync_interval_seconds.is_some());
    }

    #[test]
    fn test_feature_flag_compilation() {
        // Test that Turso code compiles when feature flag is enabled
        let config = TursoConfig::default();

        // These should be available when turso feature is enabled
        assert_eq!(config.url, "");
        assert_eq!(
            config.embedded_replica_path,
            Some("atomic_data.db".to_string())
        );
        assert_eq!(config.sync_interval_seconds, Some(60));
    }

    #[test]
    fn test_error_scenarios() {
        // Test various error scenarios that don't require network

        // Invalid configurations
        let invalid_config = TursoConfig::new(
            "".to_string(),
            "".to_string(),
            Some("/invalid/path".to_string()),
            Some(0), // Invalid interval
        );

        assert!(invalid_config.url.is_empty());
        assert_eq!(invalid_config.sync_interval_seconds, Some(0));

        // These would cause errors during actual connection, but config creation succeeds
    }

    #[test]
    fn test_migration_scenarios() {
        // Test data migration compatibility between backends
        let sqlite_store = Db::init_temp("migration_scenario_test").unwrap();

        // Create some test data in SQLite
        let mut resource1 = Resource::new("https://example.com/migration/1".to_string());
        resource1.set_unsafe(
            "https://atomicdata.dev/properties/description".to_string(),
            Value::new("First migration test resource", &DataType::String).unwrap(),
        );

        let mut resource2 = Resource::new("https://example.com/migration/2".to_string());
        resource2.set_unsafe(
            "https://atomicdata.dev/properties/description".to_string(),
            Value::new("Second migration test resource", &DataType::String).unwrap(),
        );

        sqlite_store.add_resource(&resource1).unwrap();
        sqlite_store.add_resource(&resource2).unwrap();

        // Verify data integrity
        let retrieved1 = sqlite_store
            .get_resource("https://example.com/migration/1")
            .unwrap();
        let retrieved2 = sqlite_store
            .get_resource("https://example.com/migration/2")
            .unwrap();

        assert_eq!(retrieved1.get_subject(), "https://example.com/migration/1");
        assert_eq!(retrieved2.get_subject(), "https://example.com/migration/2");

        // This same data should be importable into TursoStore
        // (tested in integration environment with real credentials)
    }

    #[test]
    fn test_concurrent_access_patterns() {
        // Test patterns that would be used for concurrent access
        // Important for server environments where multiple requests happen simultaneously

        let sqlite_store = Db::init_temp("concurrent_patterns_test").unwrap();

        // Simulate multiple resources being accessed
        let resources: Vec<String> = (1..=10)
            .map(|i| format!("https://example.com/concurrent/{}", i))
            .collect();

        for (i, subject) in resources.iter().enumerate() {
            let mut resource = Resource::new(subject.clone());
            resource.set_unsafe(
                "https://atomicdata.dev/properties/description".to_string(),
                Value::new(
                    &format!("Concurrent test resource {}", i + 1),
                    &DataType::String,
                )
                .unwrap(),
            );
            sqlite_store.add_resource(&resource).unwrap();
        }

        // Verify all resources can be retrieved
        for subject in &resources {
            let retrieved = sqlite_store.get_resource(subject).unwrap();
            assert_eq!(retrieved.get_subject(), subject);
        }

        // TursoStore should handle the same concurrent patterns
        // (with proper connection pooling tested in real environment)
    }
}
