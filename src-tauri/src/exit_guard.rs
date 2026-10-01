//! Leaving the app with an unsaved edit: the page gets a say first.
//!
//! Every way out (closing the main window, from its title bar, Alt+F4 or the taskbar, and the tray icon's "Quit")
//! comes here instead of exiting straight away. The page is asked (EXIT_REQUESTED_EVENT); it answers at once with
//! `exit_allow` when nothing is unsaved, or with `exit_hold` while it asks the user (the Sidebar's Save / Discard /
//! Cancel), then `exit_allow` or `exit_cancel`. A page that doesn't answer within ANSWER_MS (stuck, say) doesn't
//! keep the app open: it exits anyway.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// What the main window's page listens for (src/lib/exit-guard.ts).
pub const EXIT_REQUESTED_EVENT: &str = "kinesis://exit-requested";
const ANSWER_MS: u64 = 3000;

/// An exit is waiting on the page.
static PENDING: AtomicBool = AtomicBool::new(false);
/// The page is asking the user; don't exit on the timeout.
static HELD: AtomicBool = AtomicBool::new(false);
/// Which request the timeout belongs to (a later request's timeout mustn't act on an earlier one's answer).
static REQUEST: AtomicU64 = AtomicU64::new(0);

/// Asks the page whether the app can exit, and exits when it says so (or doesn't answer in time). Asked again while
/// the user is already deciding, it only brings the window forward.
pub fn request_exit(app: &AppHandle) {
    if PENDING.swap(true, Ordering::SeqCst) {
        if HELD.load(Ordering::SeqCst) {
            crate::tray::show_main(app);
        }
        return;
    }
    HELD.store(false, Ordering::SeqCst);
    let id = REQUEST.fetch_add(1, Ordering::SeqCst) + 1;
    if app.emit_to("main", EXIT_REQUESTED_EVENT, ()).is_err() {
        exit_now(app);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(ANSWER_MS));
        if REQUEST.load(Ordering::SeqCst) == id && PENDING.load(Ordering::SeqCst) && !HELD.load(Ordering::SeqCst) {
            log::warn!("The page didn't answer the exit request in time; exiting anyway.");
            exit_now(&handle);
        }
    });
}

fn exit_now(app: &AppHandle) {
    PENDING.store(false, Ordering::SeqCst);
    crate::tray::destroy_popup(app);
    app.exit(0);
}

/// The page is asking the user (an unsaved edit): wait, and show the window so the question can be seen (the app may
/// have been in the tray).
#[tauri::command]
pub fn exit_hold(app: AppHandle) {
    if PENDING.load(Ordering::SeqCst) {
        HELD.store(true, Ordering::SeqCst);
        crate::tray::show_main(&app);
    }
}

/// Go ahead and exit.
#[tauri::command]
pub fn exit_allow(app: AppHandle) {
    if PENDING.load(Ordering::SeqCst) {
        exit_now(&app);
    }
}

/// The user chose to stay.
#[tauri::command]
pub fn exit_cancel() {
    HELD.store(false, Ordering::SeqCst);
    PENDING.store(false, Ordering::SeqCst);
}

/// Routes closing `window` through `request_exit`. For platforms without the tray (whose own close handler does this
/// on Windows, see tray.rs, after deciding whether to hide to the tray instead).
#[cfg(not(windows))]
pub fn guard_close(app: &AppHandle, window: &tauri::WebviewWindow) {
    let handle = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            request_exit(&handle);
        }
    });
}
