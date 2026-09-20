import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** Every workspace switch reloads the window, so the whole UI starts fresh against the new database. */
export const reloadApp = () => window.location.reload();

export const errText = (e: unknown): string => (typeof e === "string" ? e : (e as { message?: string })?.message ?? String(e));

export const primaryBtn = "bg-red-600 text-white hover:bg-red-500 px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-default";
export const secondaryBtn = "bg-[#222222] border border-[#383838] hover:bg-[#3f3f3f] text-white px-4 py-2.5 rounded-xl font-semibold text-sm transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-default";
export const inputClass = "w-full bg-black/40 border border-[#303030] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-[#555] focus:outline-none focus:border-[#555] disabled:opacity-50";
export const fieldLabel = "text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2";

/** The latest progress line from a running export or import (null while none is running). */
export function useKinpakProgress(active: boolean): string | null {
    const [message, setMessage] = useState<string | null>(null);
    useEffect(() => {
        if (!active) return;
        const unlisten = listen<string>("kinpak_progress", (event) => setMessage(event.payload));
        return () => {
            unlisten.then(fn => fn());
            // Forget it, so the next run doesn't start by showing the last one's final line.
            setMessage(null);
        };
    }, [active]);
    return active ? message : null;
}
