import { useEffect, useState } from 'react';
import { X, FileText, Hash, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHighlight } from '../lib/remark-highlight';
import { remarkEmbeds } from '../lib/remark-embeds';
import { markdownUrlTransform } from '../lib/internal-links';
import { MarkdownLink } from './MarkdownLink';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { getTagVideosPreview, searchLibrary, type Video, type GlossaryTerm } from '../api';
import { TagVideosPreview } from './TagVideosPreview';
import { recordRecent } from '../lib/recents';

interface Props {
    term: GlossaryTerm;
    onClose: () => void;
    onSearch: (term: string, mode: 'tag' | 'term' | 'library') => void;
    /** A Quick Tag's video tiles open the video when this is given; without it they're plain. */
    onOpenVideo?: (video: Video) => void;
}

// How many of a Quick Tag's videos the preview loads (newest first); the footer button opens the rest.
const TAG_PREVIEW_LIMIT = 12;

export function TermDefinitionModal({ term, onClose, onSearch, onOpenVideo }: Props) {
    const shownDrives = term.drives;
    // Which "search" buttons this modal offers is up to the DB owner (see lib/flags.ts).
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    // A term has a definition; a Quick Tag doesn't. They're searched separately in the library.
    const isTerm = term.definition.trim() !== '';
    // Ctrl+K lists what was opened lately; a Quick Tag has no page to come back to.
    useEffect(() => { if (isTerm) void recordRecent({ kind: 'term', key: term.term, label: term.term }); }, [isTerm, term.term]);
    // For a Quick Tag, one button (showGlossarySearchByTag): there's no "general mention" search
    // that means anything different from the exact-tag one, since a Quick Tag is never auto-detected
    // from text the way a Term now is. For a Term, both independently toggleable: showGlossarySearchByTag
    // is the exact `^`-facet match (only videos actually linked to this Term), showGlossarySearchInLibrary
    // is a plain, unfaceted search for the word(s) — every video that so much as mentions it, linked or not.
    const showSearch = flags.showGlossarySearchByTag || flags.showGlossarySearchInLibrary;

    // A Quick Tag has nothing to read, so the modal shows the videos that carry it instead.
    const [tagVideos, setTagVideos] = useState<Video[] | null>(null);
    const [tagTotal, setTagTotal] = useState(0);
    const [tagError, setTagError] = useState<string | null>(null);
    useEffect(() => {
        if (isTerm) return;
        let cancelled = false;
        getTagVideosPreview(term.term, TAG_PREVIEW_LIMIT)
            .then(res => {
                if (cancelled) return;
                setTagVideos(res.videos);
                setTagTotal(res.totalCount ?? res.videos.length);
            })
            .catch(err => { if (!cancelled) setTagError(String(err)); });
        return () => { cancelled = true; };
    }, [isTerm, term.term]);

    // How many videos each footer button would actually find, shown next to it (muted, so it reads
    // as a hint rather than competing with the button itself) — a plain count query (limit 1, only
    // `totalCount` is read) through the exact same search the button itself runs, so the number is
    // never out of step with what clicking it shows. `null` while loading or if it fails; the button
    // still works either way, it just shows no count yet.
    const [linkedCount, setLinkedCount] = useState<number | null>(null);
    useEffect(() => {
        if (!isTerm || !flags.showGlossarySearchByTag) { setLinkedCount(null); return; }
        let cancelled = false;
        searchLibrary(`term_search:"${term.term}"`, { limit: 1 })
            .then(res => { if (!cancelled) setLinkedCount(res.totalCount ?? null); })
            .catch(() => { if (!cancelled) setLinkedCount(null); });
        return () => { cancelled = true; };
    }, [isTerm, term.term, flags.showGlossarySearchByTag]);

    const [generalCount, setGeneralCount] = useState<number | null>(null);
    useEffect(() => {
        if (!isTerm || !flags.showGlossarySearchInLibrary) { setGeneralCount(null); return; }
        let cancelled = false;
        searchLibrary(term.term, { limit: 1 })
            .then(res => { if (!cancelled) setGeneralCount(res.totalCount ?? null); })
            .catch(() => { if (!cancelled) setGeneralCount(null); });
        return () => { cancelled = true; };
    }, [isTerm, term.term, flags.showGlossarySearchInLibrary]);

    const resultsLabel = (n: number | null) => (n == null ? null : `${n.toLocaleString()} ${n === 1 ? 'result' : 'results'}`);
    // null while the count is still loading (or failed) — a button is only ever disabled once a real
    // 0 comes back, never just because the count hasn't arrived yet.
    const linkedResolvedCount = isTerm ? linkedCount : (tagVideos ? tagTotal : null);

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                onClick={e => e.stopPropagation()}
                className={`bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 ${isTerm ? 'max-w-4xl max-h-[85vh]' : 'max-w-3xl max-h-[80vh]'}`}
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                    <div className="flex items-center gap-3 pr-4 overflow-hidden">
                        {isTerm
                            ? <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                            : <Hash className="w-5 h-5 text-gray-400 shrink-0" />}
                        <h2 className="text-xl font-bold text-white truncate">{term.term}</h2>
                        {/* Each Drive can define a term differently, so say whose definition this is. */}
                        {shownDrives.length > 0 && (
                            <span className="min-w-0 truncate px-2 py-0.5 rounded-md bg-[#222] border border-[#333] text-[11px] font-bold text-gray-300" title={shownDrives.join(', ')}>
                                {shownDrives.map(d => d.replace(/^:/, '')).join(', ')}
                            </span>
                        )}
                    </div>
                    <button onClick={onClose} className="text-gray-500 hover:text-white transition-colors cursor-pointer">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* Content */}
                <div className="p-6 bg-[#0f0f0f] overflow-y-auto flex-1">
                    {isTerm ? (
                        // prose-sm, not prose-lg — kept in parity with BiographyModal/Sidebar's Summary
                        // panel, both of which moved off prose-lg for reading oversized next to them.
                        <div className="leading-relaxed prose dark:prose-invert prose-sm max-w-none prose-pre:bg-black/50 prose-code:text-red-400">
                            <ReactMarkdown
                                remarkPlugins={[remarkGfm, remarkHighlight, remarkEmbeds]}
     urlTransform={markdownUrlTransform}
                                components={{
                                    a: MarkdownLink,
                                    img: ({ node, ...props }) => (
                                        <img
                                            {...props}
                                            className="rounded-xl border border-white/10"
                                        />
                                    )
                                }}
                            >
                                {term.definition}
                            </ReactMarkdown>
                        </div>
                    ) : (
                        <TagVideosPreview
                            videos={tagVideos}
                            error={tagError}
                            skeletonCount={TAG_PREVIEW_LIMIT}
                            onOpenVideo={onOpenVideo ? (video) => { onOpenVideo(video); onClose(); } : undefined}
                        />
                    )}
                </div>

                {/* Footer — kept small and low-emphasis, same treatment as BiographyModal's social
                    row, so the definition/videos above stay the focus, not the controls below. */}
                <div className="px-6 py-2 border-t border-[#303030] flex justify-between items-center gap-4 bg-[#141414]">
                    {showSearch ? (
                        <div className="flex items-center gap-2 flex-wrap">
                            {flags.showGlossarySearchByTag && (
                                // The exact facet match (Term: `^`, Quick Tag: `#`) — quoted, since that's
                                // how the facet parser (parse_search_facets) delimits a multi-word value.
                                <button
                                    onClick={() => {
                                        onSearch(`"${term.term}"`, isTerm ? 'term' : 'tag');
                                        onClose();
                                    }}
                                    disabled={linkedResolvedCount === 0}
                                    title={linkedResolvedCount === 0 ? 'No videos are linked to this yet.' : undefined}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-[11px] font-bold cursor-pointer border border-[#333] hover:border-[#444] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#222] disabled:hover:border-[#333]"
                                >
                                    <Search className="w-3 h-3" />
                                    {isTerm ? 'Search Term Where Glossary-Linked' : `Search in ${labels.aliasLibrary}`}
                                    {resultsLabel(linkedResolvedCount) && (
                                        <span className="font-normal text-[#888888] whitespace-nowrap">{resultsLabel(linkedResolvedCount)}</span>
                                    )}
                                </button>
                            )}
                            {/* Terms only (see the showSearch comment above) — and never quoted: unlike the
                                facet value above, this goes through the library's own free-text search
                                (build_fts_query), which splits on whitespace and treats a literal `"` as
                                a character to match, not a phrase delimiter. */}
                            {isTerm && flags.showGlossarySearchInLibrary && (
                                <button
                                    onClick={() => {
                                        onSearch(term.term, 'library');
                                        onClose();
                                    }}
                                    disabled={generalCount === 0}
                                    title={generalCount === 0 ? 'No videos mention this.' : undefined}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-[11px] font-bold cursor-pointer border border-[#333] hover:border-[#444] disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[#222] disabled:hover:border-[#333]"
                                >
                                    <Search className="w-3 h-3" />
                                    Search Term in General
                                    {resultsLabel(generalCount) && (
                                        <span className="font-normal text-[#888888] whitespace-nowrap">{resultsLabel(generalCount)}</span>
                                    )}
                                </button>
                            )}
                        </div>
                    ) : <span />}
                </div>
            </div>
        </div>
    );
}
