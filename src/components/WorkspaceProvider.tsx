import { useCallback, useMemo, useState, type ReactNode } from "react";
import { getWorkspaceLabels } from "../api";
import { WorkspaceContext } from "../hooks/useWorkspace";
import { DEFAULT_LABELS, withDefaults, type WorkspaceLabels } from "../lib/workspace";

/**
 * Holds the workspace name and aliases for the whole app. Like FlagsProvider it doesn't load by
 * itself: the app opens the right database first and then calls `reload()`.
 */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
    const [labels, setLabels] = useState<WorkspaceLabels>(DEFAULT_LABELS);

    const reload = useCallback(async () => {
        try {
            setLabels(withDefaults(await getWorkspaceLabels()));
        } catch (e) {
            // Keep whatever was there: a failed read must never break the app's wording.
            console.error("Couldn't read workspace names", e);
        }
    }, []);

    const value = useMemo(() => ({ labels, reload }), [labels, reload]);
    return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
