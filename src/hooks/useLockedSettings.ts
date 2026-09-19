import { useCallback, useEffect, useState } from "react";
import { getLockedSettings } from "../api";

/** Tooltip for a control whose setting the connected sync server manages. */
export const LOCKED_TITLE = "Managed by your sync server";

/**
 * Which settings the connected sync server locks. The backend refuses writes to these keys
 * (db::set_setting), so this only exists to disable the matching controls with an explanation
 * instead of letting the user hit an error.
 */
export function useLockedSettings(): (key: string) => boolean {
    const [locked, setLocked] = useState<Set<string>>(new Set());

    useEffect(() => {
        let cancelled = false;
        getLockedSettings()
            .then(keys => { if (!cancelled) setLocked(new Set(keys)); })
            .catch(() => { /* no sync state yet: nothing is locked */ });
        return () => { cancelled = true; };
    }, []);

    return useCallback((key: string) => locked.has(key), [locked]);
}
