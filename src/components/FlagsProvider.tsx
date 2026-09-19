import { useCallback, useMemo, useState, type ReactNode } from "react";
import { getSettings } from "../api";
import { FlagsContext } from "../hooks/useFlags";
import { FLAG_KEYS, resolveFlags, type ResolvedFlags } from "../lib/flags";

/**
 * Holds the feature flags for the whole app. It does not load anything by itself: the app opens the
 * right database first (App.tsx may switch to a saved location) and then calls `reload()`, so the
 * flags always come from the database actually in use.
 */
export function FlagsProvider({ children }: { children: ReactNode }) {
    const [flags, setFlags] = useState<ResolvedFlags>(() => resolveFlags({}));
    const [loaded, setLoaded] = useState(false);

    const reload = useCallback(async () => {
        try {
            setFlags(resolveFlags(await getSettings(FLAG_KEYS)));
        } catch (e) {
            // Keep whatever was there (the defaults on first load): a failed read must never hide the app.
            console.error("Couldn't read feature flags", e);
        } finally {
            setLoaded(true);
        }
    }, []);

    const value = useMemo(() => ({ flags, loaded, reload }), [flags, loaded, reload]);
    return <FlagsContext.Provider value={value}>{children}</FlagsContext.Provider>;
}
