# Turso Deployment Guide

Turso provides global edge SQLite databases with built-in replication, making it ideal for deploying Atomic Server with global reach and local performance.

## Overview

Turso offers two deployment modes:
- **Embedded Replica Mode** (Recommended): Local SQLite performance + automatic sync
- **Remote-Only Mode**: Direct cloud connection

## Prerequisites

1. **Turso Account**: Sign up at [turso.tech](https://turso.tech)
2. **Turso CLI**: `curl -sSfL https://get.tur.so/install.sh | bash`
3. **Atomic Server with Turso**: Compile with `--features turso`

## Quick Setup

### 1. Create Turso Database
```bash
# Login to Turso
turso auth login

# Create database
turso db create atomic-server-db

# Get connection details
turso db show atomic-server-db --url
turso db tokens create atomic-server-db
```

### 2. Configure Atomic Server
```bash
# Environment variables
export ATOMIC_TURSO_ENABLE=true
export ATOMIC_TURSO_URL="libsql://atomic-server-db-[your-org].turso.io"
export ATOMIC_TURSO_AUTH_TOKEN="your-token-here"
export ATOMIC_TURSO_REPLICA_PATH="./data/turso_replica.db"

# Start server
cargo run --features turso --bin atomic-server
```

## Deployment Options

### Option 1: Fly.io + Turso (Recommended)
```toml
# fly.toml
[env]
ATOMIC_TURSO_ENABLE = "true"
ATOMIC_TURSO_URL = "libsql://your-db.turso.io"
ATOMIC_TURSO_REPLICA_PATH = "/data/turso_replica.db"

[mounts]
source = "data"
destination = "/data"
```

```bash
# Deploy
fly secrets set ATOMIC_TURSO_AUTH_TOKEN="your-token"
fly deploy
```

### Option 2: Railway + Turso
```bash
# Railway environment variables
railway variables set ATOMIC_TURSO_ENABLE=true
railway variables set ATOMIC_TURSO_URL="libsql://your-db.turso.io"
railway variables set ATOMIC_TURSO_AUTH_TOKEN="your-token"
railway up
```

### Option 3: Docker + Turso
```dockerfile
# Dockerfile
FROM rust:1.75 as builder
WORKDIR /app
COPY . .
RUN cargo build --release --features turso

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates
COPY --from=builder /app/target/release/atomic-server /usr/local/bin/
VOLUME ["/data"]
EXPOSE 9883
CMD ["atomic-server"]
```

```bash
# Build and run
docker build -t atomic-server-turso .
docker run -d \
  -p 9883:9883 \
  -v ./data:/data \
  -e ATOMIC_TURSO_ENABLE=true \
  -e ATOMIC_TURSO_URL="libsql://your-db.turso.io" \
  -e ATOMIC_TURSO_AUTH_TOKEN="your-token" \
  -e ATOMIC_TURSO_REPLICA_PATH="/data/turso_replica.db" \
  atomic-server-turso
```

## Configuration Reference

### Environment Variables
| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ATOMIC_TURSO_ENABLE` | Enable Turso backend | `false` | Yes |
| `ATOMIC_TURSO_URL` | Turso database URL | - | Yes |
| `ATOMIC_TURSO_AUTH_TOKEN` | Turso auth token | - | Yes |
| `ATOMIC_TURSO_REPLICA_PATH` | Local replica path | `./atomic_data.db` | No |
| `ATOMIC_TURSO_SYNC_INTERVAL` | Sync interval (seconds) | `60` | No |
| `ATOMIC_TURSO_MAX_CONNECTIONS` | Connection pool size | `10` | No |
| `ATOMIC_TURSO_CONNECTION_TIMEOUT` | Connection timeout (seconds) | `30` | No |
| `ATOMIC_TURSO_CACHE_SIZE` | Prepared statement cache size | `100` | No |
| `ATOMIC_TURSO_QUERY_CACHE_TTL` | Query cache TTL (seconds) | `300` | No |
| `ATOMIC_TURSO_QUERY_CACHE_SIZE` | Query result cache size | `500` | No |

### Command Line Flags
```bash
atomic-server \
  --turso-enable \
  --turso-url "libsql://your-db.turso.io" \
  --turso-auth-token "your-token" \
  --turso-replica-path "./data/replica.db" \
  --turso-sync-interval 30
```

## Performance Optimization

### Embedded Replica Benefits
- **Local Read Performance**: SQLite-speed queries
- **Network Resilience**: Works offline, syncs when connected  
- **Automatic Sync**: Background replication to Turso cloud
- **Global Distribution**: Turso handles multi-region replication

### Sync Configuration
```bash
# Fast sync for high-write workloads
ATOMIC_TURSO_SYNC_INTERVAL=10

# Balanced sync for normal workloads  
ATOMIC_TURSO_SYNC_INTERVAL=60

# Slow sync for read-heavy workloads
ATOMIC_TURSO_SYNC_INTERVAL=300
```

### Performance Features

Atomic Server includes advanced performance optimizations for Turso:

#### Connection Pooling
- **Async Connection Pool**: Manages multiple concurrent connections efficiently
- **Configurable Limits**: Control pool size and connection timeouts
- **Automatic Scaling**: Connections created on-demand up to pool limit

#### Intelligent Caching
- **Prepared Statement Cache**: LRU cache for SQL statements (reduces parsing overhead)
- **Query Result Cache**: TTL-based cache for frequently accessed data
- **Automatic Invalidation**: Cache entries expire based on TTL configuration

#### Optimized Data Access
- **Streaming Resource Iterator**: Memory-efficient batch processing for large datasets
- **Strategic Database Indexes**: JSON property indexes for fast queries
- **Batch Operations**: Optimized bulk insert/update operations

### Performance Tuning

#### High-Throughput Configuration
```bash
# Optimize for high-concurrency workloads
export ATOMIC_TURSO_MAX_CONNECTIONS=20
export ATOMIC_TURSO_CONNECTION_TIMEOUT=15
export ATOMIC_TURSO_CACHE_SIZE=200
export ATOMIC_TURSO_QUERY_CACHE_SIZE=1000
export ATOMIC_TURSO_QUERY_CACHE_TTL=60
```

#### Memory-Optimized Configuration
```bash
# Optimize for low-memory environments
export ATOMIC_TURSO_MAX_CONNECTIONS=5
export ATOMIC_TURSO_CACHE_SIZE=50
export ATOMIC_TURSO_QUERY_CACHE_SIZE=100
export ATOMIC_TURSO_QUERY_CACHE_TTL=600
```

#### Read-Heavy Workload Optimization
```bash
# Optimize for read-heavy applications
export ATOMIC_TURSO_QUERY_CACHE_SIZE=2000
export ATOMIC_TURSO_QUERY_CACHE_TTL=900
export ATOMIC_TURSO_SYNC_INTERVAL=300
```

## Monitoring & Observability

### Health Checks
```bash
# Check Turso connection
curl http://localhost:9883/health

# Monitor replica sync status
tail -f /var/log/atomic-server.log | grep "replica sync"
```

### Metrics
Turso provides built-in metrics:
- Read/write operations
- Sync latency
- Storage usage
- Connection health

## Scaling & High Availability

### Multi-Region Deployment
```bash
# Create database in multiple regions
turso db create atomic-server-db --location ams,sfo,nrt

# Each region gets automatic replica
turso db locations list atomic-server-db
```

### Load Balancing
Deploy multiple Atomic Server instances with the same Turso database:
```bash
# Instance 1 (US East)
ATOMIC_TURSO_REPLICA_PATH="/data/us-east-replica.db"

# Instance 2 (Europe)  
ATOMIC_TURSO_REPLICA_PATH="/data/eu-replica.db"

# Instance 3 (Asia)
ATOMIC_TURSO_REPLICA_PATH="/data/asia-replica.db"
```

## Cost Optimization

### Turso Pricing Tiers
- **Starter**: $0/month - Perfect for development/testing
- **Scaler**: $29/month - Small production deployments  
- **Pro**: $87/month - High-traffic production

### Cost-Saving Tips
1. Use embedded replicas to reduce network costs
2. Optimize sync intervals based on workload
3. Monitor storage usage with Turso dashboard
4. Use database branching for development/staging

## Troubleshooting

### Common Issues

**Connection Failed**
```bash
# Verify token
turso db tokens validate your-token

# Check URL format
turso db show your-db --url
```

**Sync Issues**
```bash
# Check replica health
ls -la /data/turso_replica.db
sqlite3 /data/turso_replica.db ".tables"

# Force sync
curl -X POST http://localhost:9883/admin/sync
```

**Performance Issues**
```bash
# Monitor sync frequency
grep "replica sync" /var/log/atomic-server.log

# Check replica size
du -h /data/turso_replica.db
```

### Migration from SQLite

1. **Export existing data**:
```bash
atomic-server --export-format json > backup.json
```

2. **Enable Turso**:
```bash
export ATOMIC_TURSO_ENABLE=true
# ... other Turso config
```

3. **Import data**:
```bash
atomic-server --import backup.json
```

## Security Best Practices

1. **Token Management**:
   - Store tokens in secure secret management
   - Rotate tokens regularly
   - Use read-only tokens where possible

2. **Network Security**:
   - Use HTTPS/TLS for all connections
   - Configure firewall rules
   - Enable VPC/private networking where available

3. **Data Encryption**:
   - Turso provides encryption at rest
   - Enable TLS for data in transit
   - Consider application-level encryption for sensitive data

## Advanced Configuration

### Custom Connection Pooling
```bash
# Adjust connection limits
ATOMIC_TURSO_MAX_CONNECTIONS=20
ATOMIC_TURSO_CONNECTION_TIMEOUT=30
```

### Performance Monitoring
```bash
# Monitor connection pool usage
grep "connection_pool" /var/log/atomic-server.log

# Check cache hit rates
grep "cache_hit" /var/log/atomic-server.log

# Monitor query performance
grep "query_duration" /var/log/atomic-server.log
```

### Cache Management
```bash
# Clear prepared statement cache
curl -X POST http://localhost:9883/admin/cache/clear/statements

# Clear query result cache
curl -X POST http://localhost:9883/admin/cache/clear/queries

# Get cache statistics
curl http://localhost:9883/admin/cache/stats
```

### Database Branching
```bash
# Create development branch
turso db create dev-branch --from-db atomic-server-db

# Use different URLs for different environments
ATOMIC_TURSO_URL_DEV="libsql://dev-branch.turso.io"
ATOMIC_TURSO_URL_PROD="libsql://atomic-server-db.turso.io"
```

This deployment option combines the reliability of SQLite with the global reach of Turso's edge network, providing excellent performance and scalability for Atomic Server deployments.

## Performance Optimization

For advanced performance tuning, configuration patterns, and benchmarking guidance, see the comprehensive [Turso Performance Guide](deployment-turso-performance.md).