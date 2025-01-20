import {
  dag,
  Container,
  Directory,
  object,
  func,
  argument,
  Secret,
} from "@dagger.io/dagger";

const NODE_IMAGE = "node:24";
const RUST_IMAGE = "rust:bookworm";

@object()
export class AtomicServer {
  source: Directory;

  constructor(
    @argument({
      defaultPath: ".",
      ignore: [
        "**/node_modules",
        "**/.git",
        "**/.github",
        "**/.husky",
        "**/.vscode",
        // rust
        "**/target",
        "**/artifact",
        // browser
        "**/.swc",
        "**/.netlify",
        // e2e
        "**/test-results",
        "**/template-tests",
        "**/playwright-report",
        "**/tmp",
        "**/.temp",
        "**/.cargo",
        "**/.DS_Store",
        "**/.vscode",
        "**/dist",
        "**/assets_tmp",
        "**/build",
        "**/.env",
        "**/.envrc",
      ],
    })
    source: Directory
  ) {
    this.source = source;
  }

  @func()
  async ci(@argument() netlifyAuthToken: Secret): Promise<string> {
    await Promise.all([
      this.docsPublish(netlifyAuthToken),
      this.jsLint(),
      this.jsTest(),
      this.endToEnd(netlifyAuthToken),
      this.rustTest(),
      this.rustClippy(),
      this.rustFmt(),
    ]);

    return "CI pipeline completed successfully";
  }

  @func()
  async jsLint(): Promise<string> {
    const depsContainer = this.jsBuild();
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "lint"])
      .stdout();
  }

  @func()
  async jsTest(): Promise<string> {
    const depsContainer = this.jsBuild();
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "test"])
      .stdout();
  }

  @func()
  docsPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const builtDocsHtml = this.docsFolder();
    return this.netlifyDeploy(builtDocsHtml, "atomic-docs", netlifyAuthToken);
  }

  private netlifyDeploy(
    /** The directory to deploy */
    directory: Directory,
    siteName: string,
    netlifyAuthToken: Secret
  ): Promise<string> {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec(["npm", "install", "-g", "netlify-cli"])
      .withDirectory("/deploy", directory)
      .withWorkdir("/deploy")
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken)
      .withExec([
        "sh",
        "-c",
        `netlify link --name ${siteName} --auth $NETLIFY_AUTH_TOKEN`,
      ])
      .withExec(["netlify", "deploy", "--dir", ".", "--prod"])
      .stdout();
  }

  /** Extracts the unique deploy URL from netlify output */
  private extractDeployUrl(netlifyOutput: string): string {
    const match = netlifyOutput.match(/https:\/\/[a-f0-9]+--.+\.netlify\.app/);
    return match ? match[0] : "Deploy URL not found";
  }

  @func()
  docsFolder(): Directory {
    const cargoCache = dag.cacheVolume("cargo");

    const mdBookContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withMountedCache("/usr/local/cargo/registry", cargoCache)
      .withExec(["cargo", "install", "mdbook"])
      .withExec(["cargo", "install", "mdbook-linkcheck"]);

    const actualDocsDirectory = this.source.directory("docs");
    return mdBookContainer
      .withMountedDirectory("/docs", actualDocsDirectory)
      .withWorkdir("/docs")
      .withExec(["mdbook", "build"])
      .directory("/docs/build/html");
  }
  @func()
  typedocPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const browserDir = this.jsBuild();
    return browserDir
      .withWorkdir("/app")
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken)
      .withExec(["pnpm", "run", "typedoc-publish"])
      .stdout();
  }

  @func()
  private jsBuild(): Container {
    const source = this.source.directory("browser");

    // Create a container with PNPM installed
    const pnpmContainer = dag
      .container()
      .from(NODE_IMAGE)
      .withExec(["npm", "install", "--global", "corepack@latest"])
      .withExec(["corepack", "enable"])
      .withExec(["corepack", "prepare", "pnpm@latest-10", "--activate"])
      .withWorkdir("/app");

    // Copy workspace files first
    const workspaceContainer = pnpmContainer
      .withFile("/app/package.json", source.file("package.json"))
      .withFile("/app/pnpm-lock.yaml", source.file("pnpm-lock.yaml"))
      .withFile("/app/pnpm-workspace.yaml", source.file("pnpm-workspace.yaml"))
      .withFile(
        "/app/data-browser/package.json",
        source.file("data-browser/package.json")
      )
      .withFile("/app/lib/package.json", source.file("lib/package.json"))
      .withFile("/app/react/package.json", source.file("react/package.json"))
      .withFile("/app/svelte/package.json", source.file("svelte/package.json"))
      .withFile("/app/cli/package.json", source.file("cli/package.json"));

    // Install dependencies
    const depsContainer = workspaceContainer.withExec([
      "sh",
      "-c",
      "yes | pnpm install --frozen-lockfile --shamefully-hoist",
    ]);

    // Copy the source so installed dependencies persist in the container
    const sourceContainer = depsContainer.withDirectory("/app", source);

    // Build all packages since they may depend on each other's built artifacts
    return sourceContainer.withExec(["pnpm", "run", "build"]);
  }

  @func()
  rustBuild(@argument() release: boolean = false): Container {
    const source = this.source;
    const cargoCache = dag.cacheVolume("cargo");

    const rustContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["apt-get", "update", "-qq"])
      .withExec(["apt", "install", "-y", "nasm"])
      .withExec(["rustup", "component", "add", "clippy"])
      .withExec(["rustup", "component", "add", "rustfmt"])
      .withExec(["cargo", "install", "cross"])
      .withExec(["cargo", "install", "cargo-nextest"])
      .withMountedCache("/usr/local/cargo/registry", cargoCache);

    const sourceContainer = rustContainer
      .withFile("/code/Cargo.toml", source.file("Cargo.toml"))
      .withFile("/code/Cargo.lock", source.file("Cargo.lock"))
      .withFile("/code/Cross.toml", source.file("Cross.toml"))
      .withDirectory("/code/server", source.directory("server"))
      .withDirectory("/code/lib", source.directory("lib"))
      .withDirectory("/code/cli", source.directory("cli"))
      .withMountedCache("/code/target", dag.cacheVolume("rust-target"))
      .withWorkdir("/code")
      .withExec(["cargo", "fetch"]);

    const browserDir = this.jsBuild().directory("/app/data-browser/dist");
    const containerWithAssets = sourceContainer.withDirectory(
      "/code/server/assets_tmp",
      browserDir
    );

    const buildArgs = release
      ? ["cargo", "build", "--release"]
      : ["cargo", "build"];
    const binaryPath = release
      ? "./target/release/atomic-server"
      : "./target/debug/atomic-server";
    const targetPath = release
      ? "/code/target/release/atomic-server"
      : "/code/target/debug/atomic-server";

    return containerWithAssets
      .withExec(buildArgs)
      .withExec([binaryPath, "--version"])
      .withExec(["cp", targetPath, "/atomic-server-binary"]);
  }

  @func()
  rustReleaseBuild(): Container {
    return this.rustBuild(true);
  }

  @func()
  rustTest(): Promise<string> {
    return this.rustBuild().withExec(["cargo", "nextest", "run"]).stdout();
  }

  @func()
  rustClippy(): Promise<string> {
    const rustContainer = this.rustBuild();

    return rustContainer
      .withExec([
        "cargo",
        "clippy",
        "--no-deps",
        "--all-features",
        "--all-targets",
      ])
      .stdout();
  }

  @func()
  rustFmt(): Promise<string> {
    const rustContainer = this.rustBuild();

    return rustContainer.withExec(["cargo", "fmt", "--check"]).stdout();
  }

  @func()
  rustCrossBuild(@argument() target: string): Container {
    const source = this.source;
    const cargoCache = dag.cacheVolume("cargo");

    // Use rust-musl-cross images which support multi-arch builds
    // Map target to the appropriate image tag
    let imageTag: string;
    switch (target) {
      case "x86_64-unknown-linux-musl":
        imageTag = "x86_64-musl";
        break;
      case "aarch64-unknown-linux-musl":
        imageTag = "aarch64-musl";
        break;
      case "armv7-unknown-linux-musleabihf":
        imageTag = "armv7-musleabihf";
        break;
      default:
        throw new Error(`Unsupported cross-compilation target: ${target}`);
    }

    const rustContainer = dag
      .container()
      .from(`ghcr.io/rust-cross/rust-musl-cross:${imageTag}`)
      .withExec(["apt-get", "update", "-qq"])
      .withExec(["apt-get", "install", "-y", "nasm"])
      .withMountedCache("/home/rust/.cargo/registry", cargoCache);

    const sourceContainer = rustContainer
      .withFile("/home/rust/src/Cargo.toml", source.file("Cargo.toml"))
      .withFile("/home/rust/src/Cargo.lock", source.file("Cargo.lock"))
      .withDirectory("/home/rust/src/server", source.directory("server"))
      .withDirectory("/home/rust/src/lib", source.directory("lib"))
      .withDirectory("/home/rust/src/cli", source.directory("cli"))
      .withMountedCache("/home/rust/src/target", dag.cacheVolume("rust-target"))
      .withWorkdir("/home/rust/src")
      .withExec(["cargo", "fetch"]);

    // Include frontend assets for the server build
    const browserDir = this.jsBuild().directory("/app/data-browser/dist");
    const containerWithAssets = sourceContainer.withDirectory(
      "/home/rust/src/server/assets_tmp",
      browserDir
    );

    // Build using the pre-configured cross-compilation environment
    return containerWithAssets
      .withExec(["cargo", "build", "--target", target, "--release"])
      .withExec([`./target/${target}/release/atomic-server`, "--version"])
      .withExec([
        "cp",
        `./target/${target}/release/atomic-server`,
        "/atomic-server-binary",
      ]);
  }

  @func()
  async endToEnd(@argument() netlifyAuthToken: Secret): Promise<string> {
    const e2eSource = this.source.directory("browser/e2e");

    // Setup Playwright container - debug and fix package manager
    const playwrightContainer = dag
      .container()
      .from("mcr.microsoft.com/playwright:v1.48.1-noble")
      .withExec([
        "/bin/sh",
        "-c",
        'curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=9.3.0 ENV="$HOME/.shrc" SHELL="$(which sh)" sh - && export PATH=/root/.local/share/pnpm:$PATH && /bin/apt update && /bin/apt install -y zip',
      ])
      .withEnvVariable(
        "PATH",
        "/root/.local/share/pnpm:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
      )
      .withExec(["pnpm", "dlx", "playwright", "install", "--with-deps"])
      .withExec(["npm", "install", "-g", "netlify-cli"]);

    // Get the atomic-server binary from the build (copied out of cache)
    const atomicServerBinary = this.rustBuild().file("/atomic-server-binary");

    // Setup e2e test environment
    const e2eContainer = playwrightContainer
      .withMountedDirectory("/app", e2eSource)
      .withWorkdir("/app")
      .withExec(["pnpm", "install"])
      .withEnvVariable("LANGUAGE", "en_GB")
      .withEnvVariable("DELETE_PREVIOUS_TEST_DRIVES", "false")
      .withEnvVariable("FRONTEND_URL", "http://localhost:9883")
      .withFile("/atomic-server-bin", atomicServerBinary, {
        permissions: 0o755,
      })
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken);

    // Test the binary
    e2eContainer.withExec(["/atomic-server-bin", "--version"]);

    // Start atomic-server in background
    const serverStarted = e2eContainer
      .withExec([
        "/bin/sh",
        "-c",
        "nohup /atomic-server-bin --initialize > /dev/null 2>&1 & echo 'Server started'",
      ])
      .withExec(["sleep", "3"]);

    // Check if atomic-server is running, if its responding with a 200
    serverStarted.withExec([
      "/bin/sh",
      "-c",
      "curl -f -s http://localhost:9883/ || (echo 'Server not responding with 200' && exit 1)",
    ]);

    // Run the tests and capture exit code, but continue regardless
    const testResult = serverStarted.withExec([
      "/bin/sh",
      "-c",
      "pnpm run test-e2e; echo $? > /test-exit-code",
    ]);

    // Extract the test results directory and upload to Netlify
    const testReportDirectory = testResult.directory("playwright-report");
    const deployOutput = await this.netlifyDeploy(
      testReportDirectory,
      "atomic-tests",
      netlifyAuthToken
    );

    // Extract the deploy URL
    const deployUrl = this.extractDeployUrl(deployOutput);

    // Check the test exit code and fail if tests failed
    const exitCode = await testResult.file("/test-exit-code").contents();
    if (exitCode.trim() !== "0") {
      throw new Error(
        `E2E tests failed (exit code: ${exitCode.trim()}). Test report deployed to: \n${deployUrl}`
      );
    }

    return deployUrl;
  }

  @func()
  async deployServer(
    @argument() remoteHost: string,
    @argument() remoteUser: Secret,
    @argument() sshPrivateKey: Secret
  ): Promise<string> {
    // Build the cross-compiled binary for x86_64-unknown-linux-musl
    const crossBuildContainer = this.rustCrossBuild(
      "x86_64-unknown-linux-musl"
    );
    const binaryFile = crossBuildContainer.file("/atomic-server-binary");

    // Create deployment container with SSH client
    const deployContainer = dag
      .container()
      .from("alpine:latest")
      .withExec(["apk", "add", "--no-cache", "openssh-client", "rsync"])
      .withFile("/atomic-server-binary", binaryFile, { permissions: 0o755 });

    // Setup SSH key
    const sshContainer = deployContainer
      .withExec(["mkdir", "-p", "/root/.ssh"])
      .withSecretVariable("SSH_PRIVATE_KEY", sshPrivateKey)
      .withExec(["sh", "-c", 'echo "$SSH_PRIVATE_KEY" > /root/.ssh/id_rsa'])
      .withExec(["chmod", "600", "/root/.ssh/id_rsa"])
      .withExec(["ssh-keyscan", "-H", remoteHost])
      .withExec([
        "sh",
        "-c",
        `ssh-keyscan -H ${remoteHost} >> /root/.ssh/known_hosts`,
      ]);

    // Transfer binary using rsync
    const transferResult = await sshContainer
      .withSecretVariable("REMOTE_USER", remoteUser)
      .withExec([
        "sh",
        "-c",
        `rsync -rltgoDzvO /atomic-server-binary $REMOTE_USER@${remoteHost}:~/atomic-server-x86_64-unknown-linux-musl`,
      ])
      .stdout();

    // Execute deployment commands on remote server
    const deployResult = await sshContainer
      .withSecretVariable("REMOTE_USER", remoteUser)
      .withExec([
        "sh",
        "-c",
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
}
