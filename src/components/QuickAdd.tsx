import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import {
    bulkSaveVideos, bulkUpdateVideoWdbs, checkVideoExists, decodeWdbs, getDisplaySettings, getSavedVideos, getVideoWdbs,
    getWdbsRoots, getWorkspaceStatus, hideQuickAdd, readClipboardText, showMainWindow,
    type Video, type WdbsRoot,
} from '../api';
import { BRAND } from '../branding';
import { BrandLogo } from './BrandLogo';
import { extractYouTubeVideoId, isYouTubeListLink } from '../lib/youtube-url';
import { applyTheme, loadCustomThemes, resolveTheme } from '../lib/themes';
import { LifeLoader } from './LifeLoader';

const LAST_DRIVE_KEY = 'kinesisQuickAddDrive';

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; title: string } | { kind: 'error'; message: string };

const readLastDrive = () => {
    try { return localStorage.getItem(LAST_DRIVE_KEY) ?? ''; } catch { return ''; }
};

/**
 * The tray icon's popup: paste (or already have on the clipboard) a YouTube link, optionally pick a Drive, and
 * save it to the open workspace's Library, without going to the main window. It's the same web app in a second,
 * small window (see tray.rs); main.tsx shows this instead of the app for it. Saving does what Save does in Search:
 * the video's details and transcript are fetched and stored (no AI summary).
 */
export function QuickAdd() {
    const [url, setUrl] = useState('');
    const [status, setStatus] = useState<Status>({ kind: 'idle' });
    // undefined: not known yet; null: no workspace is open.
    const [workspace, setWorkspace] = useState<string | null | undefined>(undefined);
    const [roots, setRoots] = useState<WdbsRoot[]>([]);
    const [drive, setDrive] = useState(readLastDrive);
    const [recent, setRecent] = useState<Video[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    // The clipboard text last put in the box, so the same link isn't put back after it was saved or cleared.
    const lastClipboard = useRef('');

    // The main window's current theme. The popup is shown and hidden rather than recreated, so this runs each time it
    // is shown (see refresh): a theme changed in Settings, or by opening a workspace with another one, carries over.
    const syncTheme = useCallback(() => {
        Promise.all([getDisplaySettings(), loadCustomThemes()])
            .then(([settings, custom]) => applyTheme(resolveTheme(settings.theme, custom)))
            .catch(() => applyTheme(resolveTheme(undefined, [])));
    }, []);

    // Everything that can have changed since the popup was last shown: which workspace is open, the Drives, what was
    // saved lately, and what's on the clipboard.
    const refresh = useCallback(async () => {
        syncTheme();
        const state = await getWorkspaceStatus().catch(() => null);
        setWorkspace(state?.current?.name ?? null);
        if (!state?.current) return;
        getWdbsRoots().then(setRoots).catch(() => setRoots([]));
        getSavedVideos(false, { sortField: 'added', sortOrder: 'desc', limit: 5 }).then(r => setRecent(r.videos)).catch(() => setRecent([]));
        const clip = (await readClipboardText().catch(() => null))?.trim() ?? '';
        // Only a real YouTube link is taken from the clipboard: any 11-letter word looks like a video ID.
        const isYouTubeLink = /youtube(?:-nocookie)?\.com\/|youtu\.be\//i.test(clip);
        if (clip && clip !== lastClipboard.current && isYouTubeLink && (extractYouTubeVideoId(clip) || isYouTubeListLink(clip))) {
            lastClipboard.current = clip;
            setUrl(clip);
            setStatus({ kind: 'idle' });
        }
    }, [syncTheme]);

    useEffect(() => {
        void refresh();
        // The popup is shown and hidden rather than recreated, so refresh whenever it is shown again.
        const onFocus = () => { void refresh(); inputRef.current?.focus(); };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') void hideQuickAdd(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const videoId = extractYouTubeVideoId(url);
    const isList = !videoId && isYouTubeListLink(url);
    const busy = status.kind === 'saving';

    const driveName = (path: string) => {
        const r = roots.find(x => x.path === path);
        return r ? (r.alias ?? r.segment) : path.replace(/^:/, '');
    };

    const save = async () => {
        if (!videoId || busy) return;
        setStatus({ kind: 'saving' });
        try {
            let title: string;
            if (await checkVideoExists(videoId)) {
                // Already in the Library. The same Drive again (or Unsorted, which is where it would land) is a
                // duplicate and is refused; a different Drive files the existing video there, with no second save.
                const home = decodeWdbs(await getVideoWdbs(videoId).catch(() => null));
                const sameDrive = !drive || home === drive || home.startsWith(`${drive}-`);
                if (sameDrive) {
                    throw new Error(`Failed: duplicate. This video is already saved${home ? ` in ${driveName(home.split('-')[0])}` : ' (unsorted)'}.`);
                }
                await bulkUpdateVideoWdbs([videoId], drive);
                title = `Already saved. Now filed under ${driveName(drive)}`;
            } else {
                const [result] = await bulkSaveVideos([videoId]);
                if (!result || result.error) throw new Error(typeof result?.error === 'string' ? result.error : "Couldn't save that video.");
                if (drive) await bulkUpdateVideoWdbs([videoId], drive);
                title = result.title || videoId;
            }
            try { localStorage.setItem(LAST_DRIVE_KEY, drive); } catch { /* remembering is a convenience */ }
            setStatus({ kind: 'saved', title });
            setUrl('');
            getSavedVideos(false, { sortField: 'added', sortOrder: 'desc', limit: 5 }).then(r => setRecent(r.videos)).catch(() => {});
        } catch (e) {
            setStatus({ kind: 'error', message: typeof e === 'string' ? e : (e as Error)?.message ?? "Couldn't save that video." });
        }
    };

    // The app's logo and name: brings the main window to the front, from the tray, minimized, or behind other windows.
    const openMain = (
        <button
            onClick={() => void showMainWindow()}
            title={`Bring ${BRAND.name} to the front`}
            className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-300 hover:text-white cursor-pointer transition-colors"
        >
            <BrandLogo className="w-4 h-4" />
            {BRAND.name}
        </button>
    );

    const hint = isList
        ? 'That is a channel or playlist link. Use Search in Kinesis for those.'
        : url.trim() && !videoId
            ? 'That doesn\'t look like a YouTube video link.'
            : null;

    return (
        <div className="h-screen flex flex-col bg-[var(--k-bg,#0f0f0f)] text-white border border-[#303030] select-none">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[#303030]">
                <div className="min-w-0">
                    <div className="text-sm font-bold">Save to {workspace ?? 'Library'}</div>
                    <div className="text-[11px] text-[#888888]">Paste a YouTube video link</div>
                </div>
                <button onClick={() => void hideQuickAdd()} title="Close" className="text-[#888888] hover:text-white cursor-pointer p-1 shrink-0">
                    <X className="w-4 h-4" />
                </button>
            </div>

            {workspace === null ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
                    <p className="text-sm text-[#aaaaaa]">No workspace is open. Open one in {BRAND.name} first, then save from here.</p>
                    {openMain}
                </div>
            ) : (
                <div className="flex-1 min-h-0 flex flex-col gap-3 p-4">
                    <input
                        ref={inputRef}
                        autoFocus
                        value={url}
                        onChange={e => { setUrl(e.target.value); if (status.kind !== 'saving') setStatus({ kind: 'idle' }); }}
                        onKeyDown={e => { if (e.key === 'Enter') void save(); }}
                        placeholder="https://www.youtube.com/watch?v=..."
                        disabled={busy}
                        className="w-full bg-[#121212] border border-[#303030] focus:border-red-600 text-white rounded-lg px-3 py-2 text-sm outline-none transition-colors select-text"
                    />
                    {hint && <p className="text-[11px] text-amber-400/90 -mt-1">{hint}</p>}

                    <div className="flex items-center gap-2">
                        <label htmlFor="quick-drive" className="text-[10px] font-bold uppercase tracking-wider text-[#888888] shrink-0">Drive</label>
                        <select
                            id="quick-drive"
                            value={drive}
                            onChange={e => setDrive(e.target.value)}
                            disabled={busy}
                            className="flex-1 min-w-0 h-8 px-2 bg-[#121212] border border-[#303030] hover:border-[#505050] rounded-lg text-xs text-white outline-none cursor-pointer"
                        >
                            <option value="">Unsorted</option>
                            {roots.map(r => <option key={r.path} value={r.path}>{r.alias ? `${r.segment} (${r.alias})` : r.segment}</option>)}
                        </select>
                        <button
                            onClick={() => void save()}
                            disabled={!videoId || busy}
                            className="shrink-0 h-8 px-4 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 disabled:cursor-default text-white text-xs font-bold cursor-pointer transition-colors"
                        >
                            Save
                        </button>
                    </div>

                    {/* Only there (and only as tall as what it says) when there is something to report: no reserved gap. */}
                    {status.kind !== 'idle' && (
                    <div>
                        {status.kind === 'saving' && (
                            <div className="flex items-center gap-3">
                                <LifeLoader cell={5} gap={1} />
                                <span className="text-xs text-[#aaaaaa]">Saving</span>
                            </div>
                        )}
                        {status.kind === 'saved' && (
                            <div className="flex items-start gap-3 text-xs">
                                <Check className="w-4 h-4 shrink-0 text-green-400 mt-0.5" />
                                <div className="min-w-0">
                                    <div className="font-bold text-green-400">Saved</div>
                                    <div className="mt-1 text-white break-words">{status.title}</div>
                                </div>
                            </div>
                        )}
                        {status.kind === 'error' && <p className="text-xs text-red-400 break-words">{status.message}</p>}
                    </div>
                    )}

                    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                        {recent.length > 0 && (
                            <>
                                <div className="text-[10px] font-bold uppercase tracking-wider text-[#888888] mb-1">Recently saved</div>
                                <ul className="space-y-1">
                                    {recent.map(v => (
                                        <li key={v.id} className="flex items-center gap-2">
                                            <img src={v.thumbnail} alt="" className="w-12 h-7 object-cover rounded shrink-0 bg-[#272727]" />
                                            <span className="min-w-0 truncate text-xs text-[#cccccc]" title={v.title}>{v.title}</span>
                                        </li>
                                    ))}
                                </ul>
                            </>
                        )}
                    </div>
                </div>
            )}

            <div className="px-4 py-2 border-t border-[#303030] flex items-center justify-between text-[10px] text-gray-600">
                <span>Esc to close</span>
                {openMain}
            </div>
        </div>
    );
}
