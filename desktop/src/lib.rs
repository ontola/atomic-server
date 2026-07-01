#[cfg(not(target_os = "android"))]
mod menu;
#[cfg(not(target_os = "android"))]
mod system_tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_process::init())
    .setup(move |app| {
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
