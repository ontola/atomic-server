#!/usr/bin/env python3
"""Check local Rust pins, or a Server/SaaS pair. Requires Python 3.11+."""
import argparse
from pathlib import Path
import re
import sys
import tomllib

# These libraries cross persistence, transport, serialization or signing boundaries.
# redb is intentionally excluded: SaaS's own database still uses a different major.
SHARED = {
    "loro", "iroh", "serde", "serde_json", "ed25519-dalek",
    "curve25519-dalek", "tokio", "reqwest", "object_store",
}


def read_toml(path):
    return tomllib.loads(path.read_text())


def versions(root):
    result = {}
    for package in read_toml(root / "Cargo.lock")["package"]:
        if package.get("source", "").startswith("registry+"):
            result.setdefault(package["name"], set()).add(package["version"])
    return result


def check_local(root):
    errors = []
    channel = read_toml(root / "rust-toolchain.toml")["toolchain"]["channel"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", channel):
        errors.append(f"{root.name}: Rust channel must be an exact release, got {channel}")
    for workflow in sorted((root / ".github/workflows").glob("*.yml")):
        text = workflow.read_text()
        pins = re.findall(r"uses:\s*dtolnay/rust-toolchain@([^\s#]+)", text)
        # Legacy actions-rs/toolchain uses a `toolchain:` input.
        if "actions-rs/toolchain@" in text:
            pins += re.findall(r"^\s+toolchain:\s*([^\s#]+)", text, re.MULTILINE)
        for pin in pins:
            if pin.strip("\"'") != channel:
                errors.append(f"{workflow}: Rust {pin} differs from {channel}")
    dagger = root / ".dagger/src/index.ts"
    if dagger.exists():
        text = dagger.read_text()
        if f"const RUST_VERSION = '{channel}';" not in text:
            errors.append(f"{dagger}: RUST_VERSION must match {channel}")
        if 'const RUST_IMAGE = `rust:${RUST_VERSION}-bookworm`;' not in text:
            errors.append(f"{dagger}: Rust image must use RUST_VERSION")
    return errors


def check_pair(server, saas):
    errors = check_local(server) + check_local(saas)
    server_toolchain = read_toml(server / "rust-toolchain.toml")["toolchain"]
    saas_toolchain = read_toml(saas / "rust-toolchain.toml")["toolchain"]
    if server_toolchain != saas_toolchain:
        errors.append("rust-toolchain.toml differs between Server and SaaS")
    for section in ["dev"]:
        a = read_toml(server / "Cargo.toml").get("profile", {}).get(section, {})
        b = read_toml(saas / "Cargo.toml").get("profile", {}).get(section, {})
        if a != b:
            errors.append(f"profile.{section} differs between Server and SaaS")
    a, b = versions(server), versions(saas)
    names = SHARED | {name for name in a.keys() & b.keys() if name.startswith("loro-")}
    for name in sorted(names):
        if not a.get(name) or a.get(name) != b.get(name):
            errors.append(
                f"{name}: Server={sorted(a.get(name, []))}, SaaS={sorted(b.get(name, []))}; "
                "align with cargo update -p NAME@OLD --precise VERSION and commit Cargo.lock"
            )
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--saas", type=Path, help="also check this SaaS checkout")
    args = parser.parse_args()
    try:
        errors = check_pair(args.server, args.saas) if args.saas else check_local(args.server)
    except (OSError, KeyError, tomllib.TOMLDecodeError) as error:
        print(f"Rust alignment configuration error: {error}", file=sys.stderr)
        return 1
    if errors:
        print("Rust alignment failed:\n- " + "\n- ".join(errors), file=sys.stderr)
        return 1
    print("Rust toolchain, workflow pins" + (", profiles and shared lockfile versions" if args.saas else "") + " are aligned.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
