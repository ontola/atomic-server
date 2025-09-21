# Railway Deployment

Deploy Atomic Server on Railway for rapid prototyping with zero-configuration deployment and GitHub integration.

## Quick Start

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init atomic-server
railway up --image joepmeneer/atomic-server:latest

# Add persistent volume
railway volume create --name atomic-data --mount-path /data

# Set environment variables
railway variables set ATOMIC_DOMAIN=your-app.railway.app
railway variables set ATOMIC_SERVER_URL=https://your-app.railway.app
railway variables set ATOMIC_DATA_DIR=/data
```

## GitHub Deployment

1. **Connect Repository**:
   - Go to Railway dashboard
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your atomic-server repository

2. **Create Dockerfile** (if needed):
   ```dockerfile
   FROM rust:1.75 AS builder
   WORKDIR /app
   COPY . .
   RUN cargo build --release --bin atomic-server
   
   FROM debian:bookworm-slim
   RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
   COPY --from=builder /app/target/release/atomic-server /usr/local/bin/
   CMD ["atomic-server", "--data-dir", "/data", "--ip", "::", "--port", "$PORT"]
   ```

3. **Configure Variables**:
   ```bash
   railway variables set ATOMIC_DOMAIN=your-app.railway.app
   railway variables set ATOMIC_SERVER_URL=https://your-app.railway.app
   railway variables set ATOMIC_DATA_DIR=/data
   railway variables set PORT=8080
   ```

## Configuration

### railway.toml

```toml
[build]
builder = "dockerfile"
dockerfilePath = "Dockerfile"

[deploy]
healthcheckPath = "/health"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
restartPolicyMaxRetries = 10
numReplicas = 1  # SQLite constraint
```

### Environment Variables

```bash
# Core Configuration
ATOMIC_DOMAIN=your-app.railway.app
ATOMIC_SERVER_URL=https://your-app.railway.app
ATOMIC_DATA_DIR=/data
PORT=8080

# Optional
ATOMIC_LOG_LEVEL=info
ATOMIC_DEVELOPMENT=false

# Secrets
ATOMIC_ADMIN_PASSWORD=secure-password
ATOMIC_JWT_SECRET=your-jwt-secret
```

## Volume Management

### Creating Volume

```bash
# Create volume
railway volume create --name atomic-data --mount-path /data --size 10GB

# List volumes
railway volume list

# Extend volume
railway volume extend atomic-data --size 20GB
```

### Backup

```bash
# Check usage
railway run -- du -sh /data

# Export data
railway run -- atomic-server export --path /data/backup-$(date +%Y%m%d).json

# Automated backup script
#!/bin/bash
PROJECT_ID="your-project-id"
railway run --project $PROJECT_ID -- atomic-server export --path /data/backup-$(date +%Y%m%d).json
```

## Custom Domain

1. **Add Domain**:
   ```bash
   railway domain add atomic.example.com
   ```

2. **Update DNS**:
   ```bash
   # Get Railway's target
   railway domain list
   
   # Add CNAME record:
   # CNAME: atomic.example.com → your-app.railway.app
   ```

3. **Update Variables**:
   ```bash
   railway variables set ATOMIC_DOMAIN=atomic.example.com
   railway variables set ATOMIC_SERVER_URL=https://atomic.example.com
   ```

## Monitoring

```bash
# Real-time logs
railway logs --follow

# Resource usage
railway usage

# Service status
railway status

# Deployment history
railway deployments
```

## Data Migration

### From Another Platform

```bash
# Export from source
atomic-server export --path backup.json

# Upload to Railway
railway run -- curl -o /data/import.json https://source.com/backup.json

# Import
railway run -- atomic-server import --file /data/import.json
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Deploy to Railway

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install Railway CLI
        run: npm install -g @railway/cli
      
      - name: Deploy
        run: railway up --service atomic-server
        env:
          RAILWAY_TOKEN: ${{ secrets.RAILWAY_TOKEN }}
```

## Troubleshooting

### Common Issues

```bash
# Deployment failures
railway logs --deployment-id <id>

# Volume not mounting
railway volume list
# Check mount path configuration

# Environment variables
railway variables
railway run -- env | grep ATOMIC

# Domain issues
railway domain list
dig atomic.example.com
```

### Performance

```bash
# Resource usage
railway metrics

# Memory monitoring
railway run -- top

# Disk space
railway run -- df -h
```

## Cost Management

### Pricing Plans

| Plan | Monthly Cost | Resources |
|------|-------------|-----------|
| **Hobby** | $5 credit | Basic resources |
| **Pro** | $20/month | Higher limits |
| **Team** | $50/month | Advanced features |

### Usage Monitoring

```bash
# Check current usage
railway usage

# Monitor costs
railway billing
```

## Updates

```bash
# Auto-deploy on git push (default)
git push origin main

# Manual deploy
railway up

# Rollback
railway rollback <deployment-id>
```

## Security

```bash
# Use Railway's secret management
railway variables set ATOMIC_JWT_SECRET=$(openssl rand -hex 32)
railway variables set ATOMIC_ADMIN_PASSWORD=$(openssl rand -base64 32)

# Environment isolation
railway environment create staging
railway up --environment staging
```

## Production Checklist

- [ ] Custom domain configured
- [ ] Volume attached and mounted
- [ ] Environment variables set
- [ ] GitHub integration working
- [ ] Backup strategy implemented
- [ ] Resource limits appropriate
- [ ] Single replica confirmed