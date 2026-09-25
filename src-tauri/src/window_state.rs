//! Restoring and remembering where the main window was: its size (including a custom one dragged
//! out by hand), its position on the desktop, and whether it was maximized. Saved into the
//! machine-global display settings (global_settings.rs) as the window moves, and read back at launch,
//! where a saved size or position that no longer fits the screens is corrected before the window is
//! shown (a smaller monitor, a disconnected one, a changed resolution).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewWindow, WindowEvent};

use crate::global_settings;

/// Settings > Display's window sizes (src/components/settings/DisplayTab.tsx's RESOLUTIONS — keep in
/// step). A window too big for its screen shrinks to the largest of these that fits.
const PRESETS: [(u32, u32); 7] = [(800, 600), (1024, 768), (1280, 720), (1440, 900), (1600, 900), (1920, 1080), (2560, 1440)];

const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);

/// A rectangle in physical pixels on the whole desktop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Area {
    pub x: i32,
    pub y: i32,
    pub w: u32,
    pub h: u32,
}

/// One monitor's usable area (its work area: without the taskbar) and its scale factor.
#[derive(Clone, Copy, Debug)]
pub struct Screen {
    pub area: Area,
    pub scale: f64,
}

/// What was saved: size in logical pixels, position (physical) if one was ever recorded.
#[derive(Clone, Copy, Debug)]
pub struct Saved {
    pub width: f64,
    pub height: f64,
    pub position: Option<(i32, i32)>,
    pub maximized: bool,
}

/// What to open the window with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plan {
    pub width: f64,
    pub height: f64,
    pub position: Option<(i32, i32)>,
    pub maximized: bool,
}

/// "1440x900" -> (1440.0, 900.0).
pub fn parse_resolution(raw: &str) -> Option<(f64, f64)> {
    let (w, h) = raw.split_once('x')?;
    let (w, h) = (w.trim().parse::<f64>().ok()?, h.trim().parse::<f64>().ok()?);
    (w > 0.0 && h > 0.0).then_some((w, h))
}

/// `(w, h)` if it fits in `(max_w, max_h)`; otherwise the largest of Settings > Display's sizes that
/// does — never bigger than the screen. When even the smallest doesn't fit, the screen's own size
/// (but never below the window's minimum).
pub fn fit_size(w: f64, h: f64, max_w: f64, max_h: f64) -> (f64, f64) {
    if w <= max_w && h <= max_h {
        return (w, h);
    }
    PRESETS
        .iter()
        .filter(|(pw, ph)| f64::from(*pw) <= max_w && f64::from(*ph) <= max_h)
        .max_by_key(|(pw, ph)| u64::from(*pw) * u64::from(*ph))
        .map(|(pw, ph)| (f64::from(*pw), f64::from(*ph)))
        .unwrap_or_else(|| (max_w.min(w).max(crate::MIN_WINDOW_WIDTH), max_h.min(h).max(crate::MIN_WINDOW_HEIGHT)))
}

/// Whether a window at (x, y), `w` physical pixels wide, can still be grabbed by its title bar on
/// some screen: enough of its width is over a screen, and its top edge isn't above that screen or
/// down at its bottom edge.
pub fn title_bar_visible(x: i32, y: i32, w: u32, screens: &[Screen]) -> bool {
    screens.iter().any(|s| {
        let a = s.area;
        let overlap = (x + w as i32).min(a.x + a.w as i32) - x.max(a.x);
        overlap >= 160.min(w as i32) && y >= a.y - 20 && y <= a.y + a.h as i32 - 60
    })
}

/// The screen closest to a saved position (the one holding it, or the nearest when it's just off
/// every screen — a frame's shadow, a scale mismatch).
fn nearest_screen(position: (i32, i32), screens: &[Screen]) -> usize {
    let (px, py) = (i64::from(position.0) + 40, i64::from(position.1) + 20);
    let distance = |s: &Screen| {
        let a = s.area;
        let dx = (i64::from(a.x) - px).max(0).max(px - (i64::from(a.x) + i64::from(a.w)));
        let dy = (i64::from(a.y) - py).max(0).max(py - (i64::from(a.y) + i64::from(a.h)));
        dx * dx + dy * dy
    };
    (0..screens.len()).min_by_key(|&i| distance(&screens[i])).unwrap_or(0)
}

fn logical_size(s: &Screen) -> (f64, f64) {
    (f64::from(s.area.w) / s.scale, f64::from(s.area.h) / s.scale)
}

/// Decides how to open the window. The saved size is kept whenever it fits on some connected screen
/// (the one the window was on first) and only shrunk, to a preset that fits, when it's bigger than
/// every screen. The saved position is kept if the window is still reachable there; otherwise the
/// window is centered on its screen (also the first launch, when nothing was saved, and where the
/// desktop doesn't let apps place windows: `positions` false).
pub fn plan(saved: Saved, screens: &[Screen], primary: usize, positions: bool) -> Plan {
    let position = if positions { saved.position } else { None };
    if screens.is_empty() {
        return Plan { width: saved.width, height: saved.height, position, maximized: saved.maximized };
    }
    let primary = primary.min(screens.len() - 1);
    let home = position.map(|p| nearest_screen(p, screens)).unwrap_or(primary);
    let fits = |s: &Screen| {
        let (lw, lh) = logical_size(s);
        saved.width <= lw && saved.height <= lh
    };
    let fitting = if fits(&screens[home]) { Some(home) } else { (0..screens.len()).find(|&i| fits(&screens[i])) };
    let (idx, width, height) = match fitting {
        Some(i) => (i, saved.width, saved.height),
        None => {
            // Bigger than every screen: shrink to the largest that fits the biggest one (the window's own, on a tie).
            let biggest = (0..screens.len())
                .max_by_key(|&i| {
                    let (lw, lh) = logical_size(&screens[i]);
                    ((lw * lh) as u64, i == home)
                })
                .unwrap_or(home);
            let (lw, lh) = logical_size(&screens[biggest]);
            let (w, h) = fit_size(saved.width, saved.height, lw, lh);
            (biggest, w, h)
        }
    };
    let screen = screens[idx];
    let phys_w = (width * screen.scale) as u32;
    let position = match position {
        // A window that had to shrink is recentered too: where it was may no longer suit its new size.
        Some((x, y)) if idx == home && (width, height) == (saved.width, saved.height) && title_bar_visible(x, y, phys_w, screens) => (x, y),
        _ => {
            let a = screen.area;
            let x = a.x + ((f64::from(a.w) - width * screen.scale) / 2.0).max(0.0) as i32;
            let y = a.y + ((f64::from(a.h) - height * screen.scale) / 2.0).max(0.0) as i32;
            (x, y)
        }
    };
    Plan { width, height, position: positions.then_some(position), maximized: saved.maximized }
}

/// Whether the desktop lets an app read and set its window's position. Wayland doesn't: the
/// compositor places windows and doesn't say where they are (the position reads back as 0,0).
pub fn positions_supported() -> bool {
    if !cfg!(target_os = "linux") {
        return true;
    }
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default().to_lowercase();
    let on_wayland = session == "wayland" || std::env::var_os("WAYLAND_DISPLAY").is_some();
    let forced_x11 = std::env::var("GDK_BACKEND").map(|v| v.split(',').next() == Some("x11")).unwrap_or(false);
    !(on_wayland && !forced_x11)
}

/// The desktop's screens (work areas) and the index of the primary one.
fn screens(app: &AppHandle) -> (Vec<Screen>, usize) {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary_position = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let mut primary = 0;
    let list = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if Some((m.position().x, m.position().y)) == primary_position {
                primary = i;
            }
            let wa = m.work_area();
            Screen { area: Area { x: wa.position.x, y: wa.position.y, w: wa.size.width, h: wa.size.height }, scale: m.scale_factor() }
        })
        .collect();
    (list, primary)
}

/// The plan for launching now, from what was saved and the screens that are connected.
pub fn plan_for_launch(app: &AppHandle) -> Plan {
    let prefs = global_settings::load(app);
    let (width, height) = parse_resolution(&prefs.resolution).unwrap_or(DEFAULT_SIZE);
    let position = prefs.window_x.zip(prefs.window_y);
    let (screens, primary) = screens(app);
    plan(Saved { width, height, position, maximized: prefs.maximized }, &screens, primary, positions_supported())
}

/// Records the window's current size, position and maximized state. A minimized or fullscreen
/// window is left alone (its numbers aren't the window's own), and a maximized one only notes that it
/// is, so what's kept is the size and place it restores to.
fn save_now(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return };
    if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    if window.is_maximized().unwrap_or(false) {
        global_settings::update(app, |s| s.maximized = true);
        return;
    }
    let (Ok(size), Ok(position), Ok(scale)) = (window.inner_size(), window.outer_position(), window.scale_factor()) else { return };
    if size.width == 0 || size.height == 0 {
        return;
    }
    let (mut width, mut height) = ((f64::from(size.width) / scale).round() as u32, (f64::from(size.height) / scale).round() as u32);
    // Rounding at fractional scales can land a pixel off one of Settings > Display's sizes; keep that size.
    if let Some((pw, ph)) = PRESETS.iter().find(|(pw, ph)| pw.abs_diff(width) <= 1 && ph.abs_diff(height) <= 1) {
        (width, height) = (*pw, *ph);
    }
    let positions = positions_supported();
    global_settings::update(app, |s| {
        s.resolution = format!("{width}x{height}");
        if positions {
            s.window_x = Some(position.x);
            s.window_y = Some(position.y);
        }
        s.maximized = false;
    });
}

static LAST_EVENT: Mutex<Option<Instant>> = Mutex::new(None);
static SAVER_RUNNING: AtomicBool = AtomicBool::new(false);

/// When tracking began. The window manager settles a new window (places it, sizes it, applies
/// decorations) with a burst of move and resize events that aren't the user's doing; saving those
/// would overwrite what was just restored.
static TRACKING_SINCE: OnceLock<Instant> = OnceLock::new();
const SETTLE: Duration = Duration::from_millis(2500);

/// Dragging a window fires hundreds of events: save once the window has been still for a moment.
fn schedule_save(app: &AppHandle) {
    if TRACKING_SINCE.get().is_some_and(|t| t.elapsed() < SETTLE) {
        return;
    }
    *LAST_EVENT.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    if SAVER_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(250));
            let still = LAST_EVENT.lock().unwrap_or_else(|p| p.into_inner()).map_or(true, |t| t.elapsed() >= Duration::from_millis(600));
            if still {
                break;
            }
        }
        // Cleared before saving, so a move that lands while the file is being written starts another pass.
        SAVER_RUNNING.store(false, Ordering::SeqCst);
        save_now(&app);
    });
}

/// Starts remembering the window's geometry.
pub fn track(window: &WebviewWindow) {
    let _ = TRACKING_SINCE.set(Instant::now());
    let app = window.app_handle().clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) | WindowEvent::Moved(_) => schedule_save(&app),
        WindowEvent::CloseRequested { .. } => save_now(&app),
        _ => {}
    });
}

/// Some X11 window managers place a window themselves when it's first shown, ignoring where it was
/// asked to go. Shortly after it appears, put it back if it isn't where the plan said.
#[cfg(target_os = "linux")]
pub fn settle_position(window: &WebviewWindow, position: Option<(i32, i32)>) {
    let Some((x, y)) = position.filter(|_| positions_supported()) else { return };
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(500));
        if let Ok(now) = window.outer_position() {
            if (now.x - x).abs() > 8 || (now.y - y).abs() > 8 {
                let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    });
}

#[cfg(not(target_os = "linux"))]
pub fn settle_position(_: &WebviewWindow, _: Option<(i32, i32)>) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(x: i32, y: i32, w: u32, h: u32, scale: f64) -> Screen {
        Screen { area: Area { x, y, w, h }, scale }
    }

    fn saved(w: f64, h: f64, position: Option<(i32, i32)>) -> Saved {
        Saved { width: w, height: h, position, maximized: false }
    }

    #[test]
    fn resolutions_parse() {
        assert_eq!(parse_resolution("1440x900"), Some((1440.0, 900.0)));
        assert_eq!(parse_resolution("1333x777"), Some((1333.0, 777.0)));
        assert_eq!(parse_resolution("nope"), None);
        assert_eq!(parse_resolution("0x900"), None);
    }

    #[test]
    fn a_size_that_fits_is_kept_including_a_custom_one() {
        assert_eq!(fit_size(1333.0, 777.0, 1920.0, 1040.0), (1333.0, 777.0));
    }

    #[test]
    fn a_too_big_window_shrinks_to_the_largest_preset_that_fits() {
        // 1366x728 usable (a 1366x768 laptop minus the taskbar): 1280x720 is the biggest that fits.
        assert_eq!(fit_size(1920.0, 1080.0, 1366.0, 728.0), (1280.0, 720.0));
        // A 1920x1040 work area takes 1920x1080's height off the table: 1600x900 wins.
        assert_eq!(fit_size(2560.0, 1440.0, 1920.0, 1040.0), (1600.0, 900.0));
        // Only one dimension over still counts as too big.
        assert_eq!(fit_size(1500.0, 2000.0, 1920.0, 1040.0), (1600.0, 900.0));
    }

    #[test]
    fn a_screen_smaller_than_every_preset_gets_its_own_size_within_the_minimum() {
        assert_eq!(fit_size(1440.0, 900.0, 700.0, 450.0), (crate::MIN_WINDOW_WIDTH, crate::MIN_WINDOW_HEIGHT));
        assert_eq!(fit_size(1440.0, 900.0, 900.0, 550.0), (900.0, 550.0));
    }

    #[test]
    fn a_window_needs_its_title_bar_on_a_screen() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        assert!(title_bar_visible(100, 100, 1440, &screens));
        assert!(title_bar_visible(1700, 100, 1440, &screens), "220px of it is still on screen");
        assert!(!title_bar_visible(1900, 100, 1440, &screens), "just 20px of it is on screen");
        assert!(!title_bar_visible(100, -300, 1440, &screens), "title bar above the screen");
        assert!(!title_bar_visible(100, 1000, 1440, &screens), "title bar at the very bottom");
        assert!(!title_bar_visible(-3000, 100, 1440, &screens), "on a monitor that's gone");
    }

    #[test]
    fn first_launch_centers_on_the_primary_screen() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        let p = plan(saved(1440.0, 900.0, None), &screens, 0, true);
        assert_eq!((p.width, p.height), (1440.0, 900.0));
        assert_eq!(p.position, Some((240, 70)));
    }

    #[test]
    fn a_saved_position_that_is_still_reachable_is_kept() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        let p = plan(saved(1333.0, 777.0, Some((300, 120))), &screens, 0, true);
        assert_eq!((p.width, p.height, p.position), (1333.0, 777.0, Some((300, 120))));
    }

    #[test]
    fn a_position_on_a_disconnected_monitor_falls_back_to_centering() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        let p = plan(saved(1440.0, 900.0, Some((3000, 200))), &screens, 0, true);
        assert_eq!(p.position, Some((240, 70)));
    }

    #[test]
    fn a_window_bigger_than_its_screen_is_shrunk_and_recentered() {
        let screens = [screen(0, 0, 1366, 728, 1.0)];
        let p = plan(saved(1920.0, 1080.0, Some((0, 0))), &screens, 0, true);
        assert_eq!((p.width, p.height), (1280.0, 720.0));
        assert_eq!(p.position, Some((43, 4)));
    }

    #[test]
    fn the_saved_monitor_is_used_and_scale_is_accounted_for() {
        // A 4K monitor at 200% is 1920x1040 logical: a 1920x1080 window doesn't fit its height, so it
        // becomes 1600x900 and is centered on that monitor (physical coordinates, 3200px wide there).
        let screens = [screen(0, 0, 1920, 1040, 1.0), screen(1920, 0, 3840, 2080, 2.0)];
        let p = plan(saved(1920.0, 1080.0, Some((2000, 50))), &screens, 0, true);
        assert_eq!((p.width, p.height), (1600.0, 900.0));
        assert_eq!(p.position, Some((2240, 140)));
    }

    #[test]
    fn a_size_that_fits_some_other_screen_is_kept_not_shrunk() {
        // Nothing to say which screen it was on (first guess: the small primary), but it fits the big one.
        let screens = [screen(0, 0, 1366, 728, 1.0), screen(1366, 0, 2560, 1400, 1.0)];
        let p = plan(saved(1920.0, 1080.0, None), &screens, 0, true);
        assert_eq!((p.width, p.height), (1920.0, 1080.0));
        assert_eq!(p.position, Some((1686, 160)), "centered on the screen it fits");
    }

    #[test]
    fn a_position_just_off_every_screen_still_finds_its_screen() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        let p = plan(saved(1440.0, 900.0, Some((-30, 10))), &screens, 0, true);
        assert_eq!(p.position, Some((-30, 10)), "a frame's shadow doesn't count as off-screen");
        let p = plan(saved(1440.0, 900.0, Some((-30, 10))), &[screen(0, 0, 1920, 1040, 1.0), screen(1920, 0, 1000, 1040, 1.0)], 1, true);
        assert_eq!((p.width, p.height), (1440.0, 900.0), "the nearest screen is used, not the primary");
    }

    #[test]
    fn where_positions_are_not_supported_the_saved_one_is_ignored_and_none_is_set() {
        let screens = [screen(0, 0, 1920, 1040, 1.0)];
        let p = plan(saved(1333.0, 777.0, Some((300, 120))), &screens, 0, false);
        assert_eq!((p.width, p.height), (1333.0, 777.0), "the size is still restored");
        assert_eq!(p.position, None, "the compositor places the window");
    }
}
