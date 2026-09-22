import { useEffect, useState } from 'react';
import { X, FileText, Hash, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkHighlight } from '../lib/remark-highlight';
import { markdownUrlTransform } from '../lib/internal-links';
import { MarkdownLink } from './MarkdownLink';
import { useFlags } from '../hooks/useFlags';
import { useWorkspace } from '../hooks/useWorkspace';
import { getTagVideosPreview, type Video } from '../api';
import { TagVideosPreview } from './TagVideosPreview';

interface GlossaryTerm {
    term: string;
    definition: string;
}

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
    // Which "search" buttons this modal offers is up to the DB owner (see lib/flags.ts).
    const { flags } = useFlags();
    const { labels } = useWorkspace();
    // A term has a definition; a Quick Tag doesn't. They're searched separately in the library.
    const isTerm = term.definition.trim() !== '';
    // The two search buttons were merged into one; it stays if the DB owner left either on.
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

    return (
        <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 animate-in fade-in duration-200"
            onClick={onClose}
        >
            <div
                onClick={e => e.stopPropagation()}
                className={`bg-[#0f0f0f] border border-[#303030] rounded-2xl w-full flex flex-col overflow-hidden animate-in zoom-in-95 duration-200 ${isTerm ? 'max-w-7xl h-[90vh]' : 'max-w-3xl max-h-[80vh]'}`}
            >
                {/* Header */}
                <div className="px-6 py-4 border-b border-[#303030] flex items-center justify-between bg-[#141414]">
                    <div className="flex items-center gap-3 pr-4 overflow-hidden">
                        {isTerm
                            ? <FileText className="w-5 h-5 text-gray-400 shrink-0" />
                            : <Hash className="w-5 h-5 text-gray-400 shrink-0" />}
                        <h2 className="text-xl font-bold text-white truncate">{term.term}</h2>
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
                                remarkPlugins={[remarkGfm, remarkHighlight]}
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

                {/* Footer */}
                <div className="px-6 py-4 border-t border-[#303030] flex justify-between items-center gap-4 bg-[#141414]">
                    {showSearch ? (
                        // One button for both kinds. It runs the exact Term (^) or Tag (#) search, not a free-text one.
                        <button
                            onClick={() => {
                                onSearch(`"${term.term}"`, isTerm ? 'term' : 'tag');
                                onClose();
                            }}
                            className="flex items-center gap-2 px-5 py-2 rounded-lg bg-[#222] hover:bg-[#333] text-gray-200 transition-all text-xs font-bold cursor-pointer border border-[#333] hover:border-[#444]"
                        >
                            <Search className="w-3.5 h-3.5" />
                            Search in {labels.aliasLibrary}
                        </button>
                    ) : <span />}
                    {!isTerm && tagVideos && (
                        <span className="shrink-0 px-2 py-0.5 rounded-md bg-[#222] border border-[#333] text-[11px] font-bold text-gray-300">
                            {tagTotal.toLocaleString()} {tagTotal === 1 ? 'video' : 'videos'}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
}
