#[cfg(not(target_os = "android"))]
mod menu;
#[cfg(not(target_os = "android"))]
mod system_tray;

/// Hand the Android system certificate verifier the app's JVM context.
/// reqwest's rustls backend panics on any outbound HTTPS request until this
/// runs. Requires the `rustls:rustls-platform-verifier` Kotlin component
/// bundled via gradle (see gen/android/build.gradle.kts).
///
/// The raw pointers come from wry's JNI callback (jni 0.21 types); they are
/// rebuilt here as the jni 0.22 types rustls-platform-verifier expects.
#[cfg(target_os = "android")]
fn init_tls_verifier(raw_vm: *mut std::ffi::c_void, raw_activity: *mut std::ffi::c_void) {
  let vm = unsafe { jni::JavaVM::from_raw(raw_vm.cast()) };
  vm.attach_current_thread(|env| -> Result<(), jni::errors::Error> {
    let activity = unsafe { jni::objects::JObject::from_raw(env, raw_activity.cast()) };
    rustls_platform_verifier::android::init_with_env(env, activity)
  })
  .expect("failed to initialize rustls-platform-verifier");
}

/// Deep links (`atomic://pair?p=…`, see `planning/device-pairing.md`) are
/// forwarded to the webview as `atomic-deep-link` DOM events; the frontend
/// queues them from module scope (`helpers/deepLinkQueue.ts`). A link can
/// arrive before the page is ready — the cold start from the system camera
/// scanning a pairing QR — so links are queued here and flushed on every
/// finished page load, with a delivered-set so each link is handed to the
/// frontend exactly once.
#[derive(Default)]
struct PairLinks {
  pending: std::sync::Mutex<Vec<String>>,
  delivered: std::sync::Mutex<std::collections::HashSet<String>>,
}

fn queue_pair_links(state: &PairLinks, urls: impl IntoIterator<Item = String>) {
  let delivered = state.delivered.lock().unwrap();
  let mut pending = state.pending.lock().unwrap();
  for url in urls {
    if url.starts_with("atomic://") && !delivered.contains(&url) && !pending.contains(&url) {
      pending.push(url);
    }
  }
}

fn flush_pair_links(eval: impl Fn(&str) -> tauri::Result<()>, state: &PairLinks) {
  let links: Vec<String> = state.pending.lock().unwrap().drain(..).collect();
  let mut delivered = state.delivered.lock().unwrap();
  for link in links {
    let js = format!(
      "window.dispatchEvent(new CustomEvent('atomic-deep-link', {{ detail: {} }}));",
      serde_json::to_string(&link).expect("a string always serializes")
    );
    if eval(&js).is_ok() {
      delivered.insert(link);
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_process::init())
    .manage(PairLinks::default())
    .on_page_load(|webview, payload| {
      if payload.event() == tauri::webview::PageLoadEvent::Finished {
        use tauri::Manager;
        use tauri_plugin_deep_link::DeepLinkExt;
        let state = webview.state::<PairLinks>();
        // Cold start: the launching intent's link (get_current) predates the
        // on_open_url registration; the delivered-set dedupes it on reloads.
        if let Ok(Some(urls)) = webview.app_handle().deep_link().get_current() {
          queue_pair_links(&state, urls.iter().map(|u| u.to_string()));
        }
        flush_pair_links(|js| webview.eval(js), &state);
      }
    })
    .setup(move |app| {
      {
        use tauri::Manager;
        use tauri_plugin_deep_link::DeepLinkExt;
        let handle = app.handle().clone();
        app.deep_link().on_open_url(move |event| {
          let state = handle.state::<PairLinks>();
          queue_pair_links(&state, event.urls().iter().map(|u| u.to_string()));
          if let Some(webview) = handle.get_webview_window("main") {
            flush_pair_links(|js| webview.eval(js), &state);
          }
        });
      }

      // The verifier init must run on the Android context thread (via wry's
      // JNI dispatch); the server thread below waits for it so no HTTPS
      // request can hit an uninitialized verifier.
      #[cfg(target_os = "android")]
      let tls_verifier_ready = {
        use tauri::Manager;
        let (tx, rx) = std::sync::mpsc::channel();
        let webview = app
          .get_webview_window("main")
          .expect("main window should exist");
        webview.with_webview(move |platform_webview| {
          platform_webview
            .jni_handle()
            .exec(move |env, activity, _webview| {
              let raw_vm = env
                .get_java_vm()
                .expect("JavaVM from JNI env")
                .get_java_vm_pointer();
              init_tls_verifier(raw_vm.cast(), activity.as_raw().cast());
              let _ = tx.send(());
            });
        })?;
        rx
      };
      #[cfg(target_os = "android")]
      let config = {
        use tauri::Manager;
        let paths = app.path();
        let data_dir = paths.app_data_dir().expect("no app data dir");
        let config_dir = paths.app_config_dir().expect("no app config dir");
        let cache_dir = paths.app_cache_dir().expect("no app cache dir");
        use clap::Parser;
        let opts = atomic_server_lib::config::Opts::parse_from([
          "atomic-server",
          "--data-dir",
          data_dir.to_str().unwrap(),
          "--config-dir",
          config_dir.to_str().unwrap(),
          "--cache-dir",
          cache_dir.to_str().unwrap(),
        ]);
        atomic_server_lib::config::build_config(opts)
          .map_err(|e| format!("Initialization failed: {}", e))
          .expect("failed init config")
      };

      #[cfg(not(target_os = "android"))]
      let config = {
        let opts = atomic_server_lib::config::read_opts();
        atomic_server_lib::config::build_config(opts)
          .map_err(|e| format!("Initialization failed: {}", e))
          .expect("failed init config")
      };

      let config_clone = config.clone();
      // This is not the cleanest solution, but running actix inside the tauri / tokio runtime is not
      std::thread::spawn(move || {
        #[cfg(target_os = "android")]
        tls_verifier_ready
          .recv()
          .expect("TLS verifier initialization did not complete");

        let rt = actix_rt::Runtime::new().unwrap();
        rt.block_on(atomic_server_lib::serve::serve(config_clone))
          .unwrap();
      });

      #[cfg(not(target_os = "android"))]
      {
        let menu = crate::menu::build(app.handle())?;
        app.handle().set_menu(menu)?;
        system_tray::setup(app, &config)?;
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("Tauri Error.");
}
