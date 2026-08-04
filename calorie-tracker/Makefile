.PHONY: ios android apk reload-ios restart-ios reload-android restart-android \
        analyze test cargo-test integration-ios integration-android check gen \
        devices clean-build

# Which Android ABI to build the Rust library for. Overridable:
#   make apk ABI=android-arm64   (physical devices, Apple Silicon emulators)
#   make apk ABI=android-x64     (Intel emulators)
#
# This is not a micro-optimisation. Flutter's default builds every ABI, which
# means compiling atomic_lib's ~1500-crate dependency tree once per ABI —
# roughly 15 GB of build output and the better part of half an hour. One ABI is
# what any single device can run.
ABI ?= android-arm64

# ── Run ───────────────────────────────────────────────────────────────────
# `make ios` / `make android` start the app with a FIFO on stdin, so hot
# reload can be triggered from a different terminal (or by an agent) with
# `make reload-ios` — no need to be attached to the running process.

ios:
	./dev.sh ios

android:
	./dev.sh android

apk:
	flutter build apk --debug --target-platform $(ABI)

devices:
	flutter devices

# Wipes the Flutter build tree, including the per-ABI Rust target dirs under
# build/rust_lib_calorie_tracker. Reach for this when the disk fills up.
clean-build:
	flutter clean
	rm -rf rust/target

reload-ios:
	@echo r > /tmp/caltracker_ios_pipe

restart-ios:
	@echo R > /tmp/caltracker_ios_pipe

reload-android:
	@echo r > /tmp/caltracker_android_pipe

restart-android:
	@echo R > /tmp/caltracker_android_pipe

# ── Check ─────────────────────────────────────────────────────────────────

analyze:
	flutter analyze

test:
	flutter test

cargo-test:
	cargo test --manifest-path rust/Cargo.toml

# On-device: proves the Rust library is in the app bundle and callable. Needs a
# booted simulator / emulator; pass DEVICE=<id> from `make devices`.
integration-ios:
	flutter test integration_test -d $(or $(DEVICE),ios)

integration-android:
	flutter test integration_test -d $(or $(DEVICE),emulator-5554)

# What every phase has to leave green.
check: analyze test cargo-test

# ── Codegen ───────────────────────────────────────────────────────────────
# Run after changing any `pub` function in rust/src/api/. The Rust crate will
# not compile until you do — frb_generated.rs still calls the old signature.

gen:
	flutter_rust_bridge_codegen generate
