import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { BRAND } from '../branding';

/** Worth showing a native OS notification right now only when the window isn't focused — if it is, the in-app toast
 *  already says the same thing, right where the user is already looking. */
async function shouldNotify(): Promise<boolean> {
    try {
        return !(await getCurrentWindow().isFocused());
    } catch {
        return true; // Not in the app window somehow: err on the side of showing it.
    }
}

/** Asks for the OS notification permission the first time it's actually needed, rather than at startup with no
 *  reason attached. Silently does nothing where the platform has no such permission, or the user said no. */
async function ensurePermission(): Promise<boolean> {
    try {
        if (await isPermissionGranted()) return true;
        return (await requestPermission()) === 'granted';
    } catch {
        return false;
    }
}

/**
 * A native OS notification (Windows' toast, macOS/Linux's notification center) for a background job finishing while
 * the window wasn't in front — Bulk Summarize being the one job in Kinesis long enough that someone would walk away
 * from it. Entirely local: nothing about it (or the library) leaves the machine. Best effort — never throws, so a
 * denied or unsupported permission never interrupts the job it's reporting on.
 */
export async function notifyBackgroundJobDone(body: string): Promise<void> {
    try {
        if (!(await shouldNotify())) return;
        if (!(await ensurePermission())) return;
        sendNotification({ title: BRAND.name, body });
    } catch { /* best effort only */ }
}
