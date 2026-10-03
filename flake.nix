{
  description = "AtomicServer: graph database server with real-time Loro sync";

  # nixos-unstable ships the exact Rust toolchain pinned in rust-toolchain.toml
  # (with the wasm32-unknown-unknown std the browser WASM needs), so no
  # rust-overlay is required. The channel tarball (not `github:`) lets
  # flake.lock pin it without the GitHub API.
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-unstable/nixexprs.tar.xz";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
      lib = nixpkgs.lib;

      # Keep the Nix toolchain in step with `rust-toolchain.toml`.
      pinnedRust = (builtins.fromTOML (builtins.readFile ./rust-toolchain.toml)).toolchain.channel;
      version = (builtins.fromTOML (builtins.readFile ./server/Cargo.toml)).package.version;

      # Stands in for the data browser (`browser/`), which needs network
      # access to build and so can't be built in the Nix sandbox yet. The
      # server embeds whatever `dist` it is given; swap in the real bundle with
      # `.override { dataBrowser = <dist directory>; }`.
      placeholderDataBrowser =
        pkgs:
        pkgs.writeTextDir "index.html" ''
          <!doctype html>
          <html>
            <head>
              <meta charset="utf-8" />
              <title>AtomicServer</title>
              <!-- { inject_html_head } -->
            </head>
            <body>
              <p>
                This AtomicServer was built without the data browser. The API
                works; request resources with <code>Accept: application/ad+json</code>.
              </p>
              <!-- { inject_script } -->
            </body>
          </html>
        '';

      atomicServer =
        pkgs:
        pkgs.callPackage (
          {
            rustPlatform,
            pkg-config,
            cmake,
            clang,
            protobuf,
            dataBrowser ? placeholderDataBrowser pkgs,
          }:
          rustPlatform.buildRustPackage {
            pname = "atomic-server";
            inherit version;

            # Only the Rust workspace: editing docs or the frontend sources
            # must not rebuild the server.
            src = lib.fileset.toSource {
              root = ./.;
              fileset = lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./server
                ./lib
                ./cli
                ./desktop
                ./wasm
                ./atomic-plugin
                ./plugin-runtime
                ./plugin-examples
                ./tools
                ./testdata
              ];
            };

            cargoLock.lockFile = ./Cargo.lock;
            cargoBuildFlags = [
              "--package"
              "atomic-server"
            ];
            # The test suite needs a browser, a network and a running server;
            # CI covers it.
            doCheck = false;

            nativeBuildInputs = [
              pkg-config
              cmake
              clang
              protobuf
            ];

            # `server/build.rs` embeds `../browser/data-browser/dist`. It
            # would run `pnpm` to build it; hand it the finished bundle.
            ATOMICSERVER_SKIP_JS_BUILD = "true";
            # The plugin runtime is a wasm32-wasip2 component, and nixpkgs
            # has no std for that target. The server builds without it
            # (server-side plugins are unavailable).
            ATOMICSERVER_SKIP_PLUGIN_RUNTIME = "true";
            preBuild = ''
              mkdir -p browser/data-browser
              cp -r ${dataBrowser} browser/data-browser/dist
              chmod -R u+w browser/data-browser/dist
            '';

            meta = {
              description = "Graph database server with real-time sync, built on Atomic Data and Loro";
              homepage = "https://atomicserver.eu/";
              license = lib.licenses.mit;
              mainProgram = "atomic-server";
              platforms = systems;
            };
          }
        ) { };
    in
    {
      packages = forAllSystems (pkgs: rec {
        atomic-server = atomicServer pkgs;
        default = atomic-server;
      });

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = lib.getExe self.packages.${pkgs.system}.atomic-server;
        };
      });

      # `nix develop`: everything `cargo run` in server/ and `pnpm` in
      # browser/ expect on PATH. On NixOS the prebuilt tools those would
      # download (wasm-bindgen, wasm-opt) can't run, so they come from nixpkgs.
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            (lib.warnIf (pkgs.rustc.version != pinnedRust)
              "flake: nixpkgs has Rust ${pkgs.rustc.version}, rust-toolchain.toml pins ${pinnedRust}"
              pkgs.rustc
            )
            pkgs.cargo
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer

            pkgs.nodejs_22
            pkgs.pnpm_10

            # build:wasm. wasm-pack reuses wasm-bindgen / wasm-opt from PATH
            # when the version matches `wasm-bindgen` in Cargo.lock.
            pkgs.wasm-pack
            pkgs.wasm-bindgen-cli_0_2_122
            pkgs.binaryen

            pkgs.pkg-config
            pkgs.cmake
            pkgs.clang
            pkgs.protobuf
            pkgs.openssl
          ];

          # Rust std sources for rust-analyzer.
          RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";

          # Native node modules (@parcel/watcher, @swc/core) load libstdc++.
          shellHook = lib.optionalString pkgs.stdenv.hostPlatform.isLinux ''
            export LD_LIBRARY_PATH="${lib.makeLibraryPath [ pkgs.stdenv.cc.cc.lib ]}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-rfc-style);
    };
}
