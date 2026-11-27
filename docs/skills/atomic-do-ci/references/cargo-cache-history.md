# Why workspace Rust crates currently rebuild

The guard is a response to observed incorrect cached libraries, not a claim that Cargo cannot cache local crates.

- [PR #1329](https://github.com/ontola/atomic-server/pull/1329), September 2, 2026: the shared target volumes contained an `atomic_lib` from a deleted revert branch without `populate::repopulate_defaults`. Other branches failed with E0425. Renaming volumes to `-v2` reset the bad cache but did not solve its cause.
- [6d5e7d9cf78597cfe42ea85a651067bdac340383](https://github.com/ontola/atomic-server/commit/6d5e7d9cf78597cfe42ea85a651067bdac340383), September 4: another branch had again populated shared target caches with an incompatible `atomic_lib`. Volume names moved to `-v3`, and workspace files were touched before Cargo so those local crates were rebuilt while registry dependencies remained cached.
- [04df822039ec59adb6ba0bc7e231916c65f72ebb](https://github.com/ontola/atomic-server/commit/04df822039ec59adb6ba0bc7e231916c65f72ebb), authored September 15 and committed September 16: Dagger itself cached the touch operation and replayed older timestamps, so the guard gained a per-run value.
- [PR #1709 / 29c895e8b39b0994ead15720fcf5dce355f94046](https://github.com/ontola/atomic-server/commit/29c895e8b39b0994ead15720fcf5dce355f94046), September 24: taking the clock separately in every caller caused seven WASM builds and 44 lock-wait messages in one CI run. One stamp per module invocation restored deduplication inside a run while retaining cross-run freshness.

The completed-artifact manifest validates the source identity and bytes of a transferred bundle. It does not independently establish that Cargo selected correct intermediate objects before producing that bundle. A restored snapshot can already contain another source revision's target cache even without two live branches writing concurrently.

Before removing the guard, demonstrate that same-Rust-source runs reuse the correct library and A→B→A source transitions cannot reuse another revision's local crates when container timestamps are old. Cache identity must account for source/dependency inputs, target, toolchain, profile and features. Content-keyed workspace artifacts or a compiler cache are possible replacements; cache namespaces per operator/run alone do not establish this property.

On November 25, a tiny real Cargo workspace reproduced both failures using CI's exact Cargo/rustc 1.98.1 on native aarch64 macOS, one checkout, one shared target directory and the dev profile:

| Transition with deliberately old dependency mtimes | Observed result |
| --- | --- |
| Rename dependency API, rebuild consumer | Dependency `fresh=true`, E0425 |
| Keep API, change returned value from 2 to 3, rebuild consumer | Build succeeds, dependency `fresh=true`, binary still returns **2** |
| Touch the changed dependency | Rebuilds and returns the correct **3** |

This is a native Cargo reproduction, not a new DO/Linux whole-application run. The raw toolchain/version, compiler freshness records, exit codes and stdout/stderr are retained under operator run key `cargo-mtime-pinned-20261125t151042z` (`summary.json`). No simple revert has been made. Keep the existing correctness guard until replacement behavior is verified, including safe A→B→A transitions and reuse on identical repeated builds.

## Upstream documentation and alternatives, checked November 25, 2026

- [Cargo #6529](https://github.com/rust-lang/cargo/issues/6529) tracks content fingerprints instead of mtimes, dates to 2019 and includes a Docker example using old code plus a `touch` workaround. Its closure reflects the initial checksum feature landing, not proof that all stable builds now use content fingerprints. No specific new 1.98.1 regression was established by this search.
- [Cargo fingerprint documentation](https://doc.rust-lang.org/stable/nightly-rustc/cargo/compiler/fingerprint/index.html) explicitly describes mtime freshness and its limitations. That URL follows the current stable Cargo documentation; it is not pinned documentation for 1.98.1.
- [`-Z checksum-freshness`](https://doc.rust-lang.org/cargo/reference/unstable.html#checksum-freshness) is documented as unstable/nightly. It uses content checks but still has build-script-input limitations. It is a possible separate experiment, not a flag to silently add to our stable toolchain.
- [`sccache` Rust support](https://github.com/mozilla/sccache/blob/main/docs/Rust.md) offers compiler-level content reuse. Keeping the existing touch guard makes Cargo invoke the compiler wrapper, where identical input content can be reused. Linking and some crate kinds are not cached, and incremental/procedural-macro behavior needs checking. It cannot fix a wrongly skipped Cargo invocation by itself. This is a useful stable-toolchain experiment before writing a custom artifact-cache system, not a measured improvement in the current DO benchmark.
