import {
  dag,
  Container,
  Directory,
  object,
  func,
  argument,
  File,
  Secret,
} from "@dagger.io/dagger";

const NODE_IMAGE = "node:24";
const RUST_IMAGE = "rust:bookworm";

@object()
export class AtomicServer {
  /**
   * Publish the application container after building and testing it on-the-fly
   */
  @func()
  async publish(
    @argument({ defaultPath: "/" }) source: Directory
  ): Promise<string> {
    await this.test(source);
    return await this.build(source).publish(
      "ttl.sh/hello-dagger-" + Math.floor(Math.random() * 10000000)
    );
  }

  /**
   * Build the application container
   */
  @func()
  build(@argument({ defaultPath: "/" }) source: Directory): Container {
    const build = this.buildEnv(source)
      .withExec(["npm", "run", "build"])
      .directory("./dist");
    return dag
      .container()
      .from("nginx:1.25-alpine")
      .withDirectory("/usr/share/nginx/html", build)
      .withExposedPort(80);
  }

  /**
   * Return the result of running unit tests
   */
  @func()
  async test(
    @argument({ defaultPath: "/" }) source: Directory
  ): Promise<string> {
    return this.buildEnv(source)
      .withExec(["npm", "run", "test:unit", "run"])
      .stdout();
  }

  /**
   * Build a ready-to-use development environment
   */
  @func()
  buildEnv(@argument({ defaultPath: "/" }) source: Directory): Container {
    const nodeCache = dag.cacheVolume("node");
    return dag
      .container()
      .from(NODE_IMAGE)
      .withDirectory("/src", source)
      .withMountedCache("/root/.npm", nodeCache)
      .withWorkdir("/src")
      .withExec(["npm", "install"]);
  }

  @func()
  buildBrowser(
    @argument({ defaultPath: "/browser" }) source: Directory
  ): Container {
    const depsContainer = this.getDeps(source.directory("."));

    const buildContainer = depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "build"]);

    return buildContainer;
  }

  @func()
  async lintBrowser(
    @argument({ defaultPath: "/browser" }) source: Directory
  ): Promise<string> {
    const depsContainer = this.getDeps(source.directory("."));
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "lint"])
      .stdout();
  }

  @func()
  async testBrowser(
    @argument({ defaultPath: "/browser" }) source: Directory
  ): Promise<string> {
    const depsContainer = this.getDeps(source.directory("."));
    return depsContainer
      .withWorkdir("/app")
      .withExec(["pnpm", "run", "test"])
      .stdout();
  }

  @func()
  docsPublish(
    @argument({ defaultPath: "/docs" }) source: Directory,
    @argument() netlifyAuthToken: Secret
  ): Promise<string> {
    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec(["npm", "install", "-g", "netlify-cli"])
      .withSecretVariable("NETLIFY_AUTH_TOKEN", netlifyAuthToken)
      .withDirectory("/html", this.docsFolder(source.directory(".")))
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
  docsFolder(@argument({ defaultPath: "/docs" }) source: Directory): Directory {
    const docsContainer = dag
      .container()
      .from(RUST_IMAGE)
      .withExec(["cargo", "install", "mdbook"])
      .withExec(["cargo", "install", "mdbook-linkcheck"]);
    // We skip installing mdbook-sitemap-generator because it's broken
    return docsContainer
      .withDirectory("/docs", source)
      .withWorkdir("/docs")
      .withExec(["mdbook", "build"])
      .directory("/docs/book/html");
  }

  @func()
  typedocPublish(
    @argument({ defaultPath: "/browser" }) source: Directory,
    @argument() netlifyAuthToken: Secret
  ): Promise<string> {
    const browserDir = this.buildBrowser(source.directory("."));
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
}
