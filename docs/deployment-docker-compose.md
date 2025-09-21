# Docker Compose Deployment

Deploy Atomic Server locally or on a VPS using Docker Compose.

## Quick Start

```bash
# Clone and run
git clone <repo> && cd atomic-server
docker-compose up -d

# Access at http://localhost
```

## Configuration

### docker-compose.yml

```yaml
services:
  atomic-server:
    image: joepmeneer/atomic-server
    container_name: atomic-server
    restart: unless-stopped
    ports:
      - 80:80
    volumes:
      - atomic-storage:/atomic-storage
    environment:
      - ATOMIC_DOMAIN=localhost
      - ATOMIC_DATA_DIR=/atomic-storage/data

volumes:
  atomic-storage:
    driver: local
```

### Environment Variables (.env)

```bash
ATOMIC_DOMAIN=localhost
ATOMIC_SERVER_URL=http://localhost
ATOMIC_DATA_DIR=/atomic-storage/data
ATOMIC_PORT=80
ATOMIC_IP=0.0.0.0
```

## Production Setup

### With HTTPS

```yaml
services:
  atomic-server:
    image: joepmeneer/atomic-server
    container_name: atomic-server
    restart: unless-stopped
    ports:
      - 80:80
      - 443:443
    volumes:
      - atomic-storage:/atomic-storage
    environment:
      - ATOMIC_DOMAIN=your-domain.com
      - ATOMIC_SERVER_URL=https://your-domain.com
      - ATOMIC_HTTPS=true

volumes:
  atomic-storage:
    driver: local
```

### With Custom SSL Certificates

```yaml
services:
  atomic-server:
    # ... other config ...
    volumes:
      - atomic-storage:/atomic-storage
      - ./ssl/cert.pem:/atomic-storage/certs/cert.pem:ro
      - ./ssl/key.pem:/atomic-storage/certs/key.pem:ro
```

## Data Management

### Backup

```bash
# Create backup
docker run --rm -v atomic-storage:/source -v $(pwd):/backup alpine \
  tar czf /backup/atomic-backup-$(date +%Y%m%d).tar.gz -C /source .

# Export data
docker exec atomic-server atomic-server export --path /atomic-storage/backup.json
```

### Restore

```bash
# Restore volume
docker run --rm -v atomic-storage:/target -v $(pwd):/backup alpine \
  tar xzf /backup/atomic-backup-20231201.tar.gz -C /target

# Import data
docker exec atomic-server atomic-server import --file /atomic-storage/backup.json
```

## Common Commands

```bash
# View logs
docker logs atomic-server -f

# Update to latest version
docker-compose pull && docker-compose up -d

# Restart service
docker-compose restart

# Stop service
docker-compose down

# Remove everything (including data)
docker-compose down -v
```

## Troubleshooting

### Port Conflicts
```bash
# Use different port
ports:
  - 8080:80
```

### Permission Issues
```bash
# Fix volume permissions
docker exec atomic-server chown -R atomic:atomic /atomic-storage
```

### Container Won't Start
```bash
# Check logs
docker logs atomic-server

# Check status
docker ps -a
```

### Rebuild Search Index
```bash
docker exec atomic-server atomic-server --rebuild-indexes
```

## Health Check

```yaml
services:
  atomic-server:
    # ... other config ...
    healthcheck:
      test: ["CMD", "atomic-server", "--version"]
      interval: 30s
      timeout: 10s
      retries: 3
```

## Resource Limits

```yaml
services:
  atomic-server:
    # ... other config ...
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 1G
        reservations:
          cpus: '0.25'
          memory: 256M
```