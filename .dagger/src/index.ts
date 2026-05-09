import {
  dag,
  Container,
  Directory,
  object,
  func,
  argument,
  Secret,
  File,
  Platform,
  Service,
  CacheSharingMode,
} from '@dagger.io/dagger';

const NODE_IMAGE = 'node:22';
const RUST_IMAGE = 'rust:bookworm';

// Must match `@playwright/test` in `browser/e2e/package.json`. A mismatch
// makes the chromium browser binary missing inside the container — every
// test times out at `page.goto`.
const PLAYWRIGHT_VERSION = 'v1.58.2-noble';
// See https://github.com/rust-cross/rust-musl-cross?tab=readme-ov-file#prebuilt-images
const TARGET_IMAGE_MAP = {
  'x86_64-unknown-linux-musl': 'ghcr.io/rust-cross/rust-musl-cross:x86_64-musl',
  'aarch64-unknown-linux-musl':
    'ghcr.io/rust-cross/rust-musl-cross:aarch64-musl',
  'armv7-unknown-linux-musleabihf':
    'ghcr.io/rust-cross/rust-musl-cross:armv7-musleabihf',
} as const;

// Service-binding alias the playwright container uses to reach
// atomic-server. Chromium hardcodes `*.localhost` to 127.0.0.1 (bypassing
// dagger's DNS injection) so we can't use a `.localhost` hostname here.
// The non-localhost hostname means the browser would NOT consider the
// origin a "secure context" by default — which is fatal because the SPA
// uses `crypto.subtle` to initialize its WASM ClientDb. We pass
// `--unsafely-treat-insecure-origin-as-secure=http://atomic:9883` to
// chromium below so the test browser exposes the secure-context APIs.
const ATOMIC_DOMAIN = 'atomic';

@object()
export class AtomicServer {
  source: Directory;

  constructor(
    @argument({
      defaultPath: '.',
      ignore: [
        '**/node_modules',
        '**/.git',
        '**/.github',
        '**/.husky',
        '**/.vscode',
        // rust
        '**/target',
        '**/artifact',
        // browser
        '**/.swc',
        '**/.netlify',
        // e2e
        '**/test-results',
        '**/template-tests',
        '**/playwright-report',
        '**/tmp',
        '**/.temp',
        '**/.cargo',
        '**/.DS_Store',
        '**/.vscode',
        '**/dist',
        '**/assets_tmp',
        '**/build',
        '**/.env',
        '**/.envrc',
        '**/bin',
      ],
    })
    source: Directory,
  ) {
    this.source = source;
  }

  @func()
  async ci(@argument() netlifyAuthToken: Secret): Promise<string> {
    // Rust tasks (test/clippy/fmt) all extend `rustBuild()` and share the
    // `rust-target` cache mount. Running them via `Promise.all` makes the
    // parallel cargo processes fight for cargo's per-target file lock —
    // we observed ~16-minute lock waits ending in `exit 101`. Serialize
    // the rust pipeline (cheap: build is cached after the first run),
    // and parallelize only the genuinely-independent JS + publish work.
    await Promise.all([
      this.docsPublish(netlifyAuthToken),
      this.typedocPublish(netlifyAuthToken),
      this.endToEnd(netlifyAuthToken),
      this.jsLint(),
      this.jsTest(),
      this.jsTestIntegration(),
      (async () => {
        await this.rustFmt();
        await this.rustClippy();
        await this.rustTest();
      })(),
    ]);

    return 'CI pipeline completed successfully';
  }

  @func()
  async jsLint(): Promise<string> {
    const depsContainer = this.jsBuild();
    return depsContainer
      .withWorkdir('/app')
      .withExec(['pnpm', 'run', 'lint'])
      .stdout();
  }

  @func()
  async jsTest(): Promise<string> {
    const depsContainer = this.jsBuild();
    return depsContainer
      .withWorkdir('/app')
      .withExec(['pnpm', 'run', 'test'])
      .stdout();
  }

  /** Builds the WASM bundle (wasm-pack) used by `NodeClientDb` in the
   *  `@tomic/lib` integration tests. Returns a Directory containing the
   *  emitted `pkg/` artifacts. */
  @func()
  wasmBuild(): Directory {
    const cargoCache = dag.cacheVolume('cargo');
    return dag
      .container()
      .from(RUST_IMAGE)
      .withMountedCache('/usr/local/cargo/registry', cargoCache, { sharing: CacheSharingMode.Locked })
      .withExec(['cargo', 'install', 'wasm-pack'])
      .withFile('/code/Cargo.toml', this.source.file('Cargo.toml'))
      .withFile('/code/Cargo.lock', this.source.file('Cargo.lock'))
      // wasm-pack runs `cargo metadata` which validates every workspace
      // member, so all members must be present even though we only build
      // the wasm crate.
      .withDirectory('/code/lib', this.source.directory('lib'))
      .withDirectory('/code/wasm', this.source.directory('wasm'))
      .withDirectory('/code/server', this.source.directory('server'))
      .withDirectory('/code/cli', this.source.directory('cli'))
      .withDirectory('/code/desktop', this.source.directory('desktop'))
      .withDirectory(
        '/code/plugin-examples',
        this.source.directory('plugin-examples'),
      )
      .withDirectory(
        '/code/atomic-plugin',
        this.source.directory('atomic-plugin'),
      )
      .withMountedCache('/code/target', dag.cacheVolume('rust-wasm-target'))
      .withWorkdir('/code/wasm')
      // `getrandom_backend=wasm_js` matches data-browser's `build:wasm` script.
      .withEnvVariable(
        'CARGO_ENCODED_RUSTFLAGS',
        '--cfggetrandom_backend="wasm_js"',
      )
      .withExec([
        'wasm-pack',
        'build',
        '--target',
        'web',
        '--out-dir',
        'pkg',
      ])
      .directory('/code/wasm/pkg');
  }

  /** Builds the `atomic-server` binary without depending on a built
   *  data-browser bundle. `ATOMICSERVER_SKIP_JS_BUILD=true` short-circuits
   *  `server/build.rs`'s JS bundling step. Sufficient for headless API
   *  tests that don't render the front-end. */
  @func()
  rustBuildSlim(): File {
    const cargoCache = dag.cacheVolume('cargo');
    return dag
      .container()
      .from(RUST_IMAGE)
      .withMountedCache('/usr/local/cargo/registry', cargoCache, { sharing: CacheSharingMode.Locked })
      .withFile('/code/Cargo.toml', this.source.file('Cargo.toml'))
      .withFile('/code/Cargo.lock', this.source.file('Cargo.lock'))
      .withDirectory('/code/server', this.source.directory('server'))
      .withDirectory('/code/lib', this.source.directory('lib'))
      .withDirectory('/code/cli', this.source.directory('cli'))
      .withDirectory('/code/desktop', this.source.directory('desktop'))
      .withDirectory('/code/wasm', this.source.directory('wasm'))
      .withDirectory(
        '/code/plugin-examples',
        this.source.directory('plugin-examples'),
      )
      .withDirectory(
        '/code/atomic-plugin',
        this.source.directory('atomic-plugin'),
      )
      .withMountedCache('/code/target', dag.cacheVolume('rust-slim-target'))
      .withWorkdir('/code')
      .withEnvVariable('ATOMICSERVER_SKIP_JS_BUILD', 'true')
      // build.rs still wants to bundle the data-browser dist as embedded
      // static files. Skipping the JS build is fine — but we still need
      // *some* directory to satisfy `static_files::resource_dir`. Drop a
      // placeholder index.html so the macro has something to embed.
      .withExec(['mkdir', '-p', '/code/server/assets_tmp'])
      .withExec([
        'sh',
        '-c',
        'echo "<html><body>integration test stub</body></html>" > /code/server/assets_tmp/index.html',
      ])
      .withExec(['cargo', 'build', '-p', 'atomic-server'])
      .withExec([
        'cp',
        '/code/target/debug/atomic-server',
        '/atomic-server-binary',
      ])
      .file('/atomic-server-binary');
  }

  /** Runs the `@tomic/lib` integration tests, which spawn a real
   *  `atomic-server` and use `NodeClientDb`. Both artefacts (binary + WASM)
   *  come from the Rust workspace and are mounted at the paths the fixture
   *  (`browser/lib/tests/server-fixture.ts`) resolves relative to the repo
   *  root.
   *
   *  Builds a minimal JS environment from scratch instead of reusing
   *  `jsBuild()` — the full workspace build runs data-browser's `build:wasm`
   *  step which expects the wasm source mounted, while these tests only
   *  need `@tomic/lib`'s source + node_modules. */
  @func()
  async jsTestIntegration(): Promise<string> {
    const binary = this.rustBuildSlim();
    const wasmPkg = this.wasmBuild();

    const browser = this.source.directory('browser');
    const pnpmContainer = dag
      .container()
      .from(NODE_IMAGE)
      .withExec(['npm', 'install', '--global', 'corepack@latest'])
      .withExec(['corepack', 'enable'])
      .withExec(['corepack', 'prepare', 'pnpm@latest-10', '--activate'])
      .withWorkdir('/repo/browser');

    // Mount workspace package manifests for caching and `pnpm install`.
    const installed = pnpmContainer
      .withFile('/repo/browser/package.json', browser.file('package.json'))
      .withFile('/repo/browser/pnpm-lock.yaml', browser.file('pnpm-lock.yaml'))
      .withFile(
        '/repo/browser/pnpm-workspace.yaml',
        browser.file('pnpm-workspace.yaml'),
      )
      .withFile(
        '/repo/browser/data-browser/package.json',
        browser.file('data-browser/package.json'),
      )
      .withFile(
        '/repo/browser/lib/package.json',
        browser.file('lib/package.json'),
      )
      .withFile(
        '/repo/browser/react/package.json',
        browser.file('react/package.json'),
      )
      .withFile(
        '/repo/browser/svelte/package.json',
        browser.file('svelte/package.json'),
      )
      .withFile(
        '/repo/browser/cli/package.json',
        browser.file('cli/package.json'),
      )
      .withFile(
        '/repo/browser/create-template/package.json',
        browser.file('create-template/package.json'),
      )
      .withFile(
        '/repo/browser/plugin/package.json',
        browser.file('plugin/package.json'),
      )
      .withFile(
        '/repo/browser/e2e/package.json',
        browser.file('e2e/package.json'),
      )
      // The lib's tsconfig.json extends the workspace-level tsconfigs.
      .withFile(
        '/repo/browser/tsconfig.json',
        browser.file('tsconfig.json'),
      )
      .withFile(
        '/repo/browser/tsconfig.build.json',
        browser.file('tsconfig.build.json'),
      )
      .withExec([
        'sh',
        '-c',
        'yes | pnpm install --frozen-lockfile --shamefully-hoist',
      ]);

    // Drop in @tomic/lib source. Other packages are unused by the
    // integration tests, so we don't bother mounting them.
    const withSource = installed.withDirectory(
      '/repo/browser/lib',
      browser.directory('lib'),
    );

    return withSource
      .withFile('/repo/target/debug/atomic-server', binary, {
        permissions: 0o755,
      })
      .withDirectory('/repo/wasm/pkg', wasmPkg)
      .withWorkdir('/repo/browser/lib')
      .withExec(['pnpm', 'run', 'test:integration'])
      .stdout();
  }

  @func()
  docsPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const builtDocsHtml = this.docsFolder();
    return this.netlifyDeploy(builtDocsHtml, 'atomic-docs', netlifyAuthToken);
  }

  private netlifyDeploy(
    /** The directory to deploy */
    directory: Directory,
    siteName: string,
    netlifyAuthToken: Secret,
  ): Promise<string> {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec(['npm', 'install', '-g', 'netlify-cli'])
      .withDirectory('/deploy', directory)
      .withWorkdir('/deploy')
      .withSecretVariable('NETLIFY_AUTH_TOKEN', netlifyAuthToken)
      .withExec([
        'sh',
        '-c',
        // Skip silently when no auth token is configured (PR builds from
        // forks, branches without secret access). Netlify CLI 23+ rejects
        // empty `--auth ""` instead of treating it as missing.
        `if [ -z "$NETLIFY_AUTH_TOKEN" ]; then echo 'NETLIFY_AUTH_TOKEN not set — skipping ${siteName} deploy'; exit 0; fi; for i in $(seq 1 5); do netlify link --name ${siteName} --auth "$NETLIFY_AUTH_TOKEN" && break || sleep 2; done && netlify deploy --dir . --prod --auth "$NETLIFY_AUTH_TOKEN"`,
      ])
      .stdout();
  }

  /** Extracts the unique deploy URL from netlify output */
  private extractDeployUrl(netlifyOutput: string): string {
    const match = netlifyOutput.match(/https:\/\/[a-f0-9]+--.+\.netlify\.app/);
    return match ? match[0] : 'Deploy URL not found';
  }

  @func()
  docsFolder(): Directory {
    const mdBookContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(['cargo', 'install', 'mdbook'])
      .withExec(['cargo', 'install', 'mdbook-linkcheck']);

    const actualDocsDirectory = this.source.directory('docs');

    return mdBookContainer
      .withMountedDirectory('/docs', actualDocsDirectory)
      .withWorkdir('/docs')
      .withExec(['mdbook', 'build'])
      .directory('/docs/build');
  }

  @func()
  typedocPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const browserDir = this.jsBuild();
    return browserDir
      .withWorkdir('/app')
      .withSecretVariable('NETLIFY_AUTH_TOKEN', netlifyAuthToken)
      .withExec(['pnpm', 'run', 'typedoc-publish'])
      .stdout();
  }

  @func()
  private jsBuild(e2e: boolean = false): Container {
    const browser = this.source.directory('browser');
    // Create a container with PNPM installed
    const pnpmContainer = dag
      .container()
      .from(NODE_IMAGE)
      .withExec(['npm', 'install', '--global', 'corepack@latest'])
      .withExec(['corepack', 'enable'])
      .withExec(['corepack', 'prepare', 'pnpm@latest-10', '--activate'])
      .withWorkdir('/app');

    // Copy workspace files first for caching node_modules.
    const workspaceContainer = pnpmContainer
      .withFile('/app/package.json', browser.file('package.json'))
      .withFile('/app/pnpm-lock.yaml', browser.file('pnpm-lock.yaml'))
      .withFile('/app/pnpm-workspace.yaml', browser.file('pnpm-workspace.yaml'))
      .withFile(
        '/app/data-browser/package.json',
        browser.file('data-browser/package.json'),
      )
      .withFile('/app/lib/package.json', browser.file('lib/package.json'))
      .withFile('/app/react/package.json', browser.file('react/package.json'))
      .withFile('/app/svelte/package.json', browser.file('svelte/package.json'))
      .withFile('/app/cli/package.json', browser.file('cli/package.json'))
      .withFile(
        '/app/create-template/package.json',
        browser.file('create-template/package.json'),
      )
      .withFile('/app/plugin/package.json', browser.file('plugin/package.json'))
      .withFile('/app/e2e/package.json', browser.file('e2e/package.json'))
      // .withMountedCache('/app/.pnpm-store', dag.cacheVolume('pnpm-store'))
      .withExec([
        'sh',
        '-c',
        'yes | pnpm install --frozen-lockfile --shamefully-hoist',
      ]);

    // data-browser bootstrap JSON lives in repo-root lib/defaults. Vite resolves ../../../lib
    // from data-browser/src to filesystem /lib if /app is only browser — do not mount there
    // (it overwrites OS /lib). Mount alongside browser and resolve via alias in vite.config.
    const sourceContainer = workspaceContainer
      .withDirectory('/app', browser)
      .withDirectory(
        '/app/lib-defaults',
        this.source.directory('lib/defaults'),
      )
      // Provide the prebuilt WASM artifacts so data-browser's `build:wasm`
      // step can be skipped (`wasm-pack` isn't available in this Node-only
      // container, and mounting the Rust toolchain just for this would
      // bloat the JS image significantly).
      .withDirectory('/app/data-browser/public/wasm', this.wasmBuild())
      // data-browser imports the repo-root logo from `../../../../logo.svg`
      // and `../../../../../logo.svg`. Browser mount sits at /app, so those
      // resolve to /logo.svg. Place the asset there.
      .withFile('/logo.svg', this.source.file('logo.svg'));

    // Build all packages since they may depend on each other's built artifacts
    let buildContainer = sourceContainer.withEnvVariable('SKIP_WASM_BUILD', '1');

    if (e2e) {
      // Surfaces /app/dev-drive and /app/prunetests in the production
      // build the e2e tests run against. See `devRoutesEnabled()` in
      // data-browser/src/config.ts.
      buildContainer = buildContainer.withEnvVariable('VITE_E2E', 'true');
    }

    return buildContainer.withExec(['pnpm', 'run', 'build']);
  }

  @func()
  /** Builds the Rust server binary on the host architecture */
  rustBuild(
    @argument() release: boolean = true,
    @argument() target: string = 'x86_64-unknown-linux-musl',
    @argument() e2e: boolean = false,
  ): Container {
    const source = this.source;
    const cargoCache = dag.cacheVolume('cargo');

    const image = TARGET_IMAGE_MAP[target as keyof typeof TARGET_IMAGE_MAP];

    const rustContainer = dag
      .container()
      .from(image)
      .withExec(['apt-get', 'update', '-qq'])
      .withExec(['apt', 'install', '-y', 'nasm'])
      .withMountedCache('/usr/local/cargo/registry', cargoCache, { sharing: CacheSharingMode.Locked })
      .withExec(['rustup', 'component', 'add', 'clippy'])
      .withExec(['rustup', 'component', 'add', 'rustfmt']);
    // cargo-nextest used to be installed here, but recent versions need
    // a newer toolchain than the musl-cross image ships and a USDT crate
    // refuses to compile on this target. Moved to `rustTest()` so the
    // build / clippy / fmt / atomicService paths don't pay that cost.

    const sourceContainer = rustContainer
      .withFile('/code/Cargo.toml', source.file('Cargo.toml'))
      .withFile('/code/Cargo.lock', source.file('Cargo.lock'))
      .withFile('/code/Cross.toml', source.file('Cross.toml'))
      // Nextest reads `.config/nextest.toml` from the workspace root.
      // Without this the override that bumps the flaky search test's
      // retries silently doesn't apply — symptom: dagger reports a hard
      // FAIL with no `FLAKY` indicator while the same test recovers
      // locally on retry.
      .withFile(
        '/code/.config/nextest.toml',
        source.file('.config/nextest.toml'),
      )
      // Cargo validates every workspace member listed in Cargo.toml, so
      // mount all of them — not just the server/lib/cli we actually
      // build.
      .withDirectory('/code/server', source.directory('server'))
      .withDirectory('/code/lib', source.directory('lib'))
      .withDirectory('/code/cli', source.directory('cli'))
      .withDirectory('/code/desktop', source.directory('desktop'))
      .withDirectory('/code/wasm', source.directory('wasm'))
      .withDirectory(
        '/code/plugin-examples',
        source.directory('plugin-examples'),
      )
      .withDirectory('/code/atomic-plugin', source.directory('atomic-plugin'))
      .withMountedCache('/code/target', dag.cacheVolume('rust-target'))
      .withWorkdir('/code')
      .withExec(['cargo', 'fetch']);

    const browserDir = this.jsBuild(e2e).directory('/app/data-browser/dist');
    const containerWithAssets = sourceContainer.withDirectory(
      '/code/server/assets_tmp',
      browserDir,
    );

    // Scope the build to `atomic-server` so cargo doesn't try to build
    // workspace siblings like the wasm cdylib plugin examples — which
    // can't be compiled for the host musl target.
    const buildArgs = release
      ? ['cargo', 'build', '--release', '-p', 'atomic-server']
      : ['cargo', 'build', '-p', 'atomic-server'];
    const targetPath = release
      ? `/code/target/${target}/release/atomic-server`
      : `/code/target/${target}/debug/atomic-server`;

    return (
      containerWithAssets
        .withExec(buildArgs)
        // .withExec([targetPath, "--version"])
        .withExec(['cp', targetPath, '/atomic-server-binary'])
    );
  }

  @func()
  /** Returns the release binary */
  rustBuildRelease(
    @argument() target: string = 'x86_64-unknown-linux-musl',
  ): File {
    const container = this.rustBuild(true, target);
    return container.file('/atomic-server-binary');
  }

  /**
   * Source-only rust container for `cargo fmt --check` / `cargo clippy`
   * / `cargo nextest run`. Same workspace inputs as {@link rustBuild}
   * but **without** the data-browser asset bundle (`assets_tmp`) and
   * without `cargo build`. The asset bundle was a hidden invalidation
   * trigger: any JS-source change rebuilt the assets, which busted the
   * dagger op-cache for fmt/clippy/test even though those steps don't
   * read the bundle. Splitting them off lets a JS-only commit cache-
   * hit through the entire rust pipeline.
   *
   * Uses its own `rust-checks-target` cache volume so it shares
   * incremental compile artifacts across fmt → clippy → test (they run
   * sequentially in `ci`) without contending with the release-binary
   * build's `rust-target`.
   */
  private rustChecksContainer(): Container {
    const source = this.source;
    const cargoCache = dag.cacheVolume('cargo');
    const image = TARGET_IMAGE_MAP['x86_64-unknown-linux-musl'];

    return dag
      .container()
      .from(image)
      .withExec(['apt-get', 'update', '-qq'])
      .withExec(['apt', 'install', '-y', 'nasm'])
      .withMountedCache('/usr/local/cargo/registry', cargoCache, {
        sharing: CacheSharingMode.Locked,
      })
      .withExec(['rustup', 'component', 'add', 'clippy'])
      .withExec(['rustup', 'component', 'add', 'rustfmt'])
      .withFile('/code/Cargo.toml', source.file('Cargo.toml'))
      .withFile('/code/Cargo.lock', source.file('Cargo.lock'))
      .withFile('/code/Cross.toml', source.file('Cross.toml'))
      .withFile(
        '/code/.config/nextest.toml',
        source.file('.config/nextest.toml'),
      )
      .withDirectory('/code/server', source.directory('server'))
      .withDirectory('/code/lib', source.directory('lib'))
      .withDirectory('/code/cli', source.directory('cli'))
      .withDirectory('/code/desktop', source.directory('desktop'))
      .withDirectory('/code/wasm', source.directory('wasm'))
      .withDirectory(
        '/code/plugin-examples',
        source.directory('plugin-examples'),
      )
      .withDirectory('/code/atomic-plugin', source.directory('atomic-plugin'))
      .withMountedCache('/code/target', dag.cacheVolume('rust-checks-target'))
      .withWorkdir('/code')
      // build.rs in atomic-server wants to bundle a JS dist. Skip it —
      // fmt/clippy/test don't need it and including the bundle would
      // re-introduce the JS-source dependency we just removed.
      .withEnvVariable('ATOMICSERVER_SKIP_JS_BUILD', 'true')
      .withExec(['mkdir', '-p', '/code/server/assets_tmp'])
      .withExec([
        'sh',
        '-c',
        'echo "<html><body>checks stub</body></html>" > /code/server/assets_tmp/index.html',
      ])
      .withExec(['cargo', 'fetch']);
  }

  @func()
  rustTest(): Promise<string> {
    return (
      this.rustChecksContainer()
        // Install nextest from a prebuilt tarball — the `cargo install`
        // path fails on the musl-cross image. The `linux-musl` URL is
        // required: the default `linux` artifact is the glibc binary,
        // which silently exits 1 on the musl-cross container (cargo
        // then reports "no such command: nextest" because the
        // subcommand returned nonzero). Place the binary in
        // `$CARGO_HOME/bin` (resolved at runtime — the rust-musl-cross
        // image puts it under /root/.cargo, the official rust:bookworm
        // under /usr/local/cargo).
        .withExec([
          'sh',
          '-c',
          'BIN_DIR="${CARGO_HOME:-$HOME/.cargo}/bin" && mkdir -p "$BIN_DIR" && curl -LsSf https://get.nexte.st/latest/linux-musl | tar zxf - -C "$BIN_DIR" && "$BIN_DIR/cargo-nextest" --version',
        ])
        // `--exclude atomic-server-tauri`: same reason as `rustClippy` —
        // the Tauri desktop crate needs system libs (glib-2.0, pkg-config)
        // that aren't installed in the musl-cross CI image.
        .withExec([
          'cargo',
          'nextest',
          'run',
          '--workspace',
          '--exclude',
          'atomic-server-tauri',
        ])
        .stdout()
    );
  }

  @func()
  rustClippy(): Promise<string> {
    // Exclude `desktop` (Tauri) — its build pulls in `glib-sys`, which
    // requires `pkg-config` + `glib-2.0` dev libraries that the musl-cross
    // CI image doesn't carry. The desktop crate is built separately via the
    // Tauri toolchain on platforms that have those system libs.
    //
    // Drop `--all-features` to keep the build inside what the musl-cross
    // image can satisfy: enabling every feature pulls in optional deps
    // (e.g. `openssl-sys` via some opentelemetry / TLS feature) that need
    // system OpenSSL we don't ship. Default features are what the release
    // binary already builds with.
    return this.rustChecksContainer()
      .withExec([
        'cargo',
        'clippy',
        '--workspace',
        '--exclude',
        'atomic-server-tauri',
        '--no-deps',
        '--all-targets',
      ])
      .stdout();
  }

  @func()
  rustFmt(): Promise<string> {
    // Fmt only reads source — runs against the source-only checks
    // container so a JS-source change can't bust its dagger op-cache.
    return this.rustChecksContainer()
      .withExec(['cargo', 'fmt', '--check'])
      .stdout();
  }

  // @func()
  // /** Doesn't work on M1 macs */
  // rustCrossBuild(@argument() target: string): Container {
  //   let engineSvc = dag.docker().engine();
  //   const source = this.source;

  //   const sourceContainer = dag
  //     // To allow cross-compilation to work on M1 macs
  //     .container({ platform: "linux/amd64" as Platform })
  //     .from("docker:cli")
  //     .withServiceBinding("docker", engineSvc)
  //     .withEnvVariable("DOCKER_HOST", "tcp://docker:2375")
  //     .withExec(["docker", "ps"])
  //     .withExec([
  //       "apk",
  //       "add",
  //       "--no-cache",
  //       // For installing rust
  //       "curl",
  //       // CC linker deps, compiling cross
  //       "build-base",
  //       "gcc",
  //       "musl-dev",
  //       "cmake",
  //     ])
  //     .withExec([
  //       "sh",
  //       "-c",
  //       "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable",
  //     ])
  //     .withEnvVariable(
  //       "PATH",
  //       "/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  //     )
  //     .withExec(["docker", "ps"])
  //     .withExec(["cargo", "install", "cross"])
  //     .withExec(["rustup", "target", "add", target])
  //     .withExec([
  //       "rustup",
  //       "toolchain",
  //       "add",
  //       "stable-x86_64-unknown-linux-gnu",
  //       "--profile",
  //       "minimal",
  //       "--force-non-host",
  //     ])
  //     .withFile("/home/rust/src/Cargo.toml", source.file("Cargo.toml"))
  //     .withFile("/home/rust/src/Cargo.lock", source.file("Cargo.lock"))
  //     .withDirectory("/home/rust/src/server", source.directory("server"))
  //     .withDirectory("/home/rust/src/lib", source.directory("lib"))
  //     .withDirectory("/home/rust/src/cli", source.directory("cli"))
  //     .withMountedCache("/home/rust/src/target", dag.cacheVolume("rust-target"))
  //     .withWorkdir("/home/rust/src");

  //   // Include frontend assets for the server build
  //   const browserDir = this.jsBuild().directory("/app/data-browser/dist");
  //   const containerWithAssets = sourceContainer.withDirectory(
  //     "/home/rust/src/server/assets_tmp",
  //     browserDir
  //   );

  //   // Build using native cargo with target specification
  //   const binaryPath = `./target/${target}/release/atomic-server`;

  //   return containerWithAssets
  //     .withExec(["cross", "build", "--target", target, "--release"])
  //     .withExec(["cp", binaryPath, "/atomic-server-binary"]);
  // }

  /** Diagnostic: navigate Playwright to /app/dev-drive against the atomic
   *  service and dump console messages + network failures. */
  @func()
  async probeDevDrive(): Promise<string> {
    return dag
      .container()
      .from(`mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}`)
      .withExec(['npm', 'install', '-g', 'playwright@1.58.2'])
      .withExec(['npx', 'playwright', 'install', 'chromium'])
      .withServiceBinding('atomic', this.atomicService(true))
      .withNewFile(
        '/probe.js',
        `const { chromium } = require('/usr/lib/node_modules/playwright');
(async () => {
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP atomic.localhost ${ATOMIC_DOMAIN}'],
  });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', m => logs.push('[console:' + m.type() + '] ' + m.text()));
  page.on('pageerror', e => logs.push('[pageerror] ' + e.message));
  page.on('requestfailed', r => logs.push('[reqfail] ' + r.url() + ' ' + r.failure()?.errorText));
  try {
    await page.goto('http://atomic.localhost:9883/app/dev-drive', { waitUntil: 'networkidle', timeout: 20000 });
  } catch (e) {
    logs.push('[goto error] ' + e.message);
  }
  await new Promise(r => setTimeout(r, 15000));
  logs.push('[final url] ' + page.url());
  const crypto = await page.evaluate(() => ({
    isSecureContext: window.isSecureContext,
    hasSubtle: !!(window.crypto && window.crypto.subtle),
    hasDigest: !!(window.crypto && window.crypto.subtle && window.crypto.subtle.digest),
  }));
  logs.push('[crypto] ' + JSON.stringify(crypto));
  console.log(logs.join('\\n'));
  await browser.close();
})();`,
      )
      .withExec([
        'sh',
        '-c',
        `for i in $(seq 1 20); do curl -fsS http://${ATOMIC_DOMAIN}:9883/setup -H 'Accept: application/ad+json' && break || sleep 1; done; node /probe.js`,
      ])
      .stdout();
  }

  /** Diagnostic: curl `/app/dev-drive` against the atomic service to see
   *  what the e2e tests actually receive. */
  @func()
  async probeAtomicService(): Promise<string> {
    return dag
      .container()
      .from('alpine:latest')
      .withExec(['apk', 'add', '--no-cache', 'curl'])
      .withServiceBinding('atomic', this.atomicService())
      .withExec([
        'sh',
        '-c',
        `for i in $(seq 1 20); do curl -fsS http://${ATOMIC_DOMAIN}:9883/setup -H 'Accept: application/ad+json' && break || sleep 1; done; ` +
          `echo '== /app/dev-drive headers ==='; ` +
          `curl -sS -D - -o /dev/null -H 'Accept: text/html' http://${ATOMIC_DOMAIN}:9883/app/dev-drive; ` +
          `echo '== /assets/index js HEAD ==='; ` +
          `JS=$(curl -sS -H 'Accept: text/html' http://${ATOMIC_DOMAIN}:9883/app/dev-drive | grep -oE 'src="/assets/index[^"]+"' | head -1 | sed 's/src="//;s/"//'); ` +
          `echo "JS path: $JS"; ` +
          `curl -sS -D - -o /dev/null http://${ATOMIC_DOMAIN}:9883$JS; ` +
          `echo '== /app/welcome status ==='; ` +
          `curl -sS -o /dev/null -w 'status=%{http_code}\\n' -H 'Accept: text/html' http://${ATOMIC_DOMAIN}:9883/app/welcome`,
      ])
      .stdout();
  }

  @func()
  /** Returns a Service running atomic-server for use in tests */
  atomicService(@argument() e2e: boolean = false): Service {
    const atomicServerBinary = this.rustBuild(
      true,
      'x86_64-unknown-linux-musl',
      e2e,
    ).file('/atomic-server-binary');
    return dag
      .container()
      .from('alpine:latest')
      .withFile('/atomic-server-bin', atomicServerBinary, {
        permissions: 0o755,
      })
      .withEnvVariable('ATOMIC_DOMAIN', ATOMIC_DOMAIN)
      // First-run flag — sets up the bootstrap agent + public drive +
      // /app/dev-drive endpoint that the e2e tests' `beforeEach` relies on.
      // Without this, every test's `before()` hook times out fetching it.
      .withEnvVariable('ATOMIC_INITIALIZE', 'true')
      .withExposedPort(9883)
      .withEntrypoint(['/atomic-server-bin'])
      .asService()
      .withHostname(ATOMIC_DOMAIN);
  }

  @func()
  async endToEnd(@argument() netlifyAuthToken: Secret): Promise<string> {
    const browserContainer = this.jsBuild();

    // Setup Playwright container - debug and fix package manager
    const playwrightContainer = dag
      .container()
      .from(`mcr.microsoft.com/playwright:${PLAYWRIGHT_VERSION}`)
      .withExec([
        '/bin/sh',
        '-c',
        'curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=10.15.1 ENV="$HOME/.shrc" SHELL="$(which sh)" sh - && export PATH=/root/.local/share/pnpm:$PATH && /bin/apt update && /bin/apt install -y zip',
      ])
      .withEnvVariable(
        'PATH',
        '/root/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      )
      // .withExec(['pnpm', 'dlx', 'playwright', 'install', '--with-deps'])
      .withExec(['npm', 'install', '-g', 'netlify-cli']);

    // Setup e2e test environment
    const e2eContainer = playwrightContainer
      .withEnvVariable('CI', 'true')
      .withDirectory(
        '/app/e2e',
        this.source
          .directory('browser/e2e')
          .withoutDirectory('tests')
          .withoutDirectory('playwright-report')
          .withoutDirectory('node_modules')
          .withoutDirectory('test-results'),
      )
      .withWorkdir('/app/e2e')
      .withExec(['pnpm', 'install'])
      .withExec(['pnpm', 'exec', 'playwright', 'install'])
      .withDirectory('/app/cli', browserContainer.directory('/app/cli'))
      .withDirectory('/app/react', browserContainer.directory('/app/react'))
      .withDirectory('/app/svelte', browserContainer.directory('/app/svelte'))
      .withDirectory(
        '/app/create-template',
        browserContainer.directory('/app/create-template'),
      )
      .withDirectory('/app/lib', browserContainer.directory('/app/lib'))
      .withDirectory(
        '/app/node_modules',
        browserContainer.directory('/app/node_modules'),
      )
      .withEnvVariable('LANGUAGE', 'en_GB')
      // The browser hits a `*.localhost` URL so chromium considers it a
      // secure context (required for `crypto.subtle` → WASM ClientDb init).
      // The host-resolver rule below tells chromium to route that hostname
      // to the dagger `atomic` service binding, since chromium otherwise
      // hardcodes `*.localhost` to 127.0.0.1.
      .withEnvVariable('FRONTEND_URL', `http://atomic.localhost:9883`)
      .withEnvVariable('SERVER_URL', `http://atomic.localhost:9883`)
      .withEnvVariable(
        'ATOMIC_TEST_HOST_MAP',
        `MAP atomic.localhost ${ATOMIC_DOMAIN}`,
      )
      .withServiceBinding('atomic', this.atomicService(true))
      .withDirectory(
        '/app/e2e/tests',
        this.source.directory('browser/e2e/tests'),
      )
      // Wait for the server to be ready
      .withExec([
        'sh',
        '-c',
        `for i in $(seq 1 10); do curl http://${ATOMIC_DOMAIN}:9883/setup && exit 0 || sleep 1; done; exit 1`,
      ])
      // Test the server is running
      .withExec([
        '/bin/bash',
        '-c',
        'set -o pipefail; pnpm run test-e2e 2>&1 | tee /test-output.log; echo ${PIPESTATUS[0]} > /test-exit-code; exit 0',
      ]);

    // Extract the test results directory and upload to Netlify
    const testReportDirectory = e2eContainer.directory('playwright-report');
    const testOutput = await e2eContainer.file('/test-output.log').contents();
    const deployOutput = await this.netlifyDeploy(
      testReportDirectory,
      'atomic-tests',
      netlifyAuthToken,
    );

    // Extract the deploy URL
    const deployUrl = this.extractDeployUrl(deployOutput);

    // Check the test exit code and fail if tests failed
    const exitCode = await e2eContainer.file('/test-exit-code').contents();
    if (exitCode.trim() !== '0') {
      throw new Error(
        `E2E tests failed (exit code: ${exitCode.trim()}). Test report deployed to: \n${deployUrl}\n\n===== TEST OUTPUT (tail) =====\n${testOutput.slice(-60000)}\n===== END TEST OUTPUT =====`,
      );
    }

    return deployUrl;
  }

  @func()
  async deployServer(
    @argument() remoteHost: string,
    @argument() remoteUser: Secret,
    @argument() sshPrivateKey: Secret,
  ): Promise<string> {
    // Build the cross-compiled binary for x86_64-unknown-linux-musl
    const binaryFile = this.rustBuildRelease('x86_64-unknown-linux-musl');

    // Create deployment container with SSH client
    const deployContainer = dag
      .container()
      .from('alpine:latest')
      .withExec(['apk', 'add', '--no-cache', 'openssh-client', 'rsync'])
      .withFile('/atomic-server-binary', binaryFile, { permissions: 0o755 });

    // Setup SSH key
    const sshContainer = deployContainer
      .withExec(['mkdir', '-p', '/root/.ssh'])
      .withSecretVariable('SSH_PRIVATE_KEY', sshPrivateKey)
      .withExec(['sh', '-c', 'echo "$SSH_PRIVATE_KEY" > /root/.ssh/id_rsa'])
      .withExec(['chmod', '600', '/root/.ssh/id_rsa'])
      .withExec(['ssh-keyscan', '-H', remoteHost])
      .withExec([
        'sh',
        '-c',
        `ssh-keyscan -H ${remoteHost} >> /root/.ssh/known_hosts`,
      ]);

    // Transfer binary using rsync
    const transferResult = await sshContainer
      .withSecretVariable('REMOTE_USER', remoteUser)
      .withExec([
        'sh',
        '-c',
        `rsync -rltgoDzvO /atomic-server-binary $REMOTE_USER@${remoteHost}:~/atomic-server-x86_64-unknown-linux-musl`,
      ])
      .stdout();

    // Execute deployment commands on remote server
    const deployResult = await sshContainer
      .withSecretVariable('REMOTE_USER', remoteUser)
      .withExec([
        'sh',
        '-c',
        `ssh -i /root/.ssh/id_rsa $REMOTE_USER@${remoteHost} '
          mv ~/atomic-server-x86_64-unknown-linux-musl ~/atomic-server &&
          cp ~/atomic-server ~/atomic-server-$(date +"%Y-%m-%dT%H:%M:%S") &&
          systemctl stop atomic &&
          ./atomic-server export &&
          systemctl start atomic &&
          systemctl status atomic
        '`,
      ])
      .stdout();

    return `Deployment to ${remoteHost} completed successfully:\n${deployResult}`;
  }

  @func()
  async releaseAssets(): Promise<Directory> {
    const targets = Object.keys(TARGET_IMAGE_MAP);

    const builds = targets.map(target => {
      const container = this.rustBuild(true, target);
      return {
        target,
        binary: container.file('/atomic-server-binary'),
      };
    });

    // Create a directory with all the binaries
    let outputDir = dag.directory();

    for (const build of builds) {
      outputDir = outputDir.withFile(
        `atomic-server-${build.target}`,
        build.binary,
      );
    }

    return outputDir;
  }

  @func()
  /** Creates a Docker image for a specific target architecture */
  createDockerImage(
    @argument() target: string = 'x86_64-unknown-linux-musl',
  ): Container {
    const binary = this.rustBuild(true, target).file('/atomic-server-binary');

    // Map targets to their corresponding platform strings
    const platformMap = {
      'x86_64-unknown-linux-musl': 'linux/amd64' as Platform,
      'aarch64-unknown-linux-musl': 'linux/arm64' as Platform,
      'armv7-unknown-linux-musleabihf': 'linux/arm/v7' as Platform,
    };

    const platform = platformMap[target as keyof typeof platformMap];
    if (!platform) {
      throw new Error(`Unknown platform for target: ${target}`);
    }

    const innerImage = 'alpine:latest';

    // https://github.com/dagger/dagger/issues/9998
    const dir = dag.directory().withNewFile(
      'Dockerfile',
      `FROM ${innerImage}

VOLUME /atomic-storage
`,
    );

    return (
      dag
        .container({ platform })
        .build(dir)
        // .from(innerImage)
        .withFile('/usr/local/bin/atomic-server', binary)
        .withExec(['chmod', '+x', '/usr/local/bin/atomic-server'])
        .withEntrypoint(['/usr/local/bin/atomic-server'])
        .withEnvVariable('ATOMIC_DATA_DIR', '/atomic-storage/data')
        .withEnvVariable('ATOMIC_CONFIG_DIR', '/atomic-storage/config')
        .withEnvVariable('ATOMIC_PORT', '80')
        .withExposedPort(80)
        .withDefaultArgs([])
    );
  }

  @func()
  /** Creates Docker images for all supported architectures */
  async createDockerImages(
    @argument() tags: string[] = ['develop'],
  ): Promise<void> {
    const targets = Object.keys(TARGET_IMAGE_MAP);

    // Build one variant first.
    let firstImageArchitecture = 'x86_64-unknown-linux-musl';
    const firstImage = this.createDockerImage(firstImageArchitecture);

    // Build other variants
    const otherVariants = targets
      .filter(target => target !== firstImageArchitecture)
      .map(target => this.createDockerImage(target));

    // Publish the multi-platform image with all variants
    for (const tag of tags) {
      await firstImage.publish(`joepmeneer/atomic-server:${tag}`, {
        platformVariants: otherVariants,
      });
    }
  }
}
