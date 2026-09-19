import { createContext, useContext } from "react";
import { DEFAULT_LABELS, type WorkspaceLabels } from "../lib/workspace";

export interface WorkspaceContextValue {
    /** The workspace name and aliases as of the last load. Defaults until then. */
    labels: WorkspaceLabels;
    /** Re-reads the names: once the database is open, after a sync, or after one is edited. */
    reload: () => Promise<void>;
}

export const WorkspaceContext = createContext<WorkspaceContextValue>({
    labels: DEFAULT_LABELS,
    reload: async () => {},
});

/** The workspace name and the aliases for Search, Library, Drive, ... (see lib/workspace.ts). */
export function useWorkspace(): WorkspaceContextValue {
    return useContext(WorkspaceContext);
}
