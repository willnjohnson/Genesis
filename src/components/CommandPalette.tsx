import { useEffect, useMemo, useRef, useState, type ElementType } from 'react';
import { BookA, FileText, HardDrive, Search, UserSearch, Video as VideoIcon } from 'lucide-react';
import { decodeWdbs, getBiographies, getGlossaryTerms, getWdbsTree, searchLibrary, type BiographyEntry, type Video, type WdbsNode } from '../api';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { driveSegmentLabel, normalizeText } from '../lib/utils';

/** One action the palette can run: going to a section, opening Settings, switching the layout... */
export interface PaletteCommand {
    id: string;
    label: string;
    /** Small text after the label. */
    hint?: string;
    icon: ElementType;
    /** Extra words that should find it ("api" for the API key page). */
    keywords?: string;
    /** Which heading it's listed under; 'Actions' unless said. Anything but 'Actions' only turns up once
     *  something's typed, so a long run of them (Settings pages) doesn't fill the empty palette. */
    group?: string;
    run: () => void;
}

interface Props {
    open: boolean;
    onClose: () => void;
    commands: PaletteCommand[];
    onOpenVideo: (video: Video) => void;
    onOpenDrive: (storagePath: string, label: string, alias: string | null) => void;
    onOpenTerm: (term: string) => void;
    onOpenBio: (handle: string) => void;
}

interface Item {
    key: string;
    group: string;
    label: string;
    sub?: string;
    icon: ElementType;
    thumb?: string;
    run: () => void;
}

// The palette's widest: the search bar it lines up with can span the whole window, which is too wide to read a list in.
const MAX_WIDTH = 640;

// How many of each kind to list, so no one kind crowds the rest out.
const LIMITS = { commands: 10, drives: 5, terms: 5, people: 5, videos: 8 };

function flattenDrives(nodes: WdbsNode[], out: WdbsNode[] = []): WdbsNode[] {
    for (const n of nodes) {
        out.push(n);
        flattenDrives(n.children, out);
    }
    return out;
}

/** How well `label` (and the extra words) match every word typed; -1 when one doesn't match at all. */
function score(tokens: string[], label: string, extra = ''): number {
    const name = normalizeText(label);
    const all = `${name} ${normalizeText(extra)}`;
    let total = 0;
    for (const t of tokens) {
        if (!all.includes(t)) return -1;
        total += name.startsWith(t) ? 4 : name.split(/[\s\-_:.,()]+/).some(w => w.startsWith(t)) ? 3 : name.includes(t) ? 2 : 1;
    }
    return total;
}

function best<T>(items: T[], tokens: string[], text: (item: T) => [string, string?], limit: number): T[] {
    return items
        .map(item => ({ item, s: score(tokens, ...text(item)) }))
        .filter(x => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map(x => x.item);
}

/**
 * Ctrl/Cmd+K: one box to jump anywhere — a view, a setting, a Drive, a glossary term, a person, or a
 * saved video — or to run a quick action. Type to narrow it; ↑↓ to choose, Enter to go, Esc to close.
 * Drives, terms and people are matched here from lists loaded when it opens; videos are searched by
 * the backend as you type (there can be thousands).
 */
export function CommandPalette({ open, onClose, commands, onOpenVideo, onOpenDrive, onOpenTerm, onOpenBio }: Props) {
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState(0);
    const [drives, setDrives] = useState<WdbsNode[]>([]);
    const [terms, setTerms] = useState<string[]>([]);
    const [people, setPeople] = useState<BiographyEntry[]>([]);
    const [videos, setVideos] = useState<Video[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    // Where the search bar on the page sits, so the palette can open right over it: the same top edge,
    // centered on it, and as wide as it up to MAX_WIDTH (null when there isn't one: it's then centered
    // near the top).
    const [anchor, setAnchor] = useState<{ left: number; top: number; width: number } | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    // Fresh lists each time it opens, so anything added since shows up.
    useEffect(() => {
        if (!open) return;
        setQuery('');
        setSelected(0);
        setVideos([]);
        let cancelled = false;
        if (flags.showDrive) getWdbsTree().then(t => { if (!cancelled) setDrives(flattenDrives(t)); }).catch(() => {});
        if (flags.showGlossary) {
            getGlossaryTerms().then(rows => {
                if (cancelled) return;
                // One entry per name (a term can have a definition per set of Drives); a Quick Tag has nothing to open.
                setTerms([...new Set(rows.filter(r => r.definition.trim() !== '').map(r => r.term))]);
            }).catch(() => {});
        }
        if (flags.showBiography) getBiographies().then(b => { if (!cancelled) setPeople(b.filter(p => p.handle.trim() !== '')); }).catch(() => {});
        setTimeout(() => inputRef.current?.focus(), 0);
        return () => { cancelled = true; };
    }, [open, flags.showDrive, flags.showGlossary, flags.showBiography]);

    useEffect(() => {
        if (!open) return;
        const measure = () => {
            const r = document.querySelector('[data-search-bar]')?.getBoundingClientRect();
            if (!r || r.width <= 0) { setAnchor(null); return; }
            // The bar's own top edge, but no wider than a comfortable list, centered on the bar.
            const width = Math.min(r.width, MAX_WIDTH);
            setAnchor({ left: r.left + (r.width - width) / 2, top: r.top, width });
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [open]);

    const tokens = useMemo(() => normalizeText(query).split(/\s+/).filter(Boolean), [query]);

    // Videos come from the backend, a moment after typing stops.
    useEffect(() => {
        if (!open || query.trim().length < 2) { setVideos([]); return; }
        let cancelled = false;
        const timer = setTimeout(() => {
            searchLibrary(query.trim(), { limit: LIMITS.videos })
                .then(res => { if (!cancelled) setVideos(res.videos.slice(0, LIMITS.videos)); })
                .catch(() => { if (!cancelled) setVideos([]); });
        }, 200);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [open, query]);

    const items = useMemo<Item[]>(() => {
        const out: Item[] = [];
        let cmds: PaletteCommand[];
        if (tokens.length) {
            const found = best(commands, tokens, c => [c.label, `${c.hint ?? ''} ${c.keywords ?? ''}`], LIMITS.commands);
            // Each heading once, its entries together (best-first within it, headings in the order they first turn up).
            const groups = [...new Set(found.map(c => c.group ?? 'Actions'))];
            cmds = groups.flatMap(g => found.filter(c => (c.group ?? 'Actions') === g));
        } else {
            cmds = commands.filter(c => (c.group ?? 'Actions') === 'Actions');
        }
        for (const c of cmds) {
            out.push({ key: `cmd:${c.id}`, group: c.group ?? 'Actions', label: c.label, sub: c.hint, icon: c.icon, run: c.run });
        }
        if (tokens.length === 0) return out;
        for (const n of best(drives, tokens, n => [n.alias ?? driveSegmentLabel(decodeWdbs(n.path)), `${decodeWdbs(n.path)} ${n.segment}`], LIMITS.drives)) {
            const display = decodeWdbs(n.path);
            const label = n.alias ?? driveSegmentLabel(display);
            out.push({
                key: `drive:${n.path}`, group: labels.aliasDriveName, label, icon: HardDrive,
                sub: `${display} · ${n.count} video${n.count === 1 ? '' : 's'}`,
                run: () => onOpenDrive(n.path, driveSegmentLabel(display), n.alias),
            });
        }
        for (const t of best(terms, tokens, t => [t], LIMITS.terms)) {
            out.push({ key: `term:${t}`, group: labels.aliasGlossary, label: t, icon: BookA, run: () => onOpenTerm(t) });
        }
        for (const p of best(people, tokens, p => [p.displayName.trim() || p.handle, p.handle], LIMITS.people)) {
            out.push({
                key: `bio:${p.handle}`, group: labels.aliasBiography, label: p.displayName.trim() || p.handle, icon: UserSearch,
                sub: p.displayName.trim() ? p.handle : undefined, run: () => onOpenBio(p.handle.replace(/^@/, '')),
            });
        }
        for (const v of videos) {
            out.push({
                key: `video:${v.id}`, group: 'Videos', label: v.title, icon: v.thumbnail ? VideoIcon : FileText,
                sub: v.author ?? undefined, thumb: v.thumbnail || undefined, run: () => onOpenVideo(v),
            });
        }
        return out;
    }, [tokens, commands, drives, terms, people, videos, labels, onOpenDrive, onOpenTerm, onOpenBio, onOpenVideo]);

    // Keep the highlighted row on screen (and inside the list) as the list changes.
    useEffect(() => {
        if (selected >= items.length) setSelected(Math.max(0, items.length - 1));
    }, [items.length, selected]);
    useEffect(() => {
        listRef.current?.querySelector<HTMLElement>(`[data-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
    }, [selected, items]);

    if (!open) return null;

    const choose = (item: Item | undefined) => {
        if (!item) return;
        onClose();
        // After it closes, so the thing it opens takes focus and any modal it raises isn't under it.
        setTimeout(item.run, 0);
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => (items.length ? (s + 1) % items.length : 0)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => (items.length ? (s - 1 + items.length) % items.length : 0)); }
        else if (e.key === 'Enter') { e.preventDefault(); choose(items[selected]); }
    };

    let lastGroup = '';
    return (
        <div className={`fixed inset-0 z-[200] bg-black/60 animate-in fade-in duration-150 ${anchor ? '' : 'flex items-start justify-center px-4 pt-[12vh]'}`} onClick={onClose}>
            <div
                onClick={e => e.stopPropagation()}
                onKeyDown={onKeyDown}
                style={anchor ? { position: 'absolute', left: anchor.left, top: anchor.top, width: anchor.width } : undefined}
                className={`${anchor ? '' : 'w-full max-w-xl'} bg-[#141414] border border-[#303030] rounded-xl shadow-2xl overflow-hidden k-reveal-down`}
                role="dialog"
                aria-label="Command palette"
            >
                <div className="flex items-center gap-3 px-4 h-11 border-b border-[#303030]">
                    <Search className="w-4 h-4 text-gray-500 shrink-0" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={e => { setQuery(e.target.value); setSelected(0); }}
                        placeholder={`Search sections, ${labels.aliasDriveName.toLowerCase()}s, terms, people, videos…`}
                        className="flex-1 min-w-0 h-full bg-transparent text-[16px] text-white placeholder-gray-600 outline-none"
                        spellCheck={false}
                    />
                    <kbd className="text-[10px] text-gray-500 border border-[#333] rounded px-1.5 py-0.5 shrink-0">ESC</kbd>
                </div>

                <div ref={listRef} className="max-h-[50vh] overflow-y-auto custom-scrollbar py-1">
                    {items.length === 0 && (
                        <p className="px-4 py-8 text-center text-sm text-gray-500">
                            {tokens.length ? 'Nothing found.' : 'Nothing to show.'}
                        </p>
                    )}
                    {items.map((item, i) => {
                        const header = item.group !== lastGroup;
                        lastGroup = item.group;
                        const Icon = item.icon;
                        return (
                            <div key={item.key}>
                                {header && <div className="px-4 pt-2.5 pb-1 text-[10px] font-bold uppercase tracking-wider text-gray-600">{item.group}</div>}
                                <button
                                    data-row={i}
                                    onMouseMove={() => setSelected(i)}
                                    onClick={() => choose(item)}
                                    className={`w-full flex items-center gap-3 px-4 py-2 text-left cursor-pointer ${i === selected ? 'bg-[#272727]' : ''}`}
                                >
                                    {item.thumb
                                        ? <img src={item.thumb} alt="" className="w-12 h-7 object-cover rounded shrink-0" />
                                        : <Icon className="w-4 h-4 text-gray-400 shrink-0" />}
                                    <span className="flex-1 min-w-0 truncate text-sm text-white">{item.label}</span>
                                    {item.sub && <span className="max-w-[45%] truncate text-xs text-gray-500 shrink-0">{item.sub}</span>}
                                </button>
                            </div>
                        );
                    })}
                </div>

                <div className="flex items-center gap-4 px-4 py-2 border-t border-[#303030] text-[10px] text-gray-600">
                    <span><kbd className="text-gray-400">↑↓</kbd> Move</span>
                    <span><kbd className="text-gray-400">Enter</kbd> Open</span>
                    <span className="ml-auto">Command Palette</span>
                </div>
            </div>
        </div>
    );
}
