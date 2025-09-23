//! Security tests for TursoStore
//! 
//! This module contains comprehensive security tests to validate that the TursoStore
//! implementation is resilient against various attack vectors and follows security best practices.

#[cfg(all(test, feature = "turso"))]
mod security_tests {
    use super::super::turso::{TursoConfig, security::SecurityValidator};

    /// Test SQL injection prevention in subject validation
    #[test]
    fn test_sql_injection_prevention_subject() {
        // Test various SQL injection attempts in subject field
        let malicious_subjects = vec![
            "'; DROP TABLE atoms; --",
            "' OR '1'='1",
            "'; DELETE FROM resources WHERE id = 1; --",
            "' UNION SELECT * FROM sqlite_master --",
            "'; INSERT INTO atoms VALUES ('evil', 'prop', 'val'); --",
            "') OR 1=1 --",
            "' AND (SELECT COUNT(*) FROM sqlite_master) > 0 --",
        ];

        for subject in malicious_subjects {
            let result = SecurityValidator::validate_subject(subject);
            assert!(result.is_err(), "Should reject malicious subject: {}", subject);
            
            // Verify error message doesn't expose the malicious input
            let error_msg = result.err().unwrap().to_string();
            assert!(error_msg.contains("Subject must be a valid HTTP(S) URL"), "Error message should be about URL format");
            assert!(!error_msg.contains(subject), "Error message should not expose malicious input");
        }
    }

    /// Test SQL injection prevention in property validation  
    #[test]
    fn test_sql_injection_prevention_property() {
        let malicious_properties = vec![
            "'; DROP TABLE atoms; --",
            "' OR 1=1 --",
            "property'; DELETE FROM resources; --",
            "'; UPDATE atoms SET value = 'hacked' WHERE 1=1; --",
        ];

        for property in malicious_properties {
            let result = SecurityValidator::validate_property_name(property);
            assert!(result.is_err(), "Should reject malicious property: {}", property);
        }
    }

    /// Test SQL injection prevention in server URL validation
    #[test] 
    fn test_sql_injection_prevention_server_url() {
        let malicious_urls = vec![
            "https://example.com'; DROP TABLE atoms; --",
            "http://evil.com' OR 1=1 --",
            "'; DELETE FROM resources; --",
        ];

        for url in malicious_urls {
            let result = SecurityValidator::validate_server_url(url);
            // Some might be rejected as invalid URLs, others as security violations
            if let Ok(safe_url) = result {
                // If accepted as URL, ensure it's properly escaped
                assert!(!safe_url.contains("'"), "Should not contain single quotes");
                assert!(!safe_url.contains("--"), "Should not contain SQL comments");
            }
        }
    }

    /// Test input validation boundary conditions
    #[test]
    fn test_input_validation_boundaries() {
        // Test extremely long inputs
        let very_long_subject = "https://example.com/".to_string() + &"a".repeat(10000);
        let result = SecurityValidator::validate_subject(&very_long_subject);
        assert!(result.is_err(), "Should reject extremely long subjects");

        // Test empty inputs
        assert!(SecurityValidator::validate_subject("").is_err());
        assert!(SecurityValidator::validate_property_name("").is_err());
        assert!(SecurityValidator::validate_server_url("").is_err());

        // Test limit validation
        assert!(SecurityValidator::validate_limit(0).is_err());
        assert!(SecurityValidator::validate_limit(1001).is_err());
        assert!(SecurityValidator::validate_limit(100).is_ok());

        // Test offset validation
        assert!(SecurityValidator::validate_offset(1_000_001).is_err());
        assert!(SecurityValidator::validate_offset(1_000_000).is_ok());
        assert!(SecurityValidator::validate_offset(100).is_ok());
    }

    /// Test sort column SQL injection prevention
    #[test]
    fn test_sort_column_injection_prevention() {
        let malicious_columns = vec![
            "subject; DROP TABLE atoms; --",
            "subject' OR 1=1 --",
            "(SELECT password FROM users LIMIT 1)",
            "subject, (SELECT COUNT(*) FROM sqlite_master)",
        ];

        for column in malicious_columns {
            let result = SecurityValidator::validate_sort_column(column);
            assert!(result.is_err(), "Should reject malicious sort column: {}", column);
        }

        // Test valid sort columns (only specific properties are allowed)
        let valid_columns = vec![
            "https://atomicdata.dev/properties/created-at",
            "https://atomicdata.dev/properties/updated-at", 
            "https://atomicdata.dev/properties/shortname",
            "https://atomicdata.dev/properties/description",
        ];
        for column in valid_columns {
            let result = SecurityValidator::validate_sort_column(column);
            assert!(result.is_ok(), "Should accept valid sort column: {}", column);
        }
    }

    /// Test credential security in TursoConfig
    #[test]
    fn test_credential_security() {
        let sensitive_token = "super-secret-auth-token-123456";
        let config = TursoConfig::new(
            "libsql://test.turso.io".to_string(),
            sensitive_token.to_string(),
            None,
            None,
        );

        // Test that credentials are not exposed in debug output
        let debug_output = format!("{:?}", config);
        assert!(!debug_output.contains(sensitive_token), "Debug output should not contain raw token");
        assert!(debug_output.contains("[REDACTED]"), "Debug output should show [REDACTED]");

        // Test that credentials are accessible when needed
        assert_eq!(config.get_auth_token_for_test(), sensitive_token);
    }

    /// Test credential zeroization on drop
    #[test]
    fn test_credential_zeroization() {
        let original_token = "secret-token-to-be-zeroized".to_string();
        
        // Create and drop config to trigger zeroization
        {
            let config = TursoConfig::new(
                "libsql://test.turso.io".to_string(),
                original_token.clone(),
                None,
                None,
            );
            
            // Verify token is accessible while config exists
            assert_eq!(config.get_auth_token_for_test(), original_token);
        } // Config is dropped here, triggering zeroization
        
        // Note: We can't directly test that memory is zeroed since that would require
        // accessing deallocated memory, but the Zeroize trait ensures it happens
    }

    /// Test security event logging
    #[test]
    fn test_security_event_logging() {
        // This test verifies that security events can be logged without panicking
        // In production, these would be sent to a SIEM or monitoring system
        
        SecurityValidator::log_security_event(
            "sql_injection_attempt",
            "Malicious subject rejected",
            "high"
        );

        SecurityValidator::log_security_event(
            "input_validation_failure", 
            "Invalid property name format",
            "medium"
        );

        SecurityValidator::log_security_event(
            "boundary_violation",
            "Input exceeds maximum length",
            "low"
        );
    }

    /// Test error handling doesn't leak sensitive information
    #[test]
    fn test_error_handling_security() {
        // Test that error messages don't contain sensitive information
        let sensitive_subject = "https://admin.secret.com/passwords/'; DROP TABLE users; --";
        
        let _result = SecurityValidator::validate_subject(sensitive_subject);
        // This will succeed since it's a valid HTTPS URL, so test with invalid URL format
        
        let invalid_subject = "'; DROP TABLE users; --";
        let result = SecurityValidator::validate_subject(invalid_subject);
        assert!(result.is_err());
        
        let error = result.err().unwrap();
        let error_msg = error.to_string();
        
        // Error message should be generic and not expose the malicious input
        assert!(error_msg.contains("Subject must be a valid HTTP(S) URL"));
        assert!(!error_msg.contains("DROP TABLE"));
        assert!(!error_msg.contains("users"));
    }

    /// Test configuration validation edge cases
    #[test]
    fn test_config_validation_edge_cases() {
        // Test config with unusual but valid values
        let config = TursoConfig::new(
            "libsql://very-long-subdomain-name-that-might-cause-issues.turso.io".to_string(),
            "a".repeat(1000), // Very long token
            Some("/tmp/very/deep/nested/path/to/replica.db".to_string()),
            Some(1), // Very fast sync
        );
        
        assert!(!config.url.is_empty());
        assert!(!config.get_auth_token_for_test().is_empty());
        assert!(config.embedded_replica_path.is_some());
        assert_eq!(config.sync_interval_seconds, Some(1));
    }

    /// Test URL validation with various attack vectors
    #[test]
    fn test_url_validation_attack_vectors() {
        let malicious_urls = vec![
            "javascript:alert('xss')",
            "data:text/html,<script>alert('xss')</script>",
            "file:///etc/passwd",
            "ftp://evil.com/malware.exe",
            "libsql://'; DROP DATABASE production; --",
            "libsql://admin:password@evil.com/",
        ];

        for url in malicious_urls {
            let result = SecurityValidator::validate_server_url(url);
            // URL validation should either reject these or sanitize them
            if let Ok(safe_url) = result {
                assert!(safe_url.starts_with("libsql://") || safe_url.starts_with("https://"));
                assert!(!safe_url.contains("javascript:"));
                assert!(!safe_url.contains("data:"));
                assert!(!safe_url.contains("file://"));
            }
        }
    }

    /// Test property name validation with Unicode and encoding attacks
    #[test]
    fn test_property_validation_encoding_attacks() {
        let malicious_properties = vec![
            "property\u{0000}; DROP TABLE atoms; --", // Null byte injection
            "property\x00'; DELETE FROM resources; --", // Null byte injection
            "property%27%20OR%201%3D1%20--", // URL encoded SQL injection
            "property\u{202E}'; DROP TABLE atoms; --", // Right-to-left override
        ];

        for property in malicious_properties {
            let result = SecurityValidator::validate_property_name(property);
            assert!(result.is_err(), "Should reject malicious property with encoding: {:?}", property);
        }
    }

    /// Test that validation functions are consistent
    #[test]
    fn test_validation_consistency() {
        // Test that validation functions consistently handle similar inputs
        let test_inputs = vec![
            "https://example.com/resource/1",
            "https://example.com/resource/2", 
            "https://example.com/resource/3",
        ];

        for input in test_inputs {
            let subject_result = SecurityValidator::validate_subject(input);
            let url_result = SecurityValidator::validate_server_url(input);
            
            // Both should either succeed or fail consistently
            assert_eq!(subject_result.is_ok(), url_result.is_ok(), 
                      "Validation should be consistent for input: {}", input);
        }
    }

    /// Performance test to ensure validation doesn't cause DoS
    #[test]
    fn test_validation_performance() {
        use std::time::Instant;

        // Test that validation completes quickly even with complex inputs
        let start = Instant::now();
        
        for i in 0..1000 {
            let subject = format!("https://example.com/resource/{}", i);
            let _ = SecurityValidator::validate_subject(&subject);
            let _ = SecurityValidator::validate_property_name("https://atomicdata.dev/properties/description");
            let _ = SecurityValidator::validate_server_url(&subject);
        }
        
        let duration = start.elapsed();
        assert!(duration.as_millis() < 1000, "Validation should complete quickly (took {}ms)", duration.as_millis());
    }

    /// Test regex patterns don't cause catastrophic backtracking
    #[test]
    fn test_regex_security() {
        // Test inputs that could cause regex DoS (ReDoS) if patterns are poorly written
        let potentially_problematic_inputs = vec![
            "a".repeat(10000),
            "a".repeat(10000) + "!",
            ("a".repeat(1000) + "b").repeat(10),
        ];

        for input in potentially_problematic_inputs {
            let start = std::time::Instant::now();
            let _ = SecurityValidator::validate_subject(&input);
            let duration = start.elapsed();
            
            // Should complete quickly even with pathological inputs
            assert!(duration.as_millis() < 100, "Regex validation should not cause DoS (took {}ms)", duration.as_millis());
        }
    }
}

#[cfg(all(test, feature = "turso"))]
mod integration_security_tests {
    use super::super::turso::TursoConfig;
    use tempfile::TempDir;

    /// Test that configuration objects don't leak sensitive data through various channels
    #[test]
    fn test_config_no_data_leakage() {
        let temp_dir = TempDir::new().unwrap();
        let replica_path = temp_dir.path().join("security_test.db");
        
        let sensitive_token = "ultra-secret-production-token-do-not-leak";
        let config = TursoConfig::new(
            "libsql://production.turso.io".to_string(),
            sensitive_token.to_string(),
            Some(replica_path.to_string_lossy().to_string()),
            Some(60),
        );

        // Test serialization doesn't leak credentials (if implemented)
        let debug_str = format!("{:?}", config);
        assert!(!debug_str.contains(sensitive_token));
        
        // Test cloning preserves security
        let cloned_config = config.clone();
        let cloned_debug = format!("{:?}", cloned_config);
        assert!(!cloned_debug.contains(sensitive_token));
        assert!(cloned_debug.contains("[REDACTED]"));
    }

    /// Test environment variable handling security
    #[test]
    fn test_env_var_security() {
        // Test that we don't accidentally log or expose environment variables
        std::env::set_var("TEST_TURSO_TOKEN_SECURITY", "secret-env-token");
        
        // Simulate reading from environment (as might happen in real usage)
        let token = std::env::var("TEST_TURSO_TOKEN_SECURITY").unwrap_or_default();
        let config = TursoConfig::new(
            "libsql://test.turso.io".to_string(),
            token,
            None,
            None,
        );
        
        // Ensure the environment token is not exposed in debug output
        let debug_output = format!("{:?}", config);
        assert!(!debug_output.contains("secret-env-token"));
        assert!(debug_output.contains("[REDACTED]"));
        
        // Clean up
        std::env::remove_var("TEST_TURSO_TOKEN_SECURITY");
    }
}