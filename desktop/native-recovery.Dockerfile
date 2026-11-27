# Same native WebKitGTK environment locally and on hosted CI. No host keychain,
# credentials or display is mounted. MinIO is built from the pinned upstream
# release source because its old public binary/image downloads were retired.
FROM golang:1.24.6-bookworm AS minio
RUN git init /src && cd /src \
    && git remote add origin https://github.com/minio/minio.git \
    && git fetch --depth=1 origin 07c3a429bfed433e49018cb0f78a52145d4bedeb \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = 07c3a429bfed433e49018cb0f78a52145d4bedeb \
    && (attempt=1; until go mod download; do \
        if [ "$attempt" -ge 3 ]; then exit 1; fi; \
        sleep "$((attempt * 2))"; attempt=$((attempt + 1)); \
    done) \
    && test "$(git rev-parse HEAD)" = 07c3a429bfed433e49018cb0f78a52145d4bedeb \
    && git diff --exit-code -- go.mod go.sum \
    && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /minio . \
    && test "$(git rev-parse HEAD)" = 07c3a429bfed433e49018cb0f78a52145d4bedeb \
    && git diff --exit-code -- go.mod go.sum

FROM node:22-bookworm AS node
FROM rust:1.98.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev \
    libayatana-appindicator3-dev libssl-dev libclang-dev clang lld \
    xvfb xauth dbus-x11 python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g pnpm@11.10.0 \
    && rustup target add wasm32-unknown-unknown
COPY --from=minio /minio /usr/local/bin/minio
ENV CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 \
    CARGO_INCREMENTAL=0 RUSTFLAGS="-C link-arg=-fuse-ld=lld" \
    ATOMICSERVER_SKIP_JS_BUILD=true
WORKDIR /code/atomic-server
CMD ["bash", "desktop/scripts/native-recovery/build-and-test.sh"]
