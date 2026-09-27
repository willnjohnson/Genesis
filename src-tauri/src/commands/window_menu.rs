use tauri::command;

/// Shows the window's own system menu at the mouse pointer, the menu a right-click on a native title bar gives: Windows'
/// (Restore, Move, Size, Minimize, Maximize, Close), or on Linux the window manager's (GNOME's has Take Screenshot, Hide,
/// Always on Top and so on). The window has no native title bar (the app draws its own), so its right-click asks for the
/// menu here. True once it has been asked for; false where the platform has no such menu (the page then draws its own).
#[command]
pub async fn show_system_menu(window: tauri::WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        windows_menu::show(window).await
    }
    #[cfg(target_os = "linux")]
    {
        linux_menu::show(window).await
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let _ = window;
        false
    }
}

#[cfg(target_os = "linux")]
mod linux_menu {
    use gtk::gdk;
    use gtk::glib::translate::{ToGlibPtr, ToGlibPtrMut};
    use gtk::prelude::*;

    pub async fn show(window: tauri::WebviewWindow) -> bool {
        // GTK only works from the thread that owns the window.
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let on_main = window.clone();
        if window
            .run_on_main_thread(move || {
                let _ = tx.send(on_main.gtk_window().is_ok_and(|w| popup(&w)));
            })
            .is_err()
        {
            return false;
        }
        tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
            .await
            .unwrap_or(false)
    }

    /// GTK asks the window manager for its window menu (X11 and Wayland both have a request for it), but only with the
    /// mouse press that asked for it in hand. The right-click itself went to the webview, so an equivalent press is
    /// made up from where the pointer is now: on Wayland the compositor checks it against the seat's last real press,
    /// which is that right-click; on X11 it goes by the pointer's place on the screen.
    fn popup(gtk_window: &gtk::ApplicationWindow) -> bool {
        let Some(gdk_window) = gtk_window.window() else { return false };
        let Some(pointer) = gdk_window.display().default_seat().and_then(|seat| seat.pointer()) else { return false };
        let (_, x, y, _) = gdk_window.device_position_double(&pointer);
        let (_, x_root, y_root) = pointer.position_double();

        let mut event = gdk::Event::new(gdk::EventType::ButtonPress);
        event.set_device(Some(&pointer));
        unsafe {
            let button = &mut (*ToGlibPtrMut::<*mut gdk::ffi::GdkEvent>::to_glib_none_mut(&mut event).0).button;
            // The event owns this reference: freeing the event releases it.
            button.window = ToGlibPtr::<*mut gdk::ffi::GdkWindow>::to_glib_full(&gdk_window);
            button.send_event = 1;
            button.time = gtk::current_event_time();
            button.x = x;
            button.y = y;
            button.x_root = x_root;
            button.y_root = y_root;
            button.button = 3;
        }
        gdk_window.show_window_menu(&mut event)
    }
}

#[cfg(windows)]
mod windows_menu {
    use windows::Win32::Foundation::{HWND, POINT};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnableMenuItem, GetCursorPos, GetSystemMenu, PostMessageW, SetForegroundWindow, SetMenuDefaultItem,
        TrackPopupMenuEx, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, SC_MAXIMIZE, SC_MINIMIZE, SC_MOVE, SC_RESTORE,
        SC_SIZE, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_SYSCOMMAND,
    };
    use windows::Win32::Foundation::{LPARAM, WPARAM};

    pub async fn show(window: tauri::WebviewWindow) -> bool {
        let Ok(hwnd) = window.hwnd() else { return false };
        let raw = hwnd.0 as isize;
        let maximized = window.is_maximized().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        let resizable = window.is_resizable().unwrap_or(true);

        // The menu has to run on the thread that owns the window. Its pop-up loop returns when a choice is made or
        // the menu is dismissed, so the result comes back over a channel and is waited for off the UI thread.
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        if window
            .run_on_main_thread(move || {
                let shown = unsafe { popup(raw, maximized, minimized, resizable) };
                let _ = tx.send(shown);
            })
            .is_err()
        {
            return false;
        }
        tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(false))
            .await
            .unwrap_or(false)
    }

    /// Fills in which entries apply to the window's state (a native title bar does this itself), shows the menu, and
    /// hands the chosen command to the window as a system command, as a click in a native title bar would.
    unsafe fn popup(raw: isize, maximized: bool, minimized: bool, resizable: bool) -> bool {
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        let menu = GetSystemMenu(hwnd, false);
        if menu.is_invalid() {
            return false;
        }
        let enable = |id: u32, on: bool| {
            let _ = EnableMenuItem(menu, id, MF_BYCOMMAND | if on { MF_ENABLED } else { MF_GRAYED });
        };
        enable(SC_RESTORE, maximized || minimized);
        enable(SC_MOVE, !maximized && !minimized);
        enable(SC_SIZE, resizable && !maximized && !minimized);
        enable(SC_MINIMIZE, !minimized);
        enable(SC_MAXIMIZE, resizable && !maximized);
        // The entry in bold is what a double-click on the title bar does.
        let _ = SetMenuDefaultItem(menu, if maximized { SC_RESTORE } else { SC_MAXIMIZE }, 0);

        let mut at = POINT::default();
        if GetCursorPos(&mut at).is_err() {
            return false;
        }
        // The window has to be in front, or the menu doesn't close when something else is clicked.
        let _ = SetForegroundWindow(hwnd);
        let command = TrackPopupMenuEx(menu, (TPM_RETURNCMD | TPM_RIGHTBUTTON).0, at.x, at.y, hwnd, None);
        if command.0 != 0 {
            let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(command.0 as usize), LPARAM(0));
        }
        true
    }
}
