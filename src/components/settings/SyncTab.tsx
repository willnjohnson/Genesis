import { RefreshCw, PlugZap, Unplug, Lock, KeyRound, X } from "lucide-react";
import { Toggle } from "./Toggle";
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useFlags } from "../../hooks/useFlags";
import { ProgressLine } from "../workspace/shared";
import { settingsPrimaryBtn, settingsSecondaryBtn } from "./buttons";
import { SYNC_OPTIONS_CHANGED_EVENT } from "../../hooks/useAutoSync";
import {
    getSyncStatus, syncTest, syncConnect, syncRun, syncCancel, syncSetOptions, syncDisconnect,
    type SyncStatus, type SyncReport, type SyncProgress, type SyncManifest,
} from "../../api";

interface Props {
    /** Called after anything that may have changed local data or enforced settings. */
    onSyncComplete?: () => void;
}

const INTERVAL_CHOICES = [
    { minutes: 15, label: "Every 15 minutes" },
    { minutes: 30, label: "Every 30 minutes" },
    { minutes: 60, label: "Every hour" },
    { minutes: 240, label: "Every 4 hours" },
    { minutes: 1440, label: "Once a day" },
];

const KIND_LABELS: Record<string, string> = {
    wdbs: "categories",
    video: "videos",
    video_link: "category links",
    glossary: "glossary terms",
    biography: "bios",
    custom_prompt: "custom prompts",
};

const PROVIDER_LABELS: Record<string, string> = {
    venice: "Venice AI",
    youtube: "YouTube API",
    pixabay: "Pixabay",
};

function describeManifest(m: SyncManifest): string {
    const parts: string[] = [];
    if (m.capabilities.content) parts.push("content");
    if (m.capabilities.policy) parts.push("managed settings");
    if (m.capabilities.license.length > 0) {
        parts.push(`license (${m.capabilities.license.map(p => PROVIDER_LABELS[p] ?? p).join(", ")})`);
    }
    return `Reached "${m.server_name}". It provides: ${parts.join(", ") || "nothing yet"}.`;
}

function describeReport(r: SyncReport): string {
    if (r.cancelled) return "Sync cancelled. Anything already downloaded was kept.";
    const bits: string[] = [];
    if (r.upserted) bits.push(`${r.upserted} added or updated`);
    if (r.deleted) bits.push(`${r.deleted} removed`);
    if (r.policy_applied) bits.push(`${r.policy_applied} settings managed`);
    const head = bits.length ? bits.join(", ") : "Already up to date";
    return `${r.full ? "Full resync" : "Sync"} finished. ${head}.`;
}

function formatWhen(iso: string): string {
    if (!iso) return "Never";
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function SyncTab({ onSyncComplete }: Props) {
    const [status, setStatus] = useState<SyncStatus | null>(null);
    const [url, setUrl] = useState("");
    const [token, setToken] = useState("");
    const [busy, setBusy] = useState<"test" | "connect" | "sync" | "disconnect" | null>(null);
    const [progress, setProgress] = useState<SyncProgress | null>(null);
    const [report, setReport] = useState<SyncReport | null>(null);
    const [info, setInfo] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmDisconnect, setConfirmDisconnect] = useState(false);
    const [keepData, setKeepData] = useState(true);
    // A DB owner can take away disconnecting (see lib/flags.ts).
    const { flags } = useFlags();

    const refresh = useCallback(async () => {
        try {
            const s = await getSyncStatus();
            setStatus(s);
            return s;
        } catch (e) {
            setError(String(e));
            return null;
        }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    useEffect(() => {
        const unlisten = listen<SyncProgress>("sync_progress", (event) => setProgress(event.payload));
        return () => { unlisten.then(fn => fn()); };
    }, []);

    const runSync = async (forceFull: boolean) => {
        setBusy("sync");
        setError(null);
        setInfo(null);
        setReport(null);
        setProgress(null);
        try {
            const r = await syncRun(forceFull);
            setReport(r);
            onSyncComplete?.();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
            setProgress(null);
            refresh();
        }
    };

    const handleTest = async () => {
        setBusy("test");
        setError(null);
        setInfo(null);
        try {
            setInfo(describeManifest(await syncTest(url, token)));
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
        }
    };

    const handleConnect = async () => {
        setBusy("connect");
        setError(null);
        setInfo(null);
        try {
            await syncConnect(url, token);
            // The token is write-only from here on: the backend keeps it, the UI forgets it.
            setToken("");
            setUrl("");
            await refresh();
            window.dispatchEvent(new Event(SYNC_OPTIONS_CHANGED_EVENT));
        } catch (e) {
            setError(String(e));
            setBusy(null);
            return;
        }
        setBusy(null);
        await runSync(false);
    };

    const handleDisconnect = async () => {
        setBusy("disconnect");
        setError(null);
        try {
            await syncDisconnect(keepData);
            setConfirmDisconnect(false);
            setReport(null);
            window.dispatchEvent(new Event(SYNC_OPTIONS_CHANGED_EVENT));
            onSyncComplete?.();
        } catch (e) {
            setError(String(e));
        } finally {
            setBusy(null);
            refresh();
        }
    };

    const handleOptions = async (auto: boolean, minutes: number) => {
        try {
            await syncSetOptions(auto, minutes);
            window.dispatchEvent(new Event(SYNC_OPTIONS_CHANGED_EVENT));
            refresh();
        } catch (e) {
            setError(String(e));
        }
    };

    if (!status) {
        return <div className="text-center text-[#555] text-xs py-8">{error ?? "Loading..."}</div>;
    }

    const syncing = busy === "sync" || status.running;
    const ownedTotal = Object.values(status.owned_counts).reduce((a, b) => a + b, 0);
    const inputClass = "w-full bg-black/40 border border-[#303030] rounded-lg px-3 py-2.5 text-sm text-white placeholder:text-[#555] focus:outline-none focus:border-[#555]";
    const primaryBtn = settingsPrimaryBtn;
    const secondaryBtn = settingsSecondaryBtn;

    return (
        <div className="space-y-6 animate-in slide-in-from-right-4 duration-300">
            <div>
                <h3 className="text-base font-bold mb-2">Sync</h3>
                <p className="text-[11px] text-[#aaaaaa] leading-relaxed">
                    Connect to a sync server to receive its curated library content, settings and, if it offers one, a license
                    so you don't need your own API keys. Your own videos and notes stay untouched; the server only ever changes what it provided.
                    Nothing is uploaded, and your API keys are never shared.
                </p>
            </div>

            {!status.connected ? (
                <div className="bg-[#121212] border border-[#303030] rounded-xl p-5 space-y-3">
                    <div>
                        <label className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">Server address</label>
                        <input
                            className={inputClass}
                            value={url}
                            onChange={(e) => setUrl(e.target.value)}
                            placeholder="sync.example.com"
                            spellCheck={false}
                            autoCapitalize="off"
                        />
                    </div>
                    <div>
                        <label className="text-[10px] uppercase font-bold text-[#aaaaaa] tracking-widest block mb-2">Access token (if your server needs one)</label>
                        <input
                            className={inputClass}
                            type="password"
                            value={token}
                            onChange={(e) => setToken(e.target.value)}
                            placeholder="Paste the token you were given"
                            autoComplete="off"
                        />
                    </div>
                    <div className="flex gap-2 pt-1">
                        <button onClick={handleTest} disabled={busy !== null || !url.trim()} className={`flex-1 ${secondaryBtn}`}>
                            <PlugZap className="w-3.5 h-3.5" />
                            {busy === "test" ? "Testing..." : "Test connection"}
                        </button>
                        <button onClick={handleConnect} disabled={busy !== null || !url.trim()} className={`flex-1 ${primaryBtn}`}>
                            <RefreshCw className="w-3.5 h-3.5" />
                            {busy === "connect" ? "Connecting..." : "Connect & sync"}
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <div className="bg-[#121212] border border-[#303030] rounded-xl p-5 space-y-4">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                                <div className="text-sm font-bold truncate">{status.server_name || "Sync server"}</div>
                                <code className="text-[11px] text-[#888888] break-all font-mono">{status.server_url}</code>
                            </div>
                            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-green-400 bg-green-900/20 border border-green-500/30 rounded-full px-2 py-0.5">
                                Connected
                            </span>
                        </div>

                        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                            <dt className="text-[#aaaaaa]">Last sync</dt>
                            <dd className="text-right">{formatWhen(status.last_sync_at)}</dd>
                            <dt className="text-[#aaaaaa]">Provided by server</dt>
                            <dd className="text-right">
                                {ownedTotal === 0
                                    ? "Nothing yet"
                                    : Object.entries(status.owned_counts)
                                        .map(([k, n]) => `${n.toLocaleString()} ${KIND_LABELS[k] ?? k}`)
                                        .join(", ")}
                            </dd>
                            <dt className="text-[#aaaaaa] flex items-center gap-1.5"><Lock className="w-3 h-3" />Managed settings</dt>
                            <dd className="text-right">{status.locked_settings.length}</dd>
                            <dt className="text-[#aaaaaa] flex items-center gap-1.5"><KeyRound className="w-3 h-3" />License</dt>
                            <dd className="text-right">
                                {status.license.providers.length === 0
                                    ? "None offered"
                                    : status.license.providers.map(p => PROVIDER_LABELS[p] ?? p).join(", ")}
                            </dd>
                        </dl>

                        {status.last_error && !error && (
                            <div className="p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs">
                                Last sync failed: {status.last_error}
                            </div>
                        )}

                        <div className="flex gap-2">
                            <button onClick={() => runSync(false)} disabled={syncing || busy !== null} className={`flex-1 ${primaryBtn}`}>
                                <RefreshCw className={`w-3.5 h-3.5 ${syncing ? "animate-spin" : ""}`} />
                                {syncing ? "Syncing..." : "Sync now"}
                            </button>
                            {syncing ? (
                                <button onClick={() => syncCancel()} className={secondaryBtn}>
                                    <X className="w-3.5 h-3.5" />
                                    Cancel
                                </button>
                            ) : (
                                <button
                                    onClick={() => runSync(true)}
                                    disabled={busy !== null}
                                    title="Re-downloads everything and restores any provided item you've edited locally"
                                    className={secondaryBtn}
                                >
                                    Full resync
                                </button>
                            )}
                        </div>

                        {syncing && progress && (
                            <ProgressLine message={`${progress.message}${progress.upserted > 0 ? ` ${progress.upserted.toLocaleString()} items` : ""}`} />
                        )}
                    </div>

                    <div className="bg-[#121212] border border-[#303030] rounded-xl p-5 space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <div className="text-sm font-bold">Sync automatically</div>
                                <div className="text-[11px] text-[#aaaaaa]">When the app starts, and then on a schedule while it's open.</div>
                            </div>
                            <Toggle
                                on={status.auto_sync}
                                label="Sync automatically"
                                onChange={() => handleOptions(!status.auto_sync, status.interval_minutes)}
                            />
                        </div>
                        {status.auto_sync && (
                            <select
                                value={status.interval_minutes}
                                onChange={(e) => handleOptions(true, Number(e.target.value))}
                                className="w-full bg-black/40 border border-[#303030] rounded-lg px-3 py-2 text-sm text-white focus:outline-none"
                            >
                                {INTERVAL_CHOICES.map(c => <option key={c.minutes} value={c.minutes}>{c.label}</option>)}
                                {!INTERVAL_CHOICES.some(c => c.minutes === status.interval_minutes) && (
                                    <option value={status.interval_minutes}>Every {status.interval_minutes} minutes</option>
                                )}
                            </select>
                        )}
                    </div>

                    {flags.allowSyncDisconnect && (
                    <div className="bg-[#121212] border border-[#303030] rounded-xl p-5 space-y-3">
                        <div className="text-sm font-bold">Disconnect</div>
                        {!confirmDisconnect ? (
                            <button onClick={() => setConfirmDisconnect(true)} disabled={busy !== null || syncing} className={secondaryBtn}>
                                <Unplug className="w-3.5 h-3.5" />
                                Disconnect from server
                            </button>
                        ) : (
                            <div className="space-y-3">
                                <label className="flex items-start gap-2 text-xs cursor-pointer">
                                    <input type="radio" checked={keepData} onChange={() => setKeepData(true)} className="mt-0.5" />
                                    <span><strong>Keep</strong> what the server provided; it becomes your own data.</span>
                                </label>
                                <label className="flex items-start gap-2 text-xs cursor-pointer">
                                    <input type="radio" checked={!keepData} onChange={() => setKeepData(false)} className="mt-0.5" />
                                    <span><strong>Remove</strong> what the server provided (categories still holding your own videos are kept).</span>
                                </label>
                                <p className="text-[11px] text-[#aaaaaa]">
                                    Either way, settings the server managed go back to your own values, and any license it provided stops working.
                                </p>
                                <div className="flex gap-2">
                                    <button onClick={() => setConfirmDisconnect(false)} disabled={busy !== null} className={`flex-1 ${secondaryBtn}`}>Cancel</button>
                                    <button onClick={handleDisconnect} disabled={busy !== null} className={`flex-1 ${primaryBtn}`}>
                                        {busy === "disconnect" ? "Disconnecting..." : "Disconnect"}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                    )}
                </>
            )}

            {info && (
                <div className="p-3 bg-blue-900/10 border border-blue-500/30 rounded-lg text-blue-300 text-xs leading-relaxed">{info}</div>
            )}
            {error && (
                <div className="p-3 bg-red-900/20 border border-red-500/30 rounded-lg text-red-400 text-xs break-words">{error}</div>
            )}
            {report && (
                <div className="p-3 bg-green-900/10 border border-green-500/30 rounded-lg text-green-400 text-xs leading-relaxed">
                    {describeReport(report)}
                    {report.error_count > 0 && (
                        <div className="mt-2 text-yellow-400">
                            {report.error_count} item{report.error_count === 1 ? "" : "s"} couldn't be applied:
                            <ul className="list-disc ml-4 mt-1 break-words">
                                {report.errors.map((e, i) => <li key={i}>{e}</li>)}
                            </ul>
                        </div>
                    )}
                    {report.policy_dropped > 0 && (
                        <div className="mt-2 text-yellow-400">
                            The server sent {report.policy_dropped} setting{report.policy_dropped === 1 ? "" : "s"} that can't be managed remotely; they were ignored.
                        </div>
                    )}
                </div>
            )}

        </div>
    );
}
