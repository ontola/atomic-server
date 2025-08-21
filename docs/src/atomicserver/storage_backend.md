Added CLI Arguments (server/src/config.rs:95-116)

  - --storage-backends: Comma-separated list of backends to enable (sled, dashmap, rocksdb,
  redb, fs)
  - --prefer-memory: Prioritize in-memory storage for better performance
  - --rocksdb-path: Custom path for RocksDB storage
  - --redb-path: Custom path for ReDB storage
  - --fs-path: Custom path for filesystem storage

  2. Extended Config Struct (server/src/config.rs:215-225)

  Added fields to store the storage configuration in the Config struct.

  3. Created StorageConfig Struct (lib/src/db.rs:86-111)

  New configuration struct with:
  - List of enabled backends
  - Memory preference flag
  - Custom paths for each backend type
  - Default configuration (sled + dashmap)

  4. Refactored Db::init (lib/src/db.rs:158-165)

  - Added init_with_config method that accepts StorageConfig
  - Original init method now calls init_with_config with defaults
  - Dynamic backend initialization based on configuration
  - Respects prefer_memory flag for fastest operator selection

  5. Wired Configuration (server/src/appstate.rs:47-56)

  Connected server config to database initialization with the new storage configuration.

  Usage Examples:

  # Use default backends (sled + dashmap)
  atomic-server

  # Enable specific backends
  atomic-server --storage-backends sled,dashmap,rocksdb

  # Prefer in-memory storage
  atomic-server --prefer-memory

  # Custom paths
  atomic-server --rocksdb-path /custom/rocksdb --redb-path /custom/redb

  # Environment variables
  ATOMIC_STORAGE_BACKENDS=sled,dashmap,fs atomic-server
  ATOMIC_PREFER_MEMORY=true atomic-server