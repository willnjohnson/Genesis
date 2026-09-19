import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType } from 'react';
import { BookOpen, FileText, HardDrive, Search, Video as VideoIcon, X } from 'lucide-react';
import {
    decodeWdbs, getBiographies, getGlossaryTerms, getSavedVideos, getWdbsTree, searchLibrary,
    type WdbsNode,
} from '../api';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { linkKindLabel } from '../lib/internal-links';
import { driveSegmentLabel } from '../lib/utils';
import {
    buildLink, LINK_PICKER_EVENT, type LinkKind, type LinkPickerRequest,
} from '../lib/internal-links';

interface Choice {
    key: string;
    label: string;
    sub?: string;
    thumb?: string;
}

// Tab names come from linkKindLabel (the workspace's aliases).
const TABS: { kind: LinkKind; Icon: ElementType }[] = [
    { kind: 'glossary', Icon: BookOpen },
    { kind: 'bio', Icon: FileText },
    { kind: 'video', Icon: VideoIcon },
    { kind: 'drive', Icon: HardDrive },
];

const MAX_SHOWN = 200;

function flattenDrives(nodes: WdbsNode[], out: WdbsNode[] = []): WdbsNode[] {
    for (const n of nodes) {
        out.push(n);
        flattenDrives(n.children, out);
    }
    return out;
}

const matches = (query: string, ...fields: (string | null | undefined)[]) => {
    const q = query.trim().toLowerCase();
    return !q || fields.some(f => (f ?? '').toLowerCase().includes(q));
};

/**
 * The Ctrl+Shift+K pane: choose something in the app to link to (a glossary term, a channel's
 * biography, a saved video or a Drive) and a link to it is written into the markdown being edited.
 * The editor shortcut only asks for it (lib/internal-links.ts's requestLinkPicker); this one
 * component, mounted once in App, answers for every editor.
 */
export function LinkPicker() {
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    const [request, setRequest] = useState<LinkPickerRequest | null>(null);
    const [chosenTab, setChosenTab] = useState<LinkKind>('glossary');
    const [query, setQuery] = useState('');
    const [choices, setChoices] = useState<Choice[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Only what a DB owner has left switched on (see lib/flags.ts).
    const tabs = useMemo(() => TABS.filter(t => {
        if (t.kind === 'glossary') return flags.showGlossary;
        if (t.kind === 'bio') return flags.showBiography;
        if (t.kind === 'drive') return flags.showDrive;
        return true;
    }), [flags.showGlossary, flags.showBiography, flags.showDrive]);

    useEffect(() => {
        const onRequest = (e: Event) => {
            const detail = (e as CustomEvent<LinkPickerRequest>).detail;
            setQuery('');
            setError(null);
            setChoices([]);
            setRequest(detail);
        };
        window.addEventListener(LINK_PICKER_EVENT, onRequest);
        return () => window.removeEventListener(LINK_PICKER_EVENT, onRequest);
    }, []);

    // The chosen tab, or the first available one when that one is hidden.
    const tab: LinkKind = tabs.some(t => t.kind === chosenTab) ? chosenTab : (tabs[0]?.kind ?? 'glossary');

    useEffect(() => {
        if (request) setTimeout(() => inputRef.current?.focus(), 0);
    }, [request, tab]);

    // Loads what the current tab lists, narrowed by the search box. Videos are searched by the
    // backend (there can be thousands), so that tab waits a moment after typing.
    useEffect(() => {
        if (!request) return;
        let cancelled = false;
        const load = async (): Promise<Choice[]> => {
            switch (tab) {
                case 'glossary': {
                    const terms = await getGlossaryTerms();
                    return terms
                        // Quick Tags have no definition, so there is nothing to open.
                        .filter(([term, def]) => def.trim() !== '' && matches(query, term, def))
                        .map(([term, def]) => ({ key: term, label: term, sub: def.replace(/\s+/g, ' ').slice(0, 90) }));
                }
                case 'bio': {
                    const bios = await getBiographies();
                    return bios
                        .filter(b => b.handle.trim() !== '' && matches(query, b.displayName, b.handle))
                        .map(b => ({
                            key: b.handle.replace(/^@/, ''),
                            label: b.displayName.trim() || b.handle,
                            sub: b.displayName.trim() ? b.handle : undefined,
                        }));
                }
                case 'video': {
                    const opts = { limit: 30 };
                    const res = query.trim() ? await searchLibrary(query.trim(), opts) : await getSavedVideos(false, opts);
                    return res.videos.map(v => ({ key: v.id, label: v.title, sub: v.author ?? undefined, thumb: v.thumbnail }));
                }
                case 'drive': {
                    const nodes = flattenDrives(await getWdbsTree());
                    return nodes
                        .map(n => ({ n, display: decodeWdbs(n.path) }))
                        .filter(({ n, display }) => matches(query, display, n.alias, n.segment))
                        .map(({ n, display }) => ({
                            key: n.path,
                            label: n.alias ?? driveSegmentLabel(display),
                            sub: `${display} · ${n.count} video${n.count === 1 ? '' : 's'}`,
                        }));
                }
            }
        };
        const timer = setTimeout(() => {
            setLoading(true);
            load()
                .then(list => { if (!cancelled) { setChoices(list.slice(0, MAX_SHOWN)); setError(null); } })
                .catch(e => { if (!cancelled) { setChoices([]); setError(typeof e === 'string' ? e : e?.message ?? 'Failed to load.'); } })
                .finally(() => { if (!cancelled) setLoading(false); });
        }, tab === 'video' ? 200 : 0);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [request, tab, query]);

    const close = useCallback(() => {
        const ta = request?.textarea;
        setRequest(null);
        // Give the editor back the cursor and selection it had.
        if (ta && request) setTimeout(() => { ta.focus(); ta.setSelectionRange(request.start, request.end); }, 0);
    }, [request]);

    const choose = (choice: Choice) => {
        if (!request) return;
        const { textarea, start, end } = request;
        const selected = textarea.value.substring(start, end);
        const text = selected.trim() ? selected : choice.label;
        const link = buildLink(text, tab, choice.key);
        setRequest(null);
        textarea.focus();
        textarea.setSelectionRange(start, end);
        // insertText keeps the editor's undo history and makes React see the change, like the other shortcuts.
        document.execCommand('insertText', false, link);
        // The caret goes after the link, ready to carry on typing.
        setTimeout(() => textarea.setSelectionRange(start + link.length, start + link.length), 0);
    };

    if (!request || tabs.length === 0) return null;

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 p-4 animate-in fade-in duration-150" onClick={close}>
            <div
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                    if (e.key === 'Escape') { e.preventDefault(); close(); }
                    if (e.key === 'Enter' && choices[0] && document.activeElement === inputRef.current) { e.preventDefault(); choose(choices[0]); }
                }}
                className="bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full max-w-lg h-[70vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
            >
                <div className="px-5 py-3 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                    <h2 className="text-sm font-bold text-white">Link to</h2>
                    <button onClick={close} aria-label="Close" className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-5 pt-4 flex items-center gap-4">
                    {tabs.map(({ kind, Icon }) => (
                        <button
                            key={kind}
                            onClick={() => setChosenTab(kind)}
                            className={`flex items-center gap-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider transition-colors cursor-pointer relative ${tab === kind ? 'text-white' : 'text-[#666666] hover:text-[#aaaaaa]'}`}
                        >
                            <Icon className="w-3.5 h-3.5" />
                            {linkKindLabel(kind, labels)}
                            {tab === kind && <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-red-600" />}
                        </button>
                    ))}
                </div>

                <div className="px-5 pt-3">
                    <div className="flex items-center gap-2 bg-[#1a1a1a] border border-[#333] focus-within:border-red-600/50 rounded-lg px-3 transition-colors">
                        <Search className="w-3.5 h-3.5 text-[#666666] shrink-0" />
                        <input
                            ref={inputRef}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            placeholder={`${labels.aliasSearch} ${linkKindLabel(tab, labels).toLowerCase()}`}
                            className="flex-1 bg-transparent outline-none py-2 text-sm text-white placeholder-[#555]"
                        />
                    </div>
                </div>

                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 custom-scrollbar">
                    {error ? (
                        <p className="text-xs text-red-400 px-2">{error}</p>
                    ) : choices.length === 0 ? (
                        <p className="text-[11px] text-[#666666] italic px-2 py-2">{loading ? 'Loading...' : 'Nothing found.'}</p>
                    ) : (
                        <ul className="space-y-0.5">
                            {choices.map(choice => (
                                <li key={choice.key}>
                                    <button
                                        onClick={() => choose(choice)}
                                        className="w-full flex items-center gap-3 text-left px-2 py-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
                                    >
                                        {choice.thumb && (
                                            <img src={choice.thumb} alt="" loading="lazy" className="w-16 h-10 object-cover rounded-md shrink-0 bg-[#272727]" />
                                        )}
                                        <span className="min-w-0 flex flex-col">
                                            <span className="text-sm text-white truncate">{choice.label}</span>
                                            {choice.sub && <span className="text-[11px] text-[#777777] truncate">{choice.sub}</span>}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
}
