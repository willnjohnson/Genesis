import { useEffect, useRef } from "react";
import { getSyncStatus, syncRun } from "../api";

// Dispatched by the Sync tab whenever the connection or the auto-sync schedule changes, so this
// hook re-reads its schedule instead of waiting for the next app start.
export const SYNC_OPTIONS_CHANGED_EVENT = "kinesis-sync-options-changed";

const STARTUP_DELAY_MS = 3000;

/**
 * Runs a sync shortly after the app starts and then on the user's chosen interval, when a server
 * is connected and auto-sync is on. `onApplied` fires only when the sync actually changed
 * something the app holds in memory (content, enforced settings, the license).
 */
export function useAutoSync(onApplied: () => void) {
    const onAppliedRef = useRef(onApplied);
    useEffect(() => { onAppliedRef.current = onApplied; }, [onApplied]);

    useEffect(() => {
        let disposed = false;
        let startupTimer: ReturnType<typeof setTimeout> | null = null;
        let interval: ReturnType<typeof setInterval> | null = null;

        const stopTimers = () => {
            if (startupTimer) clearTimeout(startupTimer);
            if (interval) clearInterval(interval);
            startupTimer = null;
            interval = null;
        };

        const run = async () => {
            try {
                const r = await syncRun(false);
                const changed = r.full || r.upserted > 0 || r.deleted > 0 || r.disowned > 0 || r.policy_applied > 0;
                if (!disposed && !r.cancelled && changed) onAppliedRef.current();
            } catch {
                // The Sync tab's status card shows the last error. "Already running" is expected
                // when the user is syncing by hand at the same moment.
            }
        };

        const schedule = async (atStartup: boolean) => {
            stopTimers();
            const status = await getSyncStatus().catch(() => null);
            if (disposed || !status || !status.connected || !status.auto_sync) return;
            if (atStartup) startupTimer = setTimeout(run, STARTUP_DELAY_MS);
            interval = setInterval(run, status.interval_minutes * 60_000);
        };

        schedule(true);
        const onChanged = () => { schedule(false); };
        window.addEventListener(SYNC_OPTIONS_CHANGED_EVENT, onChanged);
        return () => {
            disposed = true;
            stopTimers();
            window.removeEventListener(SYNC_OPTIONS_CHANGED_EVENT, onChanged);
        };
    }, []);
}
