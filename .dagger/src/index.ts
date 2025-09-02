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
} from '@dagger.io/dagger';

const NODE_IMAGE = 'node:22';
const RUST_IMAGE = 'rust:bookworm';

const PLAYWRIGHT_VERSION = 'v1.49.1-noble';
// See https://github.com/rust-cross/rust-musl-cross?tab=readme-ov-file#prebuilt-images
const TARGET_IMAGE_MAP = {
  'x86_64-unknown-linux-musl': 'ghcr.io/rust-cross/rust-musl-cross:x86_64-musl',
  'aarch64-unknown-linux-musl':
    'ghcr.io/rust-cross/rust-musl-cross:aarch64-musl',
  'armv7-unknown-linux-musleabihf':
    'ghcr.io/rust-cross/rust-musl-cross:armv7-musleabihf',
} as const;

const ATOMIC_DOMAIN = 'localhost-atomic';

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
    await Promise.all([
      this.docsPublish(netlifyAuthToken),
      this.typedocPublish(netlifyAuthToken),
      this.endToEnd(netlifyAuthToken),
      this.jsLint(),
      this.jsTest(),
      this.rustTest(),
      this.rustClippy(),
      this.rustFmt(),
    ]);

    return 'CI pipeline completed successfully';
  }

  @func()
  async jsLint(): Promise<string> {
    const depsContainer = this.jsBuild(this.source.directory('browser'));
    return depsContainer
      .withWorkdir('/app')
      .withExec(['pnpm', 'run', 'lint'])
      .stdout();
  }

  @func()
  async jsTest(): Promise<string> {
    const depsContainer = this.jsBuild(this.source.directory('browser'));
    return depsContainer
      .withWorkdir('/app')
      .withExec(['pnpm', 'run', 'test'])
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
        `for i in $(seq 1 5); do netlify link --name ${siteName} --auth $NETLIFY_AUTH_TOKEN && break || sleep 2; done`,
      ])
      .withExec(['netlify', 'deploy', '--dir', '.', '--prod'])
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
      .directory('/docs/build/html');
  }

  @func()
  typedocPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const browserDir = this.jsBuild(this.source.directory('browser'));
    return browserDir
      .withWorkdir('/app')
      .withSecretVariable('NETLIFY_AUTH_TOKEN', netlifyAuthToken)
      .withExec(['pnpm', 'run', 'typedoc-publish'])
      .stdout();
  }

  @func()
  private jsBuild(
    @argument({ ignore: ['**/e2e'] }) source: Directory,
  ): Container {
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
      .withFile('/app/package.json', source.file('package.json'))
      .withFile('/app/pnpm-lock.yaml', source.file('pnpm-lock.yaml'))
      .withFile('/app/pnpm-workspace.yaml', source.file('pnpm-workspace.yaml'))
      .withFile(
        '/app/data-browser/package.json',
        source.file('data-browser/package.json'),
      )
      .withFile('/app/lib/package.json', source.file('lib/package.json'))
      .withFile('/app/react/package.json', source.file('react/package.json'))
      .withFile('/app/svelte/package.json', source.file('svelte/package.json'))
      .withFile('/app/cli/package.json', source.file('cli/package.json'))
      .withFile(
        '/app/create-template/package.json',
        source.file('create-template/package.json'),
      )
      // .withMountedCache('/app/.pnpm-store', dag.cacheVolume('pnpm-store'))
      .withExec([
        'sh',
        '-c',
        'yes | pnpm install --frozen-lockfile --shamefully-hoist',
      ]);

    // Copy the source so installed dependencies persist in the container
    const sourceContainer = workspaceContainer.withDirectory('/app', source);

    // Build all packages since they may depend on each other's built artifacts
    return sourceContainer.withExec(['pnpm', 'run', 'build']);
  }

  @func()
  /** Builds the Rust server binary on the host architecture */
  rustBuild(
    @argument() release: boolean = true,
    @argument() target: string = 'x86_64-unknown-linux-musl',
  ): Container {
    const source = this.source;
    const cargoCache = dag.cacheVolume('cargo');

    const image = TARGET_IMAGE_MAP[target as keyof typeof TARGET_IMAGE_MAP];

    const rustContainer = dag
      .container()
      .from(image)
      .withExec(['apt-get', 'update', '-qq'])
      .withExec(['apt', 'install', '-y', 'nasm'])
      .withMountedCache('/usr/local/cargo/registry', cargoCache)
      .withExec(['rustup', 'component', 'add', 'clippy'])
      .withExec(['rustup', 'component', 'add', 'rustfmt'])
      .withExec(['cargo', 'install', 'cargo-nextest']);

    const sourceContainer = rustContainer
      .withFile('/code/Cargo.toml', source.file('Cargo.toml'))
      .withFile('/code/Cargo.lock', source.file('Cargo.lock'))
      .withFile('/code/Cross.toml', source.file('Cross.toml'))
      .withDirectory('/code/server', source.directory('server'))
      .withDirectory('/code/lib', source.directory('lib'))
      .withDirectory('/code/cli', source.directory('cli'))
      .withMountedCache('/code/target', dag.cacheVolume('rust-target'))
      .withWorkdir('/code')
      .withExec(['cargo', 'fetch']);

    const browserDir = this.jsBuild(this.source.directory('browser')).directory(
      '/app/data-browser/dist',
    );
    const containerWithAssets = sourceContainer.withDirectory(
      '/code/server/assets_tmp',
      browserDir,
    );

    const buildArgs = release
      ? ['cargo', 'build', '--release']
      : ['cargo', 'build'];
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

  @func()
  rustTest(): Promise<string> {
    return this.rustBuild().withExec(['cargo', 'nextest', 'run']).stdout();
  }

  @func()
  rustClippy(): Promise<string> {
    const rustContainer = this.rustBuild();

    return rustContainer
      .withExec([
        'cargo',
        'clippy',
        '--no-deps',
        '--all-features',
        '--all-targets',
      ])
      .stdout();
  }

  @func()
  rustFmt(): Promise<string> {
    const rustContainer = this.rustBuild();

    return rustContainer.withExec(['cargo', 'fmt', '--check']).stdout();
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

  @func()
  /** Returns a Service running atomic-server for use in tests */
  atomicService(): Service {
    const atomicServerBinary = this.rustBuild().file('/atomic-server-binary');
    return dag
      .container()
      .from('alpine:latest')
      .withFile('/atomic-server-bin', atomicServerBinary, {
        permissions: 0o755,
      })
      .withEnvVariable('ATOMIC_DOMAIN', ATOMIC_DOMAIN)
      .withExposedPort(9883)
      .withEntrypoint(['/atomic-server-bin'])
      .asService()
      .withHostname(ATOMIC_DOMAIN);
  }

  @func()
  async endToEnd(@argument() netlifyAuthToken: Secret): Promise<string> {
    const browserContainer = this.jsBuild(this.source.directory('browser'));

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
      .withEnvVariable('DELETE_PREVIOUS_TEST_DRIVES', 'false')
      .withEnvVariable('FRONTEND_URL', `http://${ATOMIC_DOMAIN}:9883`)
      .withEnvVariable('SERVER_URL', `http://${ATOMIC_DOMAIN}:9883`)
      .withServiceBinding('atomic', this.atomicService())
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
        '/bin/sh',
        '-c',
        'pnpm run test-e2e; echo $? > /test-exit-code',
      ]);

    // Extract the test results directory and upload to Netlify
    const testReportDirectory = e2eContainer.directory('playwright-report');
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
        `E2E tests failed (exit code: ${exitCode.trim()}). Test report deployed to: \n${deployUrl}`,
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
