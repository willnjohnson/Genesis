import { useEffect, useState, type ReactNode } from "react";
import { getWorkspaceStatus, type WorkspaceStatus } from "../../api";
import { WorkspaceLauncher } from "./WorkspaceLauncher";
import { errText, secondaryBtn } from "./helpers";

/**
 * Holds the app back until a workspace is open. The backend opens the most recent one by itself at
 * startup; when there isn't one (a fresh install, an unplugged drive), this shows the launcher instead,
 * so nothing in the app ever runs against "no database".
 */
export function WorkspaceGate({ children }: { children: ReactNode }) {
    const [status, setStatus] = useState<WorkspaceStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        getWorkspaceStatus().then(setStatus).catch(e => setError(errText(e)));
    }, [attempt]);

    if (error) {
        return (
            <div className="fixed inset-0 bg-[#0f0f0f] text-white flex flex-col items-center justify-center gap-4 p-8">
                <p className="text-sm text-red-400 max-w-md text-center break-words">Couldn't start: {error}</p>
                <button onClick={() => { setError(null); setAttempt(a => a + 1); }} className={secondaryBtn}>Try again</button>
            </div>
        );
    }
    if (!status) return <div className="fixed inset-0 bg-[#0f0f0f]" />;
    if (!status.current) return <WorkspaceLauncher status={status} />;
    return <>{children}</>;
}
