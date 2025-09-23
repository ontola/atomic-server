# Deployment Overview

Choose the right deployment platform for Atomic Server.

## Quick Decision Matrix

| Use Case | Platform | Setup Time | Monthly Cost |
|----------|----------|------------|--------------|
| **Global Production** ⭐ | [Turso](deployment-turso.md) | 20 min | $0-87 |
| **Local Development** | [Docker Compose](deployment-docker-compose.md) | 5 min | $0 |
| **Regional Production** | [Fly.io](deployment-fly-io.md) | 30 min | $5-15 |
| **Rapid Prototyping** | [Railway](deployment-railway.md) | 10 min | $5-25 |
| **Home/Self-hosted** | [Cloudflare Tunnel](deployment-cloudflare-tunnel.md) | 15 min | $0-5 |
| **Custom Build** | [Custom Docker](deployment-custom-docker.md) | 1-2 hours | Variable |
| **Edge (NOT VIABLE)** | [Cloudflare D1](deployment-cloudflare-d1.md) | N/A | ❌ Requires rewrite |

## Platform Comparison

| Feature | Turso ⭐ | Docker Compose | Fly.io | Railway | Cloudflare Tunnel |
|---------|----------|----------------|--------|---------|-------------------|
| **Setup** | Low | Low | Low | Very Low | Medium |
| **Global** | ✅ | ❌ | ✅ | ❌ | ✅ |
| **Auto SSL** | ✅ | Manual | ✅ | ✅ | ✅ |
| **Free Tier** | ✅ | N/A | ✅ | ✅ | ✅ |
| **CI/CD** | Excellent | Manual | Good | Excellent | Manual |
| **Response Time** | <50ms | <10ms | <100ms | <200ms | <50ms |
| **Monthly Cost** | $0-87 | $5-10 | $5-15 | $5-25 | $0-5 |
| **Scaling** | Automatic | Manual | Manual | Manual | Manual |

## Quick Start Commands

### Turso ⭐ **Recommended**
```bash
# Install Turso CLI
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create atomic-server-db
turso db tokens create atomic-server-db

# Configure and run
export ATOMIC_TURSO_ENABLE=true
export ATOMIC_TURSO_URL="$(turso db show atomic-server-db --url)"
export ATOMIC_TURSO_AUTH_TOKEN="your-token-here"
cargo run --features turso --bin atomic-server
```

### Docker Compose
```bash
git clone <repo> && cd atomic-server
docker-compose up -d
```

### Fly.io
```bash
fly apps create atomic-server-myname
fly volumes create atomic_data --size 10 --region iad
fly deploy --image joepmeneer/atomic-server:latest
fly scale count 1
```

### Railway
```bash
railway login && railway init atomic-server
railway up --image joepmeneer/atomic-server:latest
railway volume create --name atomic-data --mount-path /data
```

### Cloudflare Tunnel
```bash
cloudflared tunnel create atomic-server
cloudflared tunnel route dns atomic-server yourdomain.com
docker-compose -f docs/src/atomicserver/docker-compose.yml up -d
```

## Requirements

- **SQLite**: Single instance only (no horizontal scaling)
- **Storage**: Persistent volumes required
- **Memory**: 512MB minimum, 1GB recommended
- **CPU**: 1 core sufficient for most workloads

## Migration Between Platforms

```bash
# Export data from current platform
atomic-server export --path backup.json

# Deploy to new platform (see commands above)

# Import data to new platform
atomic-server import --file backup.json
```

| Migration | Difficulty | Downtime |
|-----------|------------|----------|
| Docker → Fly.io | Easy | <5 min |
| Docker → Railway | Easy | <5 min |
| Any → Cloudflare D1 | Impossible | N/A |

## Decision Tree

```
Need global deployment?
├── Yes → Fly.io (production) or Railway (prototyping)
└── No
    ├── Self-hosting at home?
    │   └── Yes → Cloudflare Tunnel
    └── Local development?
        └── Yes → Docker Compose
```

## Recommendations

- **🚀 Global Production**: Turso (best performance + scaling)
- **Regional Production**: Fly.io 
- **Rapid Prototyping**: Railway
- **Self-hosting**: Docker Compose + Cloudflare Tunnel
- **Learning**: Docker Compose locally
- **Enterprise**: Custom Docker with your infrastructure

## Common Environment Variables

```bash
ATOMIC_DOMAIN=your-domain.com
ATOMIC_SERVER_URL=https://your-domain.com
ATOMIC_DATA_DIR=/data
ATOMIC_PORT=8080
```