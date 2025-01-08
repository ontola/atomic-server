import {
  dag,
  Container,
  Directory,
  object,
  func,
  argument,
} from "@dagger.io/dagger";

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
      .from("node:21-slim")
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
  private getDeps(source: Directory): Container {
    // Create a container with PNPM installed
    const pnpmContainer = dag
      .container()
      .from("node:24")
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
