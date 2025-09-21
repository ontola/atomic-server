# Custom Docker Build

Build optimized Docker images for Atomic Server with custom requirements.

## Quick Start

### Basic Multi-stage Dockerfile

```dockerfile
# Multi-stage build
FROM rust:1.75-bookworm AS builder

WORKDIR /app
COPY . .
RUN cargo build --release --bin atomic-server

# Runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/atomic-server /usr/local/bin/
RUN chmod +x /usr/local/bin/atomic-server

# Create non-root user
RUN groupadd -r atomic && useradd -r -g atomic atomic
RUN mkdir -p /atomic-storage && chown atomic:atomic /atomic-storage

USER atomic
EXPOSE 8080
VOLUME ["/atomic-storage"]

CMD ["atomic-server", "--data-dir", "/atomic-storage/data", "--ip", "::", "--port", "8080"]
```

### Build Commands

```bash
# Build image
docker build -t my-atomic-server .

# Run container
docker run -p 8080:8080 -v atomic-data:/atomic-storage my-atomic-server

# With environment variables
docker run -p 8080:8080 -v atomic-data:/atomic-storage \
  -e ATOMIC_DOMAIN=localhost \
  -e ATOMIC_LOG_LEVEL=info \
  my-atomic-server
```

## Optimized Variants

### 1. Alpine (Smallest Size)

```dockerfile
FROM rust:1.75-alpine AS builder

RUN apk add --no-cache musl-dev pkgconfig openssl-dev
WORKDIR /app
COPY . .
RUN cargo build --release --target x86_64-unknown-linux-musl --bin atomic-server

FROM alpine:latest

RUN apk add --no-cache ca-certificates sqlite \
    && addgroup -g 1000 atomic \
    && adduser -D -s /bin/sh -u 1000 -G atomic atomic

COPY --from=builder /app/target/x86_64-unknown-linux-musl/release/atomic-server /usr/local/bin/
RUN mkdir -p /atomic-storage && chown atomic:atomic /atomic-storage

USER atomic
VOLUME ["/atomic-storage"]
EXPOSE 8080

CMD ["atomic-server", "--data-dir", "/atomic-storage/data", "--ip", "::", "--port", "8080"]
```

### 2. Distroless (Maximum Security)

```dockerfile
FROM rust:1.75-bookworm AS builder

WORKDIR /app
COPY . .

# Build statically linked binary
ENV RUSTFLAGS="-C target-feature=+crt-static"
RUN cargo build --release --target x86_64-unknown-linux-gnu --bin atomic-server

FROM gcr.io/distroless/cc-debian12

COPY --from=builder /app/target/x86_64-unknown-linux-gnu/release/atomic-server /usr/local/bin/atomic-server

VOLUME ["/atomic-storage"]
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/atomic-server"]
CMD ["--data-dir", "/atomic-storage/data", "--ip", "::", "--port", "8080"]
```

### 3. Multi-platform Build

```dockerfile
# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM rust:1.75-bookworm AS builder

ARG TARGETPLATFORM

# Install cross-compilation tools
RUN case "$TARGETPLATFORM" in \
    "linux/arm64") \
        apt-get update && apt-get install -y gcc-aarch64-linux-gnu && \
        rustup target add aarch64-unknown-linux-gnu \
        ;; \
    "linux/amd64") \
        rustup target add x86_64-unknown-linux-gnu \
        ;; \
    esac

WORKDIR /app
COPY . .

# Build for target platform
RUN case "$TARGETPLATFORM" in \
    "linux/arm64") \
        export CC=aarch64-linux-gnu-gcc && \
        cargo build --release --target aarch64-unknown-linux-gnu --bin atomic-server && \
        cp target/aarch64-unknown-linux-gnu/release/atomic-server /atomic-server \
        ;; \
    "linux/amd64") \
        cargo build --release --target x86_64-unknown-linux-gnu --bin atomic-server && \
        cp target/x86_64-unknown-linux-gnu/release/atomic-server /atomic-server \
        ;; \
    esac

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=builder /atomic-server /usr/local/bin/atomic-server
RUN chmod +x /usr/local/bin/atomic-server

EXPOSE 8080
VOLUME ["/atomic-storage"]

CMD ["atomic-server", "--data-dir", "/atomic-storage/data", "--ip", "::", "--port", "8080"]
```

## Build Optimization

### Layer Caching

```dockerfile
FROM rust:1.75-bookworm AS builder

WORKDIR /app

# Copy dependency files first for better caching
COPY Cargo.toml Cargo.lock ./
COPY lib/Cargo.toml ./lib/
COPY server/Cargo.toml ./server/
COPY cli/Cargo.toml ./cli/

# Create fake source files to build dependencies
RUN mkdir -p lib/src server/src cli/src && \
    echo "fn main() {}" > server/src/main.rs && \
    echo "fn main() {}" > cli/src/main.rs && \
    echo "" > lib/src/lib.rs

# Build dependencies (cached layer)
RUN cargo build --release

# Remove fake files and copy real source
RUN rm -rf lib/src server/src cli/src
COPY . .

# Build application
RUN touch server/src/main.rs && cargo build --release --bin atomic-server
```

### Build Arguments

```dockerfile
FROM rust:1.75-bookworm AS builder

ARG FEATURES="default"
ARG TARGET="x86_64-unknown-linux-gnu"
ARG PROFILE="release"

WORKDIR /app
COPY . .

RUN if [ "$FEATURES" != "default" ]; then \
        cargo build --profile $PROFILE --target $TARGET --bin atomic-server --features "$FEATURES"; \
    else \
        cargo build --profile $PROFILE --target $TARGET --bin atomic-server; \
    fi

RUN cp target/$TARGET/$PROFILE/atomic-server /atomic-server

FROM debian:bookworm-slim
COPY --from=builder /atomic-server /usr/local/bin/atomic-server
# ... rest of runtime setup
```

Build with custom features:
```bash
# Build with specific features
docker build --build-arg FEATURES="https,telemetry" -t atomic-server-full .

# Build debug version
docker build --build-arg PROFILE="dev" -t atomic-server-debug .
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Build Docker Images

on:
  push:
    branches: [main]
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to Registry
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          context: .
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

### Multi-platform Build

```bash
# Create builder instance
docker buildx create --name atomic-builder --use

# Build for multiple platforms
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag my-atomic-server:latest \
  --push \
  .
```

## Security Hardening

### Non-root User

```dockerfile
FROM debian:bookworm-slim

# Create user and group
RUN groupadd -r -g 1000 atomic && \
    useradd -r -g atomic -u 1000 -d /app -s /sbin/nologin atomic

# Create directories with proper ownership
RUN mkdir -p /atomic-storage /app && \
    chown -R atomic:atomic /atomic-storage /app

# Copy binary with correct ownership
COPY --from=builder --chown=atomic:atomic /atomic-server /usr/local/bin/atomic-server

USER atomic
WORKDIR /app
```

### Minimal Dependencies

```dockerfile
# Install only essential packages
RUN apt-get update && apt-get install -y \
    --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean
```

## Production Examples

### Docker Compose with Custom Image

```yaml
version: '3.8'

services:
  atomic-server:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        FEATURES: "https,telemetry"
    container_name: atomic-server
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - atomic-data:/atomic-storage
    environment:
      - ATOMIC_DOMAIN=localhost
      - ATOMIC_LOG_LEVEL=info
    healthcheck:
      test: ["CMD", "atomic-server", "--version"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  atomic-data:
```

### Kubernetes Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: atomic-server
spec:
  replicas: 1
  selector:
    matchLabels:
      app: atomic-server
  template:
    metadata:
      labels:
        app: atomic-server
    spec:
      containers:
      - name: atomic-server
        image: my-atomic-server:latest
        ports:
        - containerPort: 8080
        env:
        - name: ATOMIC_DATA_DIR
          value: "/atomic-storage/data"
        volumeMounts:
        - name: atomic-storage
          mountPath: /atomic-storage
        resources:
          requests:
            memory: "256Mi"
            cpu: "250m"
          limits:
            memory: "1Gi"
            cpu: "1"
      volumes:
      - name: atomic-storage
        persistentVolumeClaim:
          claimName: atomic-pvc
```

## Image Size Comparison

| Base Image | Final Size | Security | Debugging |
|------------|------------|----------|-----------|
| **debian:bookworm-slim** | ~80MB | Good | Easy |
| **alpine:latest** | ~60MB | Good | Medium |
| **distroless/cc** | ~40MB | Excellent | Hard |
| **scratch** | ~30MB | Excellent | None |

## Troubleshooting

### Build Issues

```bash
# Install missing dependencies
RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libsqlite3-dev

# For Alpine
RUN apk add --no-cache \
    musl-dev \
    pkgconfig \
    openssl-dev
```

### Runtime Issues

```bash
# Check logs
docker logs <container-id>

# Debug inside container
docker exec -it <container-id> /bin/bash

# Check permissions
docker exec <container-id> ls -la /atomic-storage
```

### Performance Optimization

```dockerfile
# Enable LTO for smaller binaries
ENV RUSTFLAGS="-C lto=fat"

# Use release profile
RUN cargo build --release --bin atomic-server

# Strip debug symbols
RUN strip /usr/local/bin/atomic-server
```

## Best Practices

1. **Use multi-stage builds** for smaller images
2. **Pin base image versions** for reproducibility
3. **Cache dependencies** separately from source
4. **Run as non-root** for security
5. **Include health checks** for orchestration
6. **Use .dockerignore** to exclude unnecessary files
7. **Scan for vulnerabilities** in CI pipeline
8. **Tag images** with version information