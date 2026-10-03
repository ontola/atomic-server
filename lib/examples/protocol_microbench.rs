//! Native-Rust timings for protocol primitives that TypeScript also implements.
//!
//! Run: `cargo run -p atomic_lib --example protocol_microbench --release`
//!
//! These numbers are native (not WASM). WASM is typically 1.5–4× slower plus
//! JS↔WASM copy cost; the TS benches in `@tomic/lib` measure that path.

use std::collections::BTreeMap;
use std::time::Instant;

use atomic_lib::agents::{encode_base64, sign_message};
use atomic_lib::genesis::{GenesisCert, GENESIS_VERSION_V1};
use atomic_lib::sync::rbsr::item_fingerprint;

fn bench(name: &str, iters: u32, mut f: impl FnMut()) {
    // Warmup
    for _ in 0..iters.min(100) {
        f();
    }
    let start = Instant::now();
    for _ in 0..iters {
        f();
    }
    let elapsed = start.elapsed();
    let ns = elapsed.as_nanos() / u128::from(iters);
    println!(
        "{:<42} {:>8} ns/op  ({iters} iters, {elapsed:?})",
        name, ns
    );
}

fn sample_cert() -> GenesisCert {
    GenesisCert {
        signer_pubkey: [1u8; 32],
        created_at: 1_780_000_123_456,
        nonce: [2u8; 16],
        state_hash: Some([9u8; 32]),
        parent: "https://example.com/parent".into(),
        drive: "did:ad:driveAAAA".into(),
    }
}

fn main() {
    println!("atomic_lib protocol microbench (native release)\n");

    let cert = sample_cert();
    bench("genesis.encode", 100_000, || {
        std::hint::black_box(cert.encode());
    });

    let encoded = cert.encode();
    bench("genesis.decode", 100_000, || {
        std::hint::black_box(GenesisCert::decode(&encoded).unwrap());
    });

    // Deterministic 32-byte seed, URL-safe base64 (same alphabet as production).
    let private_key = encode_base64(&[7u8; 32]);
    let message = b"https://example.com/resource 1775504552928";
    bench("ed25519.sign (1-line auth message)", 20_000, || {
        std::hint::black_box(sign_message(message, &private_key).unwrap());
    });

    let mut vv = BTreeMap::new();
    vv.insert("p1".into(), 1);
    vv.insert("p2".into(), 2);
    bench("rbsr.item_fingerprint", 50_000, || {
        std::hint::black_box(item_fingerprint("s", &vv));
    });

    let payload = vec![0u8; 1024];
    bench("blake3.hash 1KiB", 50_000, || {
        std::hint::black_box(blake3::hash(&payload));
    });

    let json_ad = r#"{"@id":"https://example.com/r","https://atomicdata.dev/properties/name":"My important document","https://atomicdata.dev/properties/description":"This is a longer description that contains more text to simulate real content in a resource.","https://atomicdata.dev/properties/isA":["https://atomicdata.dev/classes/Document"]}"#;
    bench("serde_json.parse typical resource", 50_000, || {
        std::hint::black_box(serde_json::from_str::<serde_json::Value>(json_ad).unwrap());
    });

    println!("\nNote: GENESIS_VERSION_V1 = {GENESIS_VERSION_V1}");
    println!("Native numbers are a floor. Browser WASM pays compile-to-wasm + wasm-bindgen copy.");
}
