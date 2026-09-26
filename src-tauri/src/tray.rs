//! The tray icon (Windows) and the small "Save to Kinesis" popup it opens.
//!
//! Clicking the icon opens a frameless popup by the taskbar, where a YouTube link (filled in from the clipboard
//! when it holds one) can be saved to the Library without going to the main window. The popup is a second window
//! showing the same web app (see src/components/QuickAdd.tsx, picked by the window's label). It hides when it loses
//! focus, like a flyout.
//!
//! With "Keep running in the tray" on (Settings > Display), closing the main window hides it instead, so the icon
//! and popup keep working; "Quit" in the icon's menu exits.

use tauri::{AppHandle, Manager};

/// The popup's window label. The web app renders the quick-save view for it.
pub const POPUP_LABEL: &str = "quickadd";

/// Where the popup's top-left goes so it sits beside the tray icon: centered on the icon, above it (or below, when
/// the icon is in the top half of the screen), and kept inside the screen's usable area. All physical pixels;
/// rectangles are (x, y, width, height).
pub fn popup_position(icon: (i32, i32, u32, u32), popup: (u32, u32), area: (i32, i32, u32, u32)) -> (i32, i32) {
    const GAP: i32 = 8;
    let (ix, iy, iw, ih) = icon;
    let (pw, ph) = (popup.0 as i32, popup.1 as i32);
    let (ax, ay, aw, ah) = (area.0, area.1, area.2 as i32, area.3 as i32);
    let x = ix + iw as i32 / 2 - pw / 2;
    let opens_below = iy + ih as i32 / 2 < ay + ah / 2;
    let y = if opens_below { iy + ih as i32 + GAP } else { iy - ph - GAP };
    let clamp = |v: i32, lo: i32, hi: i32| v.min(hi).max(lo);
    (clamp(x, ax, ax + aw - pw), clamp(y, ay, ay + ah - ph))
}

/// Brings the main window to the front: out of the tray if it was hidden there, restored if it was minimized, and
/// focused if it was only behind other windows.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Closes the quick-save popup for good. Done before the app exits so no webview is still alive during shutdown
/// (an open one makes the web engine log "Failed to unregister class Chrome_WidgetWin_0, Error = 1412").
pub fn destroy_popup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.destroy();
    }
}

/// Hides the quick-save popup, if it's open.
pub fn hide_popup(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP_LABEL) {
        let _ = window.hide();
    }
}

#[cfg(windows)]
mod windows {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    use tauri::menu::{IconMenuItem, Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{PhysicalPosition, Rect, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

    /// Logical size of the popup.
    const POPUP_SIZE: (f64, f64) = (380.0, 460.0);
    /// When the popup last hid because it lost focus: the click on the tray icon that caused it mustn't reopen it.
    static HID_BY_BLUR_AT: AtomicI64 = AtomicI64::new(0);

    fn now_ms() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }

    /// Builds the tray icon. Left click opens the popup, double click opens the main window, and the menu has
    /// "Open" and "Quit".
    pub fn init(app: &AppHandle) -> tauri::Result<()> {
        // The app's logo and name: brings the main window to the front, whatever state it is in.
        let open = IconMenuItem::with_id(app, "open", crate::APP_NAME, true, app.default_window_icon().cloned(), None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&open, &quit])?;
        let mut builder = TrayIconBuilder::with_id("main")
            .tooltip(format!("{} - Save a Video", crate::APP_NAME))
            .menu(&menu)
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "open" => show_main(app),
                "quit" => {
                    destroy_popup(app);
                    app.exit(0);
                }
                _ => {}
            })
            .on_tray_icon_event(|tray, event| match event {
                TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } => {
                    toggle_popup(tray.app_handle(), rect);
                }
                TrayIconEvent::DoubleClick { button: MouseButton::Left, .. } => {
                    hide_popup(tray.app_handle());
                    show_main(tray.app_handle());
                }
                _ => {}
            });
        if let Some(icon) = app.default_window_icon() {
            builder = builder.icon(icon.clone());
        }
        builder.build(app)?;
        Ok(())
    }

    /// Closing the main window hides it to the tray when that's turned on (and the tray icon exists); and when the
    /// main window really is gone, the app exits (the hidden popup would otherwise keep it running).
    pub fn keep_in_tray(app: &AppHandle, window: &WebviewWindow) {
        let handle = app.clone();
        let main = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if crate::global_settings::load(&handle).close_to_tray && handle.tray_by_id("main").is_some() {
                    api.prevent_close();
                    let _ = main.hide();
                } else {
                    // The window really is closing, and with it the app.
                    destroy_popup(&handle);
                }
            }
            WindowEvent::Destroyed => handle.exit(0),
            _ => {}
        });
    }

    fn toggle_popup(app: &AppHandle, icon: Rect) {
        if let Some(window) = app.get_webview_window(POPUP_LABEL) {
            if window.is_visible().unwrap_or(false) {
                let _ = window.hide();
            } else if now_ms() - HID_BY_BLUR_AT.load(Ordering::Relaxed) > 300 {
                place(app, &window, &icon);
                let _ = window.show();
                let _ = window.set_focus();
            }
            return;
        }
        let built = WebviewWindowBuilder::new(app, POPUP_LABEL, WebviewUrl::App("index.html".into()))
            .title("Save to Kinesis")
            .inner_size(POPUP_SIZE.0, POPUP_SIZE.1)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .shadow(true)
            .build();
        let Ok(window) = built else { return };
        place(app, &window, &icon);
        let _ = window.show();
        let _ = window.set_focus();
        // Set only now: the focus changes while it is being shown shouldn't hide it again at once.
        let hider = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(false) = event {
                HID_BY_BLUR_AT.store(now_ms(), Ordering::Relaxed);
                let _ = hider.hide();
            }
        });
    }

    /// Puts the popup beside the icon, on the screen the icon is on.
    fn place(app: &AppHandle, window: &WebviewWindow, icon: &Rect) {
        let pos = icon.position.to_physical::<i32>(1.0);
        let size = icon.size.to_physical::<u32>(1.0);
        let monitors = app.available_monitors().unwrap_or_default();
        let monitor = monitors
            .iter()
            .find(|m| {
                let p = m.position();
                let s = m.size();
                pos.x >= p.x && pos.x < p.x + s.width as i32 && pos.y >= p.y && pos.y < p.y + s.height as i32
            })
            .cloned()
            .or_else(|| app.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else { return };
        let work = monitor.work_area();
        let popup = window.outer_size().map(|s| (s.width, s.height)).unwrap_or((380, 460));
        let (x, y) = popup_position(
            (pos.x, pos.y, size.width, size.height),
            popup,
            (work.position.x, work.position.y, work.size.width, work.size.height),
        );
        let _ = window.set_position(PhysicalPosition::new(x, y));
    }
}

#[cfg(windows)]
pub use windows::{init, keep_in_tray};

#[cfg(test)]
mod tests {
    use super::*;

    // A 1920x1080 screen with a 40px taskbar along the bottom: the usable area is the top 1040 rows.
    const AREA: (i32, i32, u32, u32) = (0, 0, 1920, 1040);

    #[test]
    fn the_popup_sits_centered_above_an_icon_in_a_bottom_taskbar() {
        let (x, y) = popup_position((1000, 1050, 24, 24), (380, 460), AREA);
        assert_eq!(x, 1000 + 12 - 190, "centered on the icon");
        // Above the icon would put its bottom edge 8px over the taskbar; it can't go past the usable area, so it rests on it.
        assert_eq!(y, 1040 - 460, "just above the taskbar");
    }

    #[test]
    fn an_icon_near_the_right_edge_keeps_the_popup_on_screen() {
        let (x, _) = popup_position((1900, 1050, 24, 24), (380, 460), AREA);
        assert_eq!(x, 1920 - 380, "pushed back inside the screen");
    }

    #[test]
    fn an_icon_in_a_top_taskbar_opens_the_popup_below_it() {
        let area = (0, 40, 1920, 1040);
        let (_, y) = popup_position((1000, 8, 24, 24), (380, 460), area);
        assert_eq!(y, 8 + 24 + 8, "below the icon");
    }

    #[test]
    fn a_popup_bigger_than_the_area_is_pinned_to_its_top_left() {
        let (x, y) = popup_position((100, 100, 24, 24), (2000, 2000, ), (0, 0, 800, 600));
        assert_eq!((x, y), (0, 0));
    }
}
