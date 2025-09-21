# Fly.io Deployment

Deploy Atomic Server globally with automatic SSL and persistent SQLite storage.

## Quick Start

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Deploy
fly apps create atomic-server-myname
fly volumes create atomic_data --size 10 --region iad
fly deploy --image joepmeneer/atomic-server:latest
fly scale count 1  # SQLite requires single instance

# Open in browser
fly open
```

## Configuration

### fly.toml

```toml
app = "atomic-server-myname"
primary_region = "iad"

[build]
  image = "joepmeneer/atomic-server:latest"

[env]
  ATOMIC_DATA_DIR = "/data"
  ATOMIC_PORT = "8080"
  ATOMIC_DOMAIN = "atomic-server-myname.fly.dev"
  ATOMIC_SERVER_URL = "https://atomic-server-myname.fly.dev"

[[services]]
  internal_port = 8080
  protocol = "tcp"
  auto_stop_machines = false
  min_machines_running = 1

  [[services.ports]]
    port = 80
    handlers = ["http"]
    force_https = true

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]

  [[services.tcp_checks]]
    interval = "15s"
    timeout = "2s"

[mounts]
  source = "atomic_data"
  destination = "/data"
```

## Custom Domain

```bash
# Add domain
fly certs create your-domain.com

# Get IP addresses
fly ips list

# Add DNS records at your provider:
# A record: your-domain.com -> [IPv4]
# AAAA record: your-domain.com -> [IPv6]

# Update fly.toml
ATOMIC_DOMAIN=your-domain.com
ATOMIC_SERVER_URL=https://your-domain.com

# Redeploy
fly deploy
```

## Storage Management

### Volume Operations

```bash
# Create volume
fly volumes create atomic_data --size 10 --region iad

# List volumes
fly volumes list

# Extend volume
fly volumes extend vol_example123 --size 20

# Create snapshot (backup)
fly volumes snapshots create vol_example123
```

### Backup & Restore

```bash
# SSH and export data
fly ssh console
atomic-server export --path /data/backup-$(date +%Y%m%d).json

# Download backup
fly ssh sftp get /data/backup-20231201.json ./

# Automated backup script
#!/bin/bash
APP_NAME="atomic-server-myname"
fly ssh console --app $APP_NAME --command "atomic-server export --path /data/backup-$(date +%Y%m%d).json"
fly ssh sftp get --app $APP_NAME /data/backup-*.json ./backups/
```

## Monitoring

```bash
# View logs
fly logs

# Follow logs
fly logs -f

# App status
fly status

# Machine details
fly machine list

# Resource usage
fly metrics
```

## Scaling

### VM Resources

```toml
# In fly.toml
[vm]
  cpu_kind = "shared"    # or "performance"
  cpus = 1               # 1-8 CPUs
  memory_mb = 1024       # 256MB - 8GB
```

### Regional Deployment

```bash
# List regions
fly platform regions

# Common regions:
# iad - Washington DC (US East)
# lax - Los Angeles (US West)  
# fra - Frankfurt (Europe)
# nrt - Tokyo (Asia)
# syd - Sydney (Australia)
```

## Troubleshooting

### Common Issues

```bash
# App won't start
fly logs
fly machine list

# Volume not mounted
fly volumes list
# Check [mounts] in fly.toml

# SSL certificate issues
fly certs show your-domain.com
fly certs create your-domain.com --force

# Performance issues
fly metrics
fly scale vm performance-2x
```

### Debugging

```bash
# SSH into machine
fly ssh console

# Port forwarding
fly proxy 8080:8080

# SFTP access
fly ssh sftp shell
```

## Cost Optimization

### Pricing Tiers

| Plan | Monthly Cost | Specs |
|------|-------------|--------|
| **Free** | $0 | 3 shared VMs, 3GB storage |
| **Hobby** | $5/month | Shared CPU, 256MB RAM |
| **Standard** | $0.02/hour | Shared CPU, 1GB RAM |

### Storage Costs

- **Volumes**: $0.15/GB/month
- **Snapshots**: $0.02/GB/month

### Example Costs

| Configuration | Monthly Cost |
|---------------|--------------|
| Free tier (3GB storage) | $0 |
| Small production (1GB RAM, 10GB) | ~$8-15 |
| Medium production (2GB RAM, 50GB) | ~$25-35 |

## Security

```bash
# Use secrets for sensitive data
fly secrets set ATOMIC_ADMIN_PASSWORD=your-secure-password
fly secrets set ATOMIC_JWT_SECRET=your-jwt-secret

# List secrets (values hidden)
fly secrets list
```

## Updates

```bash
# Update to latest version
fly deploy --image joepmeneer/atomic-server:latest

# Zero-downtime deployment (automatic)
# Fly.io handles this automatically
```

## Production Checklist

- [ ] Custom domain configured
- [ ] SSL certificates verified  
- [ ] Volume created and mounted
- [ ] Health checks configured
- [ ] Backup strategy implemented
- [ ] Secrets configured
- [ ] Single instance confirmed
- [ ] DNS records propagated