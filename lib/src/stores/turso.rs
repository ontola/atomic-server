//! Turso (libSQL) implementation of Storelike trait
//!
//! Provides both embedded replica mode (recommended) and remote-only mode.
//! Embedded replica mode offers local SQLite performance with automatic sync to Turso.

#[cfg(feature = "turso")]
use {
    crate::{
        agents::Agent,
        errors::{AtomicError, AtomicResult},
        storelike::{Query, QueryResult, Storelike},
        Resource,
    },
    libsql::{params, Builder, Connection, Database},
    lru::LruCache,
    parking_lot::RwLock,
    secrecy::{ExposeSecret, Secret},
    std::{
        collections::VecDeque,
        num::NonZeroUsize,
        sync::Arc,
        time::{Duration, Instant},
    },
    tokio::sync::Mutex,
    tokio::time,
    tracing::{debug, info},
    zeroize::Zeroize,
};

#[cfg(feature = "turso")]
pub mod security {
    use crate::errors::{AtomicError, AtomicResult};
    use tracing::warn;

    /// Security validator for Turso operations
    pub struct SecurityValidator;

    impl SecurityValidator {
        /// Validate subject URL format and length
        pub fn validate_subject(subject: &str) -> AtomicResult<()> {
            if subject.is_empty() {
                return Err(AtomicError::other_error(
                    "Subject cannot be empty".to_string(),
                ));
            }
            if subject.len() > 2048 {
                return Err(AtomicError::other_error(
                    "Subject too long (max 2048 chars)".to_string(),
                ));
            }
            if !subject.starts_with("http://") && !subject.starts_with("https://") {
                return Err(AtomicError::other_error(
                    "Subject must be a valid HTTP(S) URL".to_string(),
                ));
            }
            Ok(())
        }

        /// Validate and sanitize server URL
        pub fn validate_server_url(url: &str) -> AtomicResult<String> {
            if url.is_empty() {
                return Err(AtomicError::other_error(
                    "Server URL cannot be empty".to_string(),
                ));
            }

            // Basic URL validation - must start with http/https
            if !url.starts_with("http://") && !url.starts_with("https://") {
                return Err(AtomicError::other_error(
                    "Server URL must be HTTP(S)".to_string(),
                ));
            }

            // Check for suspicious patterns
            if url.contains("'") || url.contains("\"") || url.contains(";") || url.contains("--") {
                return Err(AtomicError::other_error(
                    "Server URL contains invalid characters".to_string(),
                ));
            }

            Ok(url.to_string())
        }

        /// Validate property name for JSON extraction
        pub fn validate_property_name(property: &str) -> AtomicResult<()> {
            if property.is_empty() {
                return Err(AtomicError::other_error(
                    "Property name cannot be empty".to_string(),
                ));
            }
            if property.len() > 512 {
                return Err(AtomicError::other_error(
                    "Property name too long (max 512 chars)".to_string(),
                ));
            }

            // Must be a valid URL (property names are URLs in atomic data)
            if !property.starts_with("http://") && !property.starts_with("https://") {
                return Err(AtomicError::other_error(
                    "Property must be a valid HTTP(S) URL".to_string(),
                ));
            }

            // Check for JSON injection patterns
            if property.contains("'")
                || property.contains("\"")
                || property.contains("$")
                || property.contains("..")
                || property.contains("*")
            {
                return Err(AtomicError::other_error(
                    "Property name contains invalid characters".to_string(),
                ));
            }

            Ok(())
        }

        /// Validate sort column against allow-list
        pub fn validate_sort_column(column: &str) -> AtomicResult<String> {
            // Only allow specific, safe property URLs for sorting
            const ALLOWED_SORT_PROPERTIES: &[&str] = &[
                "https://atomicdata.dev/properties/created-at",
                "https://atomicdata.dev/properties/updated-at",
                "https://atomicdata.dev/properties/shortname",
                "https://atomicdata.dev/properties/description",
            ];

            if ALLOWED_SORT_PROPERTIES.contains(&column) {
                Ok(column.to_string())
            } else {
                Err(AtomicError::other_error(format!(
                    "Sort column not allowed: {}",
                    column
                )))
            }
        }

        /// Validate numeric limit parameter
        pub fn validate_limit(limit: usize) -> AtomicResult<usize> {
            if limit == 0 {
                return Err(AtomicError::other_error(
                    "Limit must be greater than 0".to_string(),
                ));
            }
            if limit > 1000 {
                return Err(AtomicError::other_error(
                    "Limit too large (max 1000)".to_string(),
                ));
            }
            Ok(limit)
        }

        /// Validate numeric offset parameter
        pub fn validate_offset(offset: usize) -> AtomicResult<usize> {
            if offset > 1_000_000 {
                return Err(AtomicError::other_error(
                    "Offset too large (max 1,000,000)".to_string(),
                ));
            }
            Ok(offset)
        }

        /// Log security event
        pub fn log_security_event(event_type: &str, details: &str, risk_level: &str) {
            warn!(
                security_event = event_type,
                details = details,
                risk_level = risk_level,
                "Security event detected"
            );
        }
    }
}

#[cfg(feature = "turso")]
#[derive(Clone)]
pub struct TursoConfig {
    /// Turso database URL (e.g., "libsql://your-db.turso.io")
    pub url: String,
    /// Authentication token for Turso (secured)
    auth_token: Secret<String>,
    /// Path for embedded replica database (None for remote-only mode)
    pub embedded_replica_path: Option<String>,
    /// Sync interval in seconds (default: 60)
    pub sync_interval_seconds: Option<u64>,
}

#[cfg(feature = "turso")]
impl TursoConfig {
    /// Create a new TursoConfig with secure token storage
    pub fn new(
        url: String,
        auth_token: String,
        embedded_replica_path: Option<String>,
        sync_interval_seconds: Option<u64>,
    ) -> Self {
        Self {
            url,
            auth_token: Secret::new(auth_token),
            embedded_replica_path,
            sync_interval_seconds,
        }
    }

    /// Get the auth token (only when needed for connection)
    pub(crate) fn get_auth_token(&self) -> &str {
        self.auth_token.expose_secret()
    }

    /// Get the auth token for testing purposes
    #[cfg(test)]
    pub fn get_auth_token_for_test(&self) -> &str {
        self.auth_token.expose_secret()
    }

    /// Set a new auth token
    pub fn set_auth_token(&mut self, token: String) {
        self.auth_token = Secret::new(token);
    }
}

#[cfg(feature = "turso")]
impl std::fmt::Debug for TursoConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TursoConfig")
            .field("url", &self.url)
            .field("auth_token", &"[REDACTED]")
            .field("embedded_replica_path", &self.embedded_replica_path)
            .field("sync_interval_seconds", &self.sync_interval_seconds)
            .finish()
    }
}

#[cfg(feature = "turso")]
impl Drop for TursoConfig {
    fn drop(&mut self) {
        // Zeroize sensitive URL data (may contain credentials)
        self.url.zeroize();
    }
}

#[cfg(feature = "turso")]
impl Default for TursoConfig {
    fn default() -> Self {
        Self {
            url: String::new(),
            auth_token: Secret::new(String::new()),
            embedded_replica_path: Some("atomic_data.db".to_string()),
            sync_interval_seconds: Some(60),
        }
    }
}

#[cfg(feature = "turso")]
struct ConnectionPool {
    /// Database reference for creating new connections
    database: Arc<Database>,
    /// Pool of available connections
    available_connections: Arc<Mutex<VecDeque<Connection>>>,
    /// Maximum number of connections in the pool
    max_connections: usize,
    /// Current number of connections created
    current_connections: Arc<Mutex<usize>>,
}

impl ConnectionPool {
    fn new(database: Arc<Database>, max_connections: usize) -> Self {
        Self {
            database,
            available_connections: Arc::new(Mutex::new(VecDeque::new())),
            max_connections,
            current_connections: Arc::new(Mutex::new(0)),
        }
    }

    async fn acquire(&self) -> AtomicResult<Connection> {
        // First, try to get an available connection
        let conn_to_test = {
            let mut available = self.available_connections.lock().await;
            available.pop_front()
        };

        if let Some(conn) = conn_to_test {
            // Test connection before returning (lock is dropped)
            match self.test_connection(&conn).await {
                Ok(()) => return Ok(conn),
                Err(_) => {
                    // Connection is stale, decrement counter
                    let mut current = self.current_connections.lock().await;
                    *current -= 1;
                }
            }
        }

        // Try to create a new connection if under the limit
        {
            let mut current = self.current_connections.lock().await;
            if *current < self.max_connections {
                match self.database.connect() {
                    Ok(conn) => {
                        *current += 1;
                        debug!("Created new database connection (total: {})", *current);
                        return Ok(conn);
                    }
                    Err(e) => {
                        return Err(AtomicError::other_error(format!(
                            "Failed to create database connection: {}",
                            e
                        )))
                    }
                }
            }
        }

        // Pool is full, wait for a connection to become available
        let timeout = Duration::from_secs(10);
        let start_time = std::time::Instant::now();

        while start_time.elapsed() < timeout {
            let conn_to_test = {
                let mut available = self.available_connections.lock().await;
                available.pop_front()
            };

            if let Some(conn) = conn_to_test {
                match self.test_connection(&conn).await {
                    Ok(()) => return Ok(conn),
                    Err(_) => {
                        // Connection is stale, continue waiting
                        let mut current = self.current_connections.lock().await;
                        *current -= 1;
                    }
                }
            }

            // Wait a bit before retrying
            time::sleep(Duration::from_millis(50)).await;
        }

        Err(AtomicError::other_error(
            "Connection pool timeout - no connections available".to_string(),
        ))
    }

    async fn release(&self, conn: Connection) {
        let mut available = self.available_connections.lock().await;
        available.push_back(conn);
    }

    async fn test_connection(&self, conn: &Connection) -> AtomicResult<()> {
        match conn.execute("SELECT 1", ()).await {
            Ok(_) => Ok(()),
            Err(e) => Err(AtomicError::other_error(format!(
                "Connection test failed: {}",
                e
            ))),
        }
    }
}

impl Clone for ConnectionPool {
    fn clone(&self) -> Self {
        Self {
            database: self.database.clone(),
            available_connections: self.available_connections.clone(),
            max_connections: self.max_connections,
            current_connections: self.current_connections.clone(),
        }
    }
}

#[cfg(feature = "turso")]
#[derive(Clone)]
struct PreparedStatementCache {
    /// LRU cache for prepared statements
    cache: Arc<RwLock<LruCache<String, String>>>,
}

impl PreparedStatementCache {
    fn new(capacity: usize) -> Self {
        Self {
            cache: Arc::new(RwLock::new(LruCache::new(
                NonZeroUsize::new(capacity).unwrap(),
            ))),
        }
    }

    /// Get a cached statement or insert a new one
    fn get_or_insert(&self, query_key: String, sql: String) -> String {
        let mut cache = self.cache.write();
        if let Some(cached_sql) = cache.get(&query_key) {
            cached_sql.clone()
        } else {
            cache.put(query_key, sql.clone());
            sql
        }
    }
}

#[cfg(feature = "turso")]
struct CachedResult {
    resource: Resource,
    created_at: Instant,
    ttl: Duration,
}

impl CachedResult {
    fn new(resource: Resource, ttl: Duration) -> Self {
        Self {
            resource,
            created_at: Instant::now(),
            ttl,
        }
    }

    fn is_expired(&self) -> bool {
        self.created_at.elapsed() > self.ttl
    }
}

#[cfg(feature = "turso")]
#[derive(Clone)]
struct QueryResultCache {
    /// LRU cache for query results with TTL
    cache: Arc<RwLock<LruCache<String, CachedResult>>>,
    /// Default TTL for cached results
    default_ttl: Duration,
}

impl QueryResultCache {
    fn new(capacity: usize, default_ttl: Duration) -> Self {
        Self {
            cache: Arc::new(RwLock::new(LruCache::new(
                NonZeroUsize::new(capacity).unwrap(),
            ))),
            default_ttl,
        }
    }

    /// Get a cached result if it exists and is not expired
    fn get(&self, key: &str) -> Option<Resource> {
        let mut cache = self.cache.write();
        if let Some(cached) = cache.get(key) {
            if !cached.is_expired() {
                return Some(cached.resource.clone());
            } else {
                // Remove expired entry
                cache.pop(key);
            }
        }
        None
    }

    /// Insert a result into the cache
    fn insert(&self, key: String, resource: Resource) {
        let mut cache = self.cache.write();
        let cached_result = CachedResult::new(resource, self.default_ttl);
        cache.put(key, cached_result);
    }

    /// Invalidate a specific key or all keys matching a pattern
    fn invalidate(&self, key: &str) {
        let mut cache = self.cache.write();
        cache.pop(key);
    }

    /// Clear all cached results (used on writes to ensure consistency)
    fn clear_all(&self) {
        let mut cache = self.cache.write();
        cache.clear();
    }
}

#[cfg(feature = "turso")]
#[derive(Clone)]
pub struct TursoStore {
    /// libSQL database instance
    db: Arc<Database>,
    /// Connection pool for efficient connection management
    connection_pool: ConnectionPool,
    /// Configuration
    config: TursoConfig,
    /// Default agent for operations
    default_agent: Arc<RwLock<Option<Agent>>>,
    /// Server URL for this store
    server_url: Arc<RwLock<Option<String>>>,
    /// Whether this is an embedded replica
    is_embedded_replica: bool,
    /// Prepared statement cache
    stmt_cache: PreparedStatementCache,
    /// Query result cache with TTL
    query_cache: QueryResultCache,
}

#[cfg(feature = "turso")]
impl TursoStore {
    /// Get the TursoConfig used by this store
    pub fn get_config(&self) -> &TursoConfig {
        &self.config
    }

    /// Get a cached SQL statement or cache a new one
    fn get_cached_sql(&self, key: &str, sql: &str) -> String {
        self.stmt_cache
            .get_or_insert(key.to_string(), sql.to_string())
    }

    /// Check if this is an embedded replica store
    pub fn is_embedded_replica(&self) -> bool {
        self.is_embedded_replica
    }

    /// Get the sync interval for embedded replicas
    pub fn get_sync_interval(&self) -> Option<u64> {
        self.config.sync_interval_seconds
    }

    /// Get the database URL
    pub fn get_database_url(&self) -> &str {
        &self.config.url
    }

    /// Get the replica path (if configured for embedded mode)
    pub fn get_replica_path(&self) -> Option<&str> {
        self.config.embedded_replica_path.as_deref()
    }

    /// Create a new TursoStore with embedded replica (recommended)
    pub async fn new_embedded_replica(config: TursoConfig) -> AtomicResult<Self> {
        let replica_path = config
            .embedded_replica_path
            .as_ref()
            .ok_or("Embedded replica path required")?;

        info!(
            "Initializing Turso store with embedded replica at: {}",
            replica_path
        );

        let mut builder = Builder::new_remote_replica(
            replica_path,
            config.url.clone(),
            config.get_auth_token().to_string(),
        );

        if let Some(interval) = config.sync_interval_seconds {
            builder = builder.sync_interval(std::time::Duration::from_secs(interval));
        }

        let db = builder.build().await.map_err(|e| {
            AtomicError::other_error(format!("Failed to create Turso embedded replica: {}", e))
        })?;

        let db_arc = Arc::new(db);
        let store = Self {
            db: db_arc.clone(),
            connection_pool: ConnectionPool::new(db_arc, 10), // Max 10 connections
            config,
            default_agent: Arc::new(RwLock::new(None)),
            server_url: Arc::new(RwLock::new(None)),
            is_embedded_replica: true,
            stmt_cache: PreparedStatementCache::new(100),
            query_cache: QueryResultCache::new(1000, Duration::from_secs(300)), // 5-minute TTL
        };

        store.init_schema().await?;
        Ok(store)
    }

    /// Create a new TursoStore with remote-only connection
    pub async fn new_remote(config: TursoConfig) -> AtomicResult<Self> {
        info!(
            "Initializing Turso store with remote connection to: {}",
            config.url
        );

        let db = Builder::new_remote(config.url.clone(), config.get_auth_token().to_string())
            .build()
            .await
            .map_err(|e| {
                AtomicError::other_error(format!("Failed to create Turso remote connection: {}", e))
            })?;

        let db_arc = Arc::new(db);
        let store = Self {
            db: db_arc.clone(),
            connection_pool: ConnectionPool::new(db_arc, 10), // Max 10 connections
            config,
            default_agent: Arc::new(RwLock::new(None)),
            server_url: Arc::new(RwLock::new(None)),
            is_embedded_replica: false,
            stmt_cache: PreparedStatementCache::new(100),
            query_cache: QueryResultCache::new(1000, Duration::from_secs(300)), // 5-minute TTL
        };

        store.init_schema().await?;
        Ok(store)
    }

    /// Get a connection from the connection pool
    async fn get_connection(&self) -> AtomicResult<Connection> {
        self.connection_pool.acquire().await
    }

    /// Initialize database schema for atomic data
    async fn init_schema(&self) -> AtomicResult<()> {
        let conn = self.get_connection().await?;

        // Create resources table - stores the main atomic data
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS resources (
                subject TEXT PRIMARY KEY,
                resource_json TEXT NOT NULL,
                created_at INTEGER DEFAULT (unixepoch()),
                updated_at INTEGER DEFAULT (unixepoch())
            )
            "#,
            (),
        )
        .await
        .map_err(|e| {
            AtomicError::other_error(format!("Failed to create resources table: {}", e))
        })?;

        // Create search index table for FTS
        conn.execute(
            r#"
            CREATE VIRTUAL TABLE IF NOT EXISTS resources_fts USING fts5(
                subject,
                content,
                content='resources',
                content_rowid='rowid'
            )
            "#,
            (),
        )
        .await
        .map_err(|e| AtomicError::other_error(format!("Failed to create FTS table: {}", e)))?;

        // Create trigger to keep FTS in sync
        conn.execute(
            r#"
            CREATE TRIGGER IF NOT EXISTS resources_fts_insert AFTER INSERT ON resources BEGIN
                INSERT INTO resources_fts(rowid, subject, content)
                VALUES (new.rowid, new.subject, new.resource_json);
            END
            "#,
            (),
        )
        .await
        .map_err(|e| AtomicError::other_error(format!("Failed to create insert trigger: {}", e)))?;

        conn.execute(
            r#"
            CREATE TRIGGER IF NOT EXISTS resources_fts_update AFTER UPDATE ON resources BEGIN
                UPDATE resources_fts SET subject = new.subject, content = new.resource_json
                WHERE rowid = new.rowid;
            END
            "#,
            (),
        )
        .await
        .map_err(|e| AtomicError::other_error(format!("Failed to create update trigger: {}", e)))?;

        conn.execute(
            r#"
            CREATE TRIGGER IF NOT EXISTS resources_fts_delete AFTER DELETE ON resources BEGIN
                DELETE FROM resources_fts WHERE rowid = old.rowid;
            END
            "#,
            (),
        )
        .await
        .map_err(|e| AtomicError::other_error(format!("Failed to create delete trigger: {}", e)))?;

        // Create indexes for performance
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_resources_updated_at ON resources(updated_at)",
            (),
        )
        .await
        .map_err(|e| {
            AtomicError::other_error(format!("Failed to create updated_at index: {}", e))
        })?;

        // Strategic performance indexes

        // Index for subject prefix queries (common for URL-based lookups)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_resources_subject_prefix ON resources(subject COLLATE NOCASE)",
            (),
        ).await
        .map_err(|e| AtomicError::other_error(format!("Failed to create subject prefix index: {}", e)))?;

        // JSON indexes for frequently accessed properties
        conn.execute(
            r#"CREATE INDEX IF NOT EXISTS idx_resources_shortname 
               ON resources(json_extract(resource_json, '$.["https://atomicdata.dev/properties/shortname"]'))"#,
            (),
        ).await
        .map_err(|e| AtomicError::other_error(format!("Failed to create shortname index: {}", e)))?;

        conn.execute(
            r#"CREATE INDEX IF NOT EXISTS idx_resources_is_a 
               ON resources(json_extract(resource_json, '$.["https://atomicdata.dev/properties/is-a"]'))"#,
            (),
        ).await
        .map_err(|e| AtomicError::other_error(format!("Failed to create is-a index: {}", e)))?;

        conn.execute(
            r#"CREATE INDEX IF NOT EXISTS idx_resources_name
               ON resources(json_extract(resource_json, '$.["https://atomicdata.dev/properties/name"]'))"#,
            (),
        ).await
        .map_err(|e| AtomicError::other_error(format!("Failed to create name index: {}", e)))?;

        // Partial index for local resources (hot path optimization)
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_resources_local ON resources(subject) WHERE subject LIKE 'https://localhost%'",
            (),
        ).await
        .map_err(|e| AtomicError::other_error(format!("Failed to create local resources index: {}", e)))?;

        info!("Turso database schema initialized successfully with performance indexes");
        Ok(())
    }

    /// Sync embedded replica with remote (only works for embedded replicas)
    pub async fn sync(&self) -> AtomicResult<()> {
        if !self.is_embedded_replica {
            return Ok(()); // No-op for remote-only connections
        }

        self.db.sync().await.map_err(|e| {
            AtomicError::other_error(format!("Failed to sync Turso replica: {}", e))
        })?;

        debug!("Turso replica sync completed successfully");
        Ok(())
    }

    /// Set server URL for this store
    pub fn set_server_url(&self, url: &str) {
        *self.server_url.write() = Some(url.to_string());
    }

    /// Convert Resource to JSON for storage
    fn resource_to_json(&self, resource: &Resource) -> AtomicResult<String> {
        resource.to_json_ad()
    }

    /// Convert JSON back to Resource
    fn json_to_resource(&self, json: &str) -> AtomicResult<Resource> {
        crate::parse::parse_json_ad_resource(json, self, &crate::parse::ParseOpts::default())
    }
}

#[cfg(feature = "turso")]
struct StreamingResourceIterator {
    store: TursoStore,
    include_external: bool,
    buffer: VecDeque<Resource>,
    offset: usize,
    batch_size: usize,
    exhausted: bool,
    runtime: tokio::runtime::Handle,
}

impl StreamingResourceIterator {
    fn new(store: TursoStore, include_external: bool) -> Self {
        Self {
            store,
            include_external,
            buffer: VecDeque::new(),
            offset: 0,
            batch_size: 1000, // Fetch 1000 resources at a time
            exhausted: false,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    fn fetch_next_batch(&mut self) -> bool {
        if self.exhausted {
            return false;
        }

        let server_url = self.store.server_url.read().clone();
        let batch_result = self.runtime.block_on(async {
            let conn = match self.store.get_connection().await {
                Ok(conn) => conn,
                Err(_) => return Vec::new(),
            };

            let (base_query, params) = if !self.include_external {
                if let Some(ref url) = server_url {
                    // Validate server URL to prevent SQL injection
                    match security::SecurityValidator::validate_server_url(url) {
                        Ok(safe_url) => {
                            ("SELECT resource_json FROM resources WHERE subject LIKE ? ORDER BY subject".to_string(),
                             vec![format!("{}%", safe_url)])
                        }
                        Err(_) => {
                            security::SecurityValidator::log_security_event(
                                "INVALID_SERVER_URL", 
                                "Invalid server URL in streaming all_resources", 
                                "HIGH"
                            );
                            return Vec::new();
                        }
                    }
                } else {
                    ("SELECT resource_json FROM resources ORDER BY subject".to_string(), vec![])
                }
            } else {
                ("SELECT resource_json FROM resources ORDER BY subject".to_string(), vec![])
            };

            // Add LIMIT and OFFSET for pagination
            let query = format!("{} LIMIT {} OFFSET {}", base_query, self.batch_size, self.offset);
            
            let result = if params.is_empty() {
                conn.query(&query, ()).await
            } else {
                conn.query(&query, libsql::params_from_iter(params)).await
            };

            let mut batch_resources = Vec::new();
            if let Ok(mut rows) = result {
                while let Ok(Some(row)) = rows.next().await {
                    match row.get::<String>(0) {
                        Ok(json) => {
                            if let Ok(resource) = self.store.json_to_resource(&json) {
                                batch_resources.push(resource);
                            }
                        }
                        Err(_) => continue,
                    }
                }
            }

            // Release connection back to pool
            self.store.connection_pool.release(conn).await;
            batch_resources
        });

        if batch_result.is_empty() {
            self.exhausted = true;
            false
        } else {
            // Update offset for next batch
            self.offset += batch_result.len();

            // If we got fewer results than requested, we've reached the end
            if batch_result.len() < self.batch_size {
                self.exhausted = true;
            }

            // Add to buffer
            for resource in batch_result {
                self.buffer.push_back(resource);
            }
            true
        }
    }
}

impl Iterator for StreamingResourceIterator {
    type Item = Resource;

    fn next(&mut self) -> Option<Self::Item> {
        // Try to get from buffer first
        if let Some(resource) = self.buffer.pop_front() {
            return Some(resource);
        }

        // Buffer is empty, try to fetch next batch
        if self.fetch_next_batch() {
            self.buffer.pop_front()
        } else {
            None
        }
    }
}

#[cfg(feature = "turso")]
impl Storelike for TursoStore {
    fn add_atoms(&self, atoms: Vec<crate::Atom>) -> AtomicResult<()> {
        if atoms.is_empty() {
            return Ok(());
        }

        // Convert atoms to resources
        let mut resources = std::collections::HashMap::new();

        for atom in atoms {
            let resource = resources
                .entry(atom.subject.clone())
                .or_insert_with(|| Resource::new(atom.subject.clone()));
            resource.set_unsafe(atom.property, atom.value);
        }

        // Batch insert with single transaction for better performance
        let runtime = tokio::runtime::Handle::current();
        runtime.block_on(async {
            let conn = self.get_connection().await?;
            
            // Start transaction for atomic batch operation
            conn.execute("BEGIN IMMEDIATE", ()).await
                .map_err(|e| AtomicError::other_error(format!("Failed to start transaction: {}", e)))?;
            
            // Use a cached prepared statement for all inserts
            let insert_sql = self.get_cached_sql(
                "insert_resource",
                "INSERT OR REPLACE INTO resources (subject, resource_json, updated_at) VALUES (?, ?, unixepoch())"
            );
            
            let resource_count = resources.len();
            for resource in resources.values() {
                // Serialize resource to JSON
                let json_value = resource.to_json_ad()
                    .map_err(|e| AtomicError::other_error(format!("Failed to serialize resource: {}", e)))?;
                let json_str = json_value.to_string();
                
                // Execute parameterized insert
                conn.execute(&insert_sql, params![resource.get_subject().clone(), json_str]).await
                    .map_err(|e| AtomicError::other_error(format!("Failed to insert resource: {}", e)))?;
            }
            
            // Commit transaction
            conn.execute("COMMIT", ()).await
                .map_err(|e| AtomicError::other_error(format!("Failed to commit transaction: {}", e)))?;
            
            debug!("Successfully batch inserted {} resources", resource_count);
            Ok::<(), AtomicError>(())
        })?;

        // Clear cache after batch operations to ensure consistency
        self.query_cache.clear_all();
        debug!("Cleared query cache after batch operation");

        Ok(())
    }

    fn add_resource_opts(
        &self,
        resource: &Resource,
        check_required_props: bool,
        update_index: bool,
        overwrite_existing: bool,
    ) -> AtomicResult<()> {
        // Validate subject to prevent SQL injection
        security::SecurityValidator::validate_subject(resource.get_subject())?;

        // Run in async context
        let runtime = tokio::runtime::Handle::current();
        let conn = runtime.block_on(self.get_connection())?;

        if check_required_props {
            resource.check_required_props(self)?;
        }

        if !overwrite_existing {
            // Check if resource exists
            let resource_exists_sql = self.get_cached_sql(
                "resource_exists",
                "SELECT 1 FROM resources WHERE subject = ? LIMIT 1",
            );

            let exists = runtime.block_on(async {
                let result = conn
                    .query(
                        &resource_exists_sql,
                        params![resource.get_subject().clone()],
                    )
                    .await;

                match result {
                    Ok(mut rows) => rows.next().await.unwrap_or(None).is_some(),
                    Err(_) => false,
                }
            });

            if exists {
                return Err(AtomicError::other_error(format!(
                    "Resource {} already exists and overwrite_existing is false",
                    resource.get_subject()
                )));
            }
        }

        let json = self.resource_to_json(resource)?;
        let subject = resource.get_subject();

        let insert_resource_sql = self.get_cached_sql(
            "insert_resource",
            "INSERT OR REPLACE INTO resources (subject, resource_json, updated_at) VALUES (?, ?, unixepoch())"
        );

        runtime
            .block_on(async {
                conn.execute(&insert_resource_sql, params![subject.clone(), json])
                    .await
            })
            .map_err(|e| AtomicError::other_error(format!("Failed to store resource: {}", e)))?;

        // Invalidate cache for this resource
        self.query_cache.invalidate(subject);
        debug!("Invalidated cache for resource: {}", subject);

        let _ = update_index; // FTS is automatically updated via triggers
        Ok(())
    }

    fn all_resources(&self, include_external: bool) -> Box<dyn Iterator<Item = Resource>> {
        Box::new(StreamingResourceIterator::new(
            self.clone(),
            include_external,
        ))
    }

    fn get_resource(&self, subject: &str) -> AtomicResult<Resource> {
        // Validate subject to prevent SQL injection
        security::SecurityValidator::validate_subject(subject)?;

        // Check cache first
        if let Some(cached_resource) = self.query_cache.get(subject) {
            debug!("Cache hit for resource: {}", subject);
            return Ok(cached_resource);
        }

        let runtime = tokio::runtime::Handle::current();
        let conn = runtime.block_on(self.get_connection())?;

        let get_resource_sql = self.get_cached_sql(
            "get_resource",
            "SELECT resource_json FROM resources WHERE subject = ? LIMIT 1",
        );

        let result =
            runtime.block_on(async { conn.query(&get_resource_sql, params![subject]).await });

        match result {
            Ok(mut rows) => {
                if let Ok(Some(row)) = runtime.block_on(rows.next()) {
                    let json = row.get::<String>(0).map_err(|e| {
                        AtomicError::other_error(format!("Failed to get JSON from row: {}", e))
                    })?;
                    let resource = self.json_to_resource(&json)?;

                    // Cache the successful result
                    self.query_cache
                        .insert(subject.to_string(), resource.clone());
                    debug!("Cached resource: {}", subject);

                    Ok(resource)
                } else {
                    self.handle_not_found(
                        subject,
                        AtomicError::not_found(format!("Resource not found: {}", subject)),
                        self.get_default_agent().ok().as_ref(),
                    )
                }
            }
            Err(e) => Err(AtomicError::other_error(format!(
                "Database query failed: {}",
                e
            ))),
        }
    }

    fn remove_resource(&self, subject: &str) -> AtomicResult<()> {
        // Validate subject to prevent SQL injection
        security::SecurityValidator::validate_subject(subject)?;

        let runtime = tokio::runtime::Handle::current();
        let conn = runtime.block_on(self.get_connection())?;

        let result = runtime.block_on(async {
            conn.execute("DELETE FROM resources WHERE subject = ?", params![subject])
                .await
        });

        match result {
            Ok(rows_affected) => {
                if rows_affected > 0 {
                    Ok(())
                } else {
                    Err(AtomicError::not_found(format!(
                        "Resource not found for deletion: {}",
                        subject
                    )))
                }
            }
            Err(e) => Err(AtomicError::other_error(format!(
                "Failed to delete resource: {}",
                e
            ))),
        }
    }

    fn query(&self, q: &Query) -> AtomicResult<QueryResult> {
        let runtime = tokio::runtime::Handle::current();
        let conn = runtime.block_on(self.get_connection())?;

        let mut query_sql = "SELECT subject, resource_json FROM resources".to_string();
        let mut params = Vec::new();
        let mut where_clauses = Vec::new();

        // Add property/value filtering with validation
        if let (Some(property), Some(value)) = (&q.property, &q.value) {
            // Validate property name to prevent JSON injection
            security::SecurityValidator::validate_property_name(property)?;

            where_clauses.push("json_extract(resource_json, ?) = ?".to_string());
            params.push(format!("$.{}", property));
            params.push(value.to_string());
        }

        // Add external resource filtering with validation
        if !q.include_external {
            if let Some(server_url) = self.server_url.read().as_ref() {
                let safe_url = security::SecurityValidator::validate_server_url(server_url)?;
                where_clauses.push("subject LIKE ?".to_string());
                params.push(format!("{}%", safe_url));
            }
        }

        if !where_clauses.is_empty() {
            query_sql.push_str(" WHERE ");
            query_sql.push_str(&where_clauses.join(" AND "));
        }

        // Add sorting with validation - only allow safe, predefined columns
        if let Some(sort_by) = &q.sort_by {
            let safe_sort_column = security::SecurityValidator::validate_sort_column(sort_by)?;

            // Use parameterized query for sort column too
            query_sql.push_str(" ORDER BY json_extract(resource_json, ?)");
            if q.sort_desc {
                query_sql.push_str(" DESC");
            } else {
                query_sql.push_str(" ASC");
            }
            params.push(format!("$.{}", safe_sort_column));
        }

        // Add pagination with validation
        if let Some(limit) = q.limit {
            let safe_limit = security::SecurityValidator::validate_limit(limit)?;
            query_sql.push_str(" LIMIT ?");
            params.push(safe_limit.to_string());
        }

        if q.offset > 0 {
            let safe_offset = security::SecurityValidator::validate_offset(q.offset)?;
            query_sql.push_str(" OFFSET ?");
            params.push(safe_offset.to_string());
        }

        let result = runtime
            .block_on(async {
                let mut rows = conn
                    .query(&query_sql, libsql::params_from_iter(params))
                    .await?;
                let mut subjects = Vec::new();
                let mut resources = Vec::new();

                while let Ok(Some(row)) = rows.next().await {
                    let subject: String = row.get(0)?;
                    let json: String = row.get(1)?;

                    subjects.push(subject);

                    if q.include_nested {
                        if let Ok(resource) = self.json_to_resource(&json) {
                            resources.push(resource);
                        }
                    }
                }

                Ok((subjects, resources))
            })
            .map_err(|e: libsql::Error| AtomicError::other_error(format!("Query failed: {}", e)))?;

        let (subjects, resources) = result;
        let count = subjects.len();

        Ok(QueryResult {
            subjects,
            resources,
            count,
        })
    }

    fn get_server_url(&self) -> AtomicResult<String> {
        self.server_url
            .read()
            .clone()
            .ok_or_else(|| "No server URL set. Use set_server_url() to configure.".into())
    }

    fn get_self_url(&self) -> Option<String> {
        self.server_url.read().clone()
    }

    fn get_default_agent(&self) -> AtomicResult<Agent> {
        self.default_agent
            .read()
            .clone()
            .ok_or_else(|| "No default agent set. Use set_default_agent() to configure.".into())
    }

    fn set_default_agent(&self, agent: Agent) {
        *self.default_agent.write() = Some(agent);
    }
}

#[cfg(not(feature = "turso"))]
pub struct TursoStore;

#[cfg(not(feature = "turso"))]
impl TursoStore {
    pub fn new_embedded_replica(_config: ()) -> AtomicResult<Self> {
        Err("Turso support not enabled. Enable the 'turso' feature flag.".into())
    }

    pub fn new_remote(_config: ()) -> AtomicResult<Self> {
        Err("Turso support not enabled. Enable the 'turso' feature flag.".into())
    }
}

#[cfg(all(test, feature = "turso"))]
mod tests {
    use super::*;
    use crate::{datatype::DataType, Resource, Value};
    use tempfile::TempDir;

    /// Creates a test TursoConfig with mock values
    fn create_test_config() -> TursoConfig {
        TursoConfig::new(
            "libsql://test-db.turso.io".to_string(),
            "test-token".to_string(),
            Some("test_replica.db".to_string()),
            Some(30),
        )
    }

    /// Creates a test TursoConfig for remote-only mode
    fn create_remote_config() -> TursoConfig {
        TursoConfig::new(
            "libsql://test-db.turso.io".to_string(),
            "test-token".to_string(),
            None,
            None,
        )
    }

    /// Creates a test resource for testing
    fn create_test_resource(subject: &str) -> Resource {
        let mut resource = Resource::new(subject.to_string());
        resource.set_unsafe(
            "https://atomicdata.dev/properties/description".to_string(),
            Value::new("Test description", &DataType::String).unwrap(),
        );
        resource.set_unsafe(
            "https://atomicdata.dev/properties/shortname".to_string(),
            Value::new("test-resource", &DataType::String).unwrap(),
        );
        resource
    }

    #[test]
    fn test_turso_config_default() {
        let config = TursoConfig::default();
        assert_eq!(config.url, "");
        assert_eq!(config.get_auth_token_for_test(), "");
        assert_eq!(
            config.embedded_replica_path,
            Some("atomic_data.db".to_string())
        );
        assert_eq!(config.sync_interval_seconds, Some(60));
    }

    #[test]
    fn test_turso_config_creation() {
        let config = create_test_config();
        assert_eq!(config.url, "libsql://test-db.turso.io");
        assert_eq!(config.get_auth_token_for_test(), "test-token");
        assert_eq!(
            config.embedded_replica_path,
            Some("test_replica.db".to_string())
        );
        assert_eq!(config.sync_interval_seconds, Some(30));
    }

    #[test]
    fn test_remote_config_creation() {
        let config = create_remote_config();
        assert_eq!(config.url, "libsql://test-db.turso.io");
        assert_eq!(config.get_auth_token_for_test(), "test-token");
        assert_eq!(config.embedded_replica_path, None);
        assert_eq!(config.sync_interval_seconds, None);
    }

    #[test]
    fn test_config_access_methods() {
        // Test that config is properly accessible and all methods work
        let temp_dir = TempDir::new().unwrap();
        let replica_path = temp_dir.path().join("test.db");

        let config = TursoConfig::new(
            "libsql://test-db.turso.io".to_string(),
            "test-token".to_string(),
            Some(replica_path.to_string_lossy().to_string()),
            Some(60),
        );

        // Test config structure and accessors
        assert_eq!(config.url, "libsql://test-db.turso.io");
        assert_eq!(config.get_auth_token_for_test(), "test-token");
        assert_eq!(config.sync_interval_seconds, Some(60));
        assert!(config.embedded_replica_path.is_some());

        // Test resource creation for JSON conversion
        let resource = create_test_resource("https://example.com/resource/1");
        assert!(resource.get_subject() == "https://example.com/resource/1");
        assert!(resource
            .get("https://atomicdata.dev/properties/description")
            .is_ok());
    }

    #[test]
    fn test_config_validation() {
        // Test various config scenarios
        let temp_dir = TempDir::new().unwrap();
        let replica_path = temp_dir.path().join("embedded.db");

        // Test embedded replica config
        let embedded_config = TursoConfig::new(
            "libsql://embedded-test.turso.io".to_string(),
            "embedded-token".to_string(),
            Some(replica_path.to_string_lossy().to_string()),
            Some(30),
        );

        assert!(embedded_config.embedded_replica_path.is_some());
        assert_eq!(embedded_config.sync_interval_seconds, Some(30));

        // Test remote-only config
        let remote_config = TursoConfig::new(
            "libsql://remote-test.turso.io".to_string(),
            "remote-token".to_string(),
            None,
            None,
        );

        assert!(remote_config.embedded_replica_path.is_none());
        assert!(remote_config.sync_interval_seconds.is_none());

        // Test config with different sync intervals
        let fast_sync_config = TursoConfig::new(
            "libsql://fast-sync.turso.io".to_string(),
            "fast-token".to_string(),
            Some("./fast_replica.db".to_string()),
            Some(5),
        );

        assert_eq!(fast_sync_config.sync_interval_seconds, Some(5));
    }

    #[test]
    fn test_embedded_replica_path_required() {
        let config = TursoConfig::new(
            "libsql://test-db.turso.io".to_string(),
            "test-token".to_string(),
            None,
            Some(60),
        );

        // This should fail because embedded replica requires a path
        // Note: We would test TursoStore::new_embedded_replica(config) but it requires actual Turso connection
        assert!(config.embedded_replica_path.is_none());
    }

    #[test]
    fn test_clone_functionality() {
        let config = create_test_config();
        let cloned_config = config.clone();

        assert_eq!(config.url, cloned_config.url);
        assert_eq!(
            config.get_auth_token_for_test(),
            cloned_config.get_auth_token_for_test()
        );
        assert_eq!(
            config.embedded_replica_path,
            cloned_config.embedded_replica_path
        );
        assert_eq!(
            config.sync_interval_seconds,
            cloned_config.sync_interval_seconds
        );
    }

    // Note: Integration tests that require actual Turso connections are in separate test files
    // These unit tests focus on configuration, data structures, and logic that doesn't require network
}
