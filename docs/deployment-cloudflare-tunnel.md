# Cloudflare Tunnel Deployment

Deploy Atomic Server with Cloudflare Tunnel for secure, zero-trust network access without exposing ports.

## Quick Start

```bash
# Install cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create atomic-server
cloudflared tunnel route dns atomic-server yourdomain.com

# Deploy with Docker Compose
docker-compose -f docs/src/atomicserver/docker-compose.yml up -d
```

## Configuration

### Docker Compose Setup

Use the existing configuration from `/docs/src/atomicserver/docker-compose.yml`:

```yaml
version: "3.4"

services:
  atomic-server:
    image: joepmeneer/atomic-server
    container_name: atomic-server
    restart: unless-stopped
    environment:
      ATOMIC_DOMAIN: ${ATOMIC_DOMAIN}
      ATOMIC_SERVER_URL: ${ATOMIC_SERVER_URL}
      ATOMIC_DATA_DIR: /atomic-storage/data
    ports:
      - 8080:80
    volumes:
      - data:/atomic-storage
    networks:
      - atomic-network

  cloudflared:
    image: cloudflare/cloudflared:latest
    container_name: atomic-cloudflared
    restart: unless-stopped
    environment:
      TUNNEL_TOKEN: ${TUNNEL_TOKEN}
    command: tunnel run
    depends_on:
      - atomic-server
    networks:
      - atomic-network

volumes:
  data:
    driver: local

networks:
  atomic-network:
    driver: bridge
```

### Environment Variables (.env)

```bash
# Your domain
ATOMIC_DOMAIN=your-domain.com
ATOMIC_SERVER_URL=https://your-domain.com

# Tunnel token (get from Cloudflare dashboard)
TUNNEL_TOKEN=eyJhIjoiYWJjZGVmZ2hpams...
```

## Setup Steps

### 1. Create Cloudflare Tunnel

```bash
# Login to Cloudflare
cloudflared tunnel login

# Create named tunnel
cloudflared tunnel create atomic-server

# Note the tunnel ID from output
```

### 2. Configure DNS

```bash
# Create DNS record pointing to tunnel
cloudflared tunnel route dns atomic-server your-domain.com

# For subdomain
cloudflared tunnel route dns atomic-server atomic.your-domain.com
```

### 3. Get Tunnel Token

1. Go to [Cloudflare Zero Trust Dashboard](https://one.dash.cloudflare.com/)
2. Navigate to Access → Tunnels
3. Find your tunnel and click "Configure"
4. Copy the tunnel token

### 4. Deploy

```bash
# Create .env file
echo "TUNNEL_TOKEN=your-tunnel-token" > .env
echo "ATOMIC_DOMAIN=your-domain.com" >> .env
echo "ATOMIC_SERVER_URL=https://your-domain.com" >> .env

# Deploy
docker-compose -f docs/src/atomicserver/docker-compose.yml up -d
```

## Manual Configuration

### Create Tunnel Config File

Create `cloudflared/config.yml`:

```yaml
tunnel: atomic-server
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: your-domain.com
    service: http://atomic-server:80
  - hostname: "*.your-domain.com"
    service: http://atomic-server:80
  - service: http_status:404
```

### Docker Compose with Config

```yaml
services:
  atomic-server:
    image: joepmeneer/atomic-server
    environment:
      ATOMIC_DOMAIN: your-domain.com
      ATOMIC_SERVER_URL: https://your-domain.com
    ports:
      - 8080:80
    volumes:
      - atomic-data:/atomic-storage

  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel run
    volumes:
      - ./cloudflared:/etc/cloudflared
    depends_on:
      - atomic-server

volumes:
  atomic-data:
    driver: local
```

## Advanced Configuration

### Multiple Services

```yaml
# cloudflared/config.yml
tunnel: atomic-server
credentials-file: /etc/cloudflared/credentials.json

ingress:
  - hostname: atomic.your-domain.com
    service: http://atomic-server:80
  - hostname: api.your-domain.com
    service: http://atomic-server:80
    originRequest:
      httpHostHeader: atomic.your-domain.com
  - service: http_status:404
```

### Access Control

Configure authentication through Cloudflare Access:

1. Go to Cloudflare dashboard → Access → Applications
2. Add application for your domain
3. Set authentication policies:
   - Email domain restrictions
   - Multi-factor authentication
   - Geographic restrictions

## Security Features

### SSL/TLS Settings

1. Go to SSL/TLS → Overview
2. Set encryption mode to "Full (strict)"
3. Enable "Always Use HTTPS"

### Firewall Rules

```bash
# Block non-Cloudflare traffic (optional)
(not cf.edge.server_ip)

# Rate limiting for API endpoints
(http.request.uri.path contains "/commit" and http.request.method eq "POST") and (rate(1m) > 10)
```

### Bot Protection

Enable "Bot Fight Mode" in Security → Bots for automatic protection.

## Monitoring

### Cloudflare Analytics

Monitor through:
- Cloudflare Dashboard → Analytics → Traffic
- Zero Trust → Access → Audit Logs
- Zero Trust → Gateway → HTTP logs

### Container Logs

```bash
# Check tunnel status
docker logs atomic-cloudflared

# Check atomic server
docker logs atomic-server

# Monitor both
docker-compose logs -f
```

## Troubleshooting

### Tunnel Not Connecting

```bash
# Check tunnel status
docker logs atomic-cloudflared

# Verify credentials
docker exec atomic-cloudflared cloudflared tunnel list

# Test configuration
docker exec atomic-cloudflared cloudflared tunnel ingress validate
```

### DNS Not Resolving

```bash
# Check DNS records
dig your-domain.com
nslookup your-domain.com

# Verify tunnel route
cloudflared tunnel route dns atomic-server your-domain.com
```

### Service Unreachable

```bash
# Test internal connectivity
docker exec atomic-cloudflared wget -qO- http://atomic-server:80/health

# Check network
docker network inspect atomic-network
```

### SSL/TLS Errors

1. Check SSL configuration in Cloudflare dashboard
2. Ensure "Full (strict)" mode is enabled
3. Verify origin server SSL certificate

## Cost Analysis

### Cloudflare Costs

| Plan | Monthly Cost | Features |
|------|--------------|----------|
| **Free** | $0 | Basic tunnel, 50 users |
| **Zero Trust** | $3/user | Advanced features |

### Infrastructure Savings

Eliminates costs for:
- Load balancers ($10-50/month)
- SSL certificates ($10-100/year)
- DDoS protection ($20-200/month)

### Total Cost

| Component | Monthly Cost |
|-----------|--------------|
| VPS (1GB RAM) | $5-10 |
| Cloudflare | $0 (Free plan) |
| Domain | $1-2/month |
| **Total** | **$6-12/month** |

## Migration from Direct Access

```bash
# 1. Set up tunnel alongside existing setup
# 2. Test tunnel connectivity
# 3. Update DNS to point to tunnel
# 4. Monitor for 24-48 hours
# 5. Close direct access ports
```

## Best Practices

1. Use descriptive tunnel names
2. Implement proper access controls
3. Monitor tunnel health regularly
4. Keep cloudflared updated
5. Regular backup of tunnel credentials
6. Use environment-specific configurations