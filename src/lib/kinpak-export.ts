// A Kinpak export runs in the backend and can take minutes on a big library. It's tracked here, outside
// any component, so leaving Settings (which unmounts the Export tab) neither loses track of it nor
// hides how it ended: the tab reads this state when it's opened again, and the app shows a message
// when the export finishes wherever you are.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { exportKinpak, type KinpakExportSummary, type KinpakOptions } from "../api";

export interface KinpakExportState {
    running: boolean;
    /** The file being written (or last written). */
    file: string | null;
    /** The latest progress line while running. */
    progress: string | null;
    summary: KinpakExportSummary | null;
    error: string | null;
}

export interface KinpakExportResult {
    file: string;
    summary: KinpakExportSummary | null;
    error: string | null;
}

let state: KinpakExportState = { running: false, file: null, progress: null, summary: null, error: null };
const stateListeners = new Set<() => void>();
const finishListeners = new Set<(result: KinpakExportResult) => void>();

function set(next: Partial<KinpakExportState>) {
    state = { ...state, ...next };
    stateListeners.forEach(l => l());
}

/** For `useSyncExternalStore`: the snapshot is replaced (never mutated) on every change. */
export const getKinpakExportState = () => state;

export function subscribeKinpakExport(listener: () => void): () => void {
    stateListeners.add(listener);
    return () => { stateListeners.delete(listener); };
}

/** Called once each time an export ends, successfully or not. */
export function onKinpakExportFinished(listener: (result: KinpakExportResult) => void): () => void {
    finishListeners.add(listener);
    return () => { finishListeners.delete(listener); };
}

/** Starts an export to `file`. Does nothing if one is already running. Resolves when it ends. */
export async function startKinpakExport(file: string, options: KinpakOptions): Promise<void> {
    if (state.running) return;
    set({ running: true, file, progress: "Starting export...", summary: null, error: null });
    let unlisten: UnlistenFn | null = null;
    try {
        unlisten = await listen<string>("kinpak_progress", (event) => set({ progress: event.payload }));
    } catch { /* progress is nice to have; the export doesn't need it */ }

    let summary: KinpakExportSummary | null = null;
    let error: string | null = null;
    try {
        summary = await exportKinpak(file, options);
    } catch (e) {
        error = typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e);
    }
    unlisten?.();
    set({ running: false, progress: null, summary, error });
    finishListeners.forEach(l => l({ file, summary, error }));
}
