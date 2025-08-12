//! Various benchmarks for atomic_lib.
//! Should be run using `cargo criterion` or `cargo bench --all-features`.
//! See contribute.md for more information.

use atomic_lib::utils::random_string;
use atomic_lib::*;
use criterion::{black_box, criterion_group, criterion_main, Criterion};
use std::time::Duration;

fn random_atom() -> Atom {
    Atom::new(
        format!("https://localhost/{}", random_string(10)),
        urls::DESCRIPTION.into(),
        Value::Markdown(random_string(200)),
    )
}

fn random_resource(atom: &Atom) -> Resource {
    let mut resource = Resource::new(atom.subject.clone());
    resource.set_propval_unsafe(atom.property.clone(), atom.value.clone());
    resource
}

fn criterion_benchmark(c: &mut Criterion) {
    let mut g = c.benchmark_group("persistable");
    g.sample_size(20);
    g.measurement_time(Duration::from_secs(10));

    // Ensure db feature is available for benches
    #[cfg(not(feature = "db"))]
    {
        panic!("benchmarks require 'db' feature enabled");
    }
    #[cfg(feature = "db")]
    // Use a unique temp dir for benches and avoid optional backends unless configured
    let store = Db::init_temp("bench_persistable").unwrap();

    g.bench_function("add_atom_to_index", |b| {
        b.iter(|| {
            let atom = random_atom();
            let resource = random_resource(&random_atom());
            store.add_atom_to_index(&atom, &resource).unwrap();
        })
    });

    g.bench_function("add_resource", |b| {
        b.iter(|| {
            let resource = random_resource(&random_atom());
            store
                .add_resource_opts(&resource, true, true, false)
                .unwrap();
        })
    });

    g.bench_function("resource.save()", |b| {
        b.iter(|| {
            let mut resource = random_resource(&random_atom());
            resource.save(&store).unwrap();
        })
    });

    #[cfg(feature = "db")]
    let big_resource = store
        .get_resource_extended(
            "https://localhost/collections",
            false,
            &atomic_lib::agents::ForAgent::Sudo,
        )
        .unwrap();

    g.bench_function("resource.to_json_ad()", |b| {
        b.iter(|| {
            big_resource.to_json_ad().unwrap();
        })
    });

    g.bench_function("resource.to_json_ld()", |b| {
        b.iter(|| {
            big_resource.to_json_ld(&store).unwrap();
        })
    });

    g.bench_function("resource.to_json()", |b| {
        b.iter(|| {
            big_resource.to_json(&store).unwrap();
        })
    });

    // Skip to_n_triples in this bench configuration

    g.bench_function("all_resources()", |b| {
        b.iter(|| {
            let _all = black_box(store.all_resources(false).collect::<Vec<Resource>>());
        })
    });

    // Persistable operator benchmarks: write/read single blob via each configured operator
    for name in store.persistence_profiles().into_iter() {
        let key = format!("bench_{}", name);
        let data = vec![0u8; 16 * 1024];
        g.bench_function(&format!("op_write_{}", name), |b| {
            b.iter(|| {
                let _ = store.bench_write(&name, &key, &data);
            })
        });
        g.bench_function(&format!("op_read_{}", name), |b| {
            b.iter(|| {
                let _ = store.bench_read(&name, &key);
            })
        });
    }
    g.finish();
}

criterion_group!(benches, criterion_benchmark);
criterion_main!(benches);
