use tauri::command;

use crate::global_settings;

/// Whether this platform has the tray icon and quick-save popup (Windows).
#[command]
pub fn tray_supported() -> bool {
    cfg!(windows)
}

#[command]
pub fn get_close_to_tray(app: tauri::AppHandle) -> bool {
    global_settings::load(&app).close_to_tray
}

/// "Keep running in the tray": closing the main window hides it instead of quitting.
#[command]
pub fn set_close_to_tray(app: tauri::AppHandle, enabled: bool) {
    global_settings::update(&app, |s| s.close_to_tray = enabled);
}

/// The text on the clipboard, if it has any (the quick-save popup fills its box from it).
#[command]
pub fn read_clipboard_text() -> Option<String> {
    #[cfg(windows)]
    {
        arboard::Clipboard::new().ok()?.get_text().ok()
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Hides the quick-save popup.
#[command]
pub fn hide_quick_add(app: tauri::AppHandle) {
    crate::tray::hide_popup(&app);
}

/// Brings the main window to the front from the popup.
#[command]
pub fn show_main_window(app: tauri::AppHandle) {
    crate::tray::hide_popup(&app);
    crate::tray::show_main(&app);
}
