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
  @func()
  async ci(
    @argument() netlifyAuthToken: Secret
  ): Promise<(string | Container)[]> {
    return Promise.all([
      this.docsPublish(netlifyAuthToken),
      this.buildBrowser(),
      this.lintBrowser(),
      this.testBrowser(),
      this.ee(netlifyAuthToken),
      this.rustTest(),
      this.rustClippy(),
      this.rustFmt(),
    ]);
  }

  @func()
  buildBrowser(): Container {
    const source = dag.currentModule().source().directory("browser");
    const depsContainer = this.getDeps(source.directory("."));

    const buildContainer = depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "build"]);

    return buildContainer;
  }

  @func()
  async lintBrowser(): Promise<string> {
    const source = dag.currentModule().source().directory("browser");
    const depsContainer = this.getDeps(source.directory("."));
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "lint"])
      .stdout();
  }

  @func()
  async testBrowser(): Promise<string> {
    const source = dag.currentModule().source().directory("browser");
    const depsContainer = this.getDeps(source.directory("."));
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "test"])
      .stdout();
  }

  @func()
  docsPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const builtDocsHtml = this.docsFolder();
    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec(["npm", "install", "-g", "netlify-cli"])
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken)
      .withDirectory("/html", builtDocsHtml)
      .withWorkdir("/html")
      .withExec([
        "sh",
        "-c",
        "netlify link --name atomic-docs --auth $NETLIFY_AUTH_TOKEN",
      ])
      .withExec(["netlify", "deploy", "--dir", ".", "--prod"])
      .stdout();
  }

  @func()
  docsFolder(): Directory {
    const moduleSource = dag.currentModule().source();
    const actualDocsDirectory = moduleSource.directory("docs");

    const docsContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["cargo", "install", "mdbook"])
      .withExec(["cargo", "install", "mdbook-linkcheck"]);
    return docsContainer
      .withDirectory("/docs", actualDocsDirectory) // Use the derived path
      .withWorkdir("/docs")
      .withExec(["mdbook", "build"])
      .directory("/docs/book/html");
  }
  @func()
  typedocPublish(@argument() netlifyAuthToken: Secret): Promise<string> {
    const source = dag.currentModule().source().directory("browser");
    const browserDir = this.buildBrowser();
    return browserDir
      .withWorkdir("/app")
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken)
      .withExec(["pnpm", "run", "typedoc-publish"])
      .stdout();
  }

  @func()
  private getDeps(source: Directory): Container {
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

    // Copy the rest of the source
    return depsContainer.withDirectory("/app", source);
  }

  @func()
  rustBuild(): Container {
    const source = dag.currentModule().source();
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

    // Copy source files like in Earthfile, but more selectively
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

    return sourceContainer
      .withExec(["cargo", "build", "--release"])
      .withExec(["./target/release/atomic-server", "--version"]);
  }

  @func()
  rustTest(): Promise<string> {
    return this.rustBuild().withExec(["cargo", "nextest", "run"]).stdout();
  }

  @func()
  rustClippy(): Promise<string> {
    const source = dag.currentModule().source();
    const rustContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["rustup", "component", "add", "clippy"])
      .withDirectory("/code", source)
      .withWorkdir("/code");

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
    const source = dag.currentModule().source();
    const rustContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["rustup", "component", "add", "rustfmt"])
      .withDirectory("/code", source)
      .withWorkdir("/code");

    return rustContainer.withExec(["cargo", "fmt", "--check"]).stdout();
  }

  @func()
  rustCrossBuild(@argument() target: string): Container {
    const source = dag.currentModule().source();
    const rustContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["cargo", "install", "cross"])
      .withDirectory("/code", source)
      .withWorkdir("/code");

    return rustContainer
      .withExec(["cross", "build", "--target", target, "--release"])
      .withExec([`./target/${target}/release/atomic-server`, "--version"]);
  }

  @func()
  ee(@argument() netlifyAuthToken: Secret): Promise<string> {
    const source = dag.currentModule().source();
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

    // Get the atomic-server binary from the build
    const atomicServerBinary = this.rustBuild().file(
      "/code/target/release/atomic-server"
    );

    // Setup e2e test environment
    const e2eContainer = playwrightContainer
      .withFile(
        "/app/e2e/package.json",
        source.file("browser/e2e/package.json")
      )
      .withWorkdir("/app/e2e")
      .withExec(["pnpm", "install"])
      .withDirectory("/app", source.directory("browser/e2e"))
      .withExec(["pnpm", "install"])
      .withEnvVariable("LANGUAGE", "en_GB")
      .withEnvVariable("DELETE_PREVIOUS_TEST_DRIVES", "false")
      .withEnvVariable("FRONTEND_URL", "http://localhost:9883")
      .withFile("/atomic-server-bin", atomicServerBinary, {
        permissions: 0o755,
      })
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken);

    // Run the tests with atomic-server in background
    const testResult = e2eContainer
      .withExec([
        "/bin/sh",
        "-c",
        "nohup /atomic-server-bin --initialize & pnpm run test-e2e && zip -r test.zip /app/e2e/playwright-report",
      ])
      .withExec(["unzip", "-o", "test.zip", "-d", "/artifact"]);

    // Upload test results to Netlify
    return testResult
      .withExec([
        "netlify",
        "deploy",
        "--dir",
        "/artifact/app/e2e/playwright-report",
        "--prod",
        "--site",
        "atomic-tests",
      ])
      .stdout();
  }
}
