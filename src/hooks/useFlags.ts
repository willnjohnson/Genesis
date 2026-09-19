import { createContext, useContext } from "react";
import { resolveFlags, type ResolvedFlags } from "../lib/flags";

export interface FlagsContextValue {
    /** The flags (and the rules tying them together) as of the last load. Defaults until then. */
    flags: ResolvedFlags;
    /** False until the first read of the settings table has finished. */
    loaded: boolean;
    /** Re-reads every flag: after a sync, after the Settings window closes, or once the database is open. */
    reload: () => Promise<void>;
}

export const FlagsContext = createContext<FlagsContextValue>({
    flags: resolveFlags({}),
    loaded: false,
    reload: async () => {},
});

/** The feature flags a DB owner has set (see lib/flags.ts). */
export function useFlags(): FlagsContextValue {
    return useContext(FlagsContext);
}
