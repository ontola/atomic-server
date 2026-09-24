//! The hello-route fixture (`testdata/plugin-routes/hello-route/`, an
//! anonymous `GET /hello/{name}` on the `drive-prefix` mount) at every build
//! and level: whether it installs, and what its mount answers.
//!
//! | build              | `--plugin-routes` | installs | `/_routes/<slug>/hello/x` |
//! | ------------------ | ----------------- | -------- | ------------------------- |
//! | no `plugin-routes` | `off` (only one)  | no       | 404                       |
//! | `plugin-routes`    | `off`             | no       | 404                       |
//! | `plugin-routes`    | `read-only`       | yes      | 200 `Hello, x`            |
//! | `plugin-routes`    | `read-write`      | yes      | 200 `Hello, x`            |
//!
//! Compiled into every `wasm-plugins` build, so both CI feature sets run it.
use actix_web::{test, web, App};

use super::test_fixture::{fixture_with_args, hello_route_release, install_release};
use crate::plugin_routes::COMPILED;

/// Any 32-hex slug: the refused installs have no Installation to derive one
/// from.
const SOME_SLUG: &str = "0123456789abcdef0123456789abcdef";

#[actix_rt::test]
async fn the_hello_route_fixture_at_every_build_and_level() {
    let levels: &[&str] = if COMPILED {
        &["off", "read-only", "read-write"]
    } else {
        // The other levels refuse to start; `plugin_routes::tests` covers that.
        &["off"]
    };
    for level in levels {
        let f =
            fixture_with_args(&format!("hello_route_{level}"), &["--plugin-routes", level]).await;
        let installed = install_release(&f, &hello_route_release()).await;
        let should_install = *level != "off";
        assert_eq!(installed.is_ok(), should_install, "{level}: {installed:?}");

        if let Err(err) = &installed {
            let expected = if COMPILED {
                "start AtomicServer with `--plugin-routes read-only`"
            } else {
                "built without plugin routes"
            };
            assert!(err.contains(expected), "{level}: {err}");
            assert!(
                err.contains("route `GET,HEAD /hello/{name}`"),
                "{level}: {err}"
            );
        }

        #[cfg(feature = "plugin-routes")]
        let slug = installed
            .as_deref()
            .map(super::route_registry::slug)
            .unwrap_or_else(|_| SOME_SLUG.to_string());
        #[cfg(not(feature = "plugin-routes"))]
        let slug = SOME_SLUG.to_string();

        let app = test::init_service(
            App::new()
                .app_data(web::Data::new(f.appstate.clone()))
                .configure(crate::routes::config_routes),
        )
        .await;
        let resp = test::call_service(
            &app,
            test::TestRequest::get()
                .uri(&format!("/_routes/{slug}/hello/alice"))
                .insert_header(("accept", "application/ad+json"))
                .to_request(),
        )
        .await;
        let expected = if should_install { 200 } else { 404 };
        assert_eq!(resp.status().as_u16(), expected, "{level}");
        if should_install {
            assert_eq!(
                resp.headers().get("content-type").unwrap(),
                "text/plain; charset=utf-8"
            );
            assert_eq!(test::read_body(resp).await, "Hello, alice", "{level}");
        }
    }
}
