use tauri::{
  menu::{Menu, MenuItem, PredefinedMenuItem},
  tray::TrayIconBuilder,
  App, Manager,
};
use tauri_plugin_shell::ShellExt;

pub fn setup(app: &mut App, config: &atomic_server_lib::config::Config) -> tauri::Result<()> {
  let open = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
  let browser = MenuItem::with_id(app, "browser", "Open in browser", true, None::<&str>)?;
  let config_item = MenuItem::with_id(app, "config", "Config folder", true, None::<&str>)?;
  let docs = MenuItem::with_id(app, "docs", "Atomic Data Docs", true, None::<&str>)?;
  let sep = PredefinedMenuItem::separator(app)?;
  let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

  let menu = Menu::with_items(app, &[&open, &browser, &config_item, &docs, &sep, &quit])?;

  let origin = config.get_origin();
  let config_dir = config.config_dir.to_str().unwrap().to_string();

  TrayIconBuilder::new()
    .icon(app.default_window_icon().unwrap().clone())
    .menu(&menu)
    .on_menu_event(move |app, event| match event.id.as_ref() {
      "quit" => std::process::exit(0),
      "open" => {
        if let Some(window) = app.get_webview_window("main") {
          window.show().unwrap();
          window.set_focus().unwrap();
        }
      }
      "browser" => {
        app.shell().open(&origin, None).unwrap();
      }
      "config" => {
        app.shell().open(&config_dir, None).unwrap();
      }
      "docs" => {
        app
          .shell()
          .open("https://docs.atomicdata.dev", None)
          .unwrap();
      }
      _ => {}
    })
    .build(app)?;

  Ok(())
}
