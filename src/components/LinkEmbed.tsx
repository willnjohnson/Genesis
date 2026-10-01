import { useEffect, useState, type ReactNode } from 'react';
import { Bookmark, FileText, Sparkles } from 'lucide-react';
import { encodeWdbs, getSequenceSummary, getVideoCard, getWdbsAliases, videoThumbnail, type SequenceSummary, type Video } from '../api';
import { openInternalLink } from '../lib/internal-links';
import { formatDate, formatViewCount } from '../lib/video-format';
import { PlaylistThumb, sequenceName, TRIMMED_THUMB_IMG } from './SequenceCard';
import { useWorkspace } from '../hooks/useWorkspace';

// The card a video or playlist link on a line of its own shows as (lib/remark-embeds.ts decides which links those are).
// Clicking it opens what it points at, as the link would. While it loads it keeps its place, and a target that's gone
// (a video deleted, a playlist cleared) shows as the plain link instead, so the text never disappears.

// A fixed height, with the thumbnail filling it edge to edge on the left (16:9 wide, but never more than 45% of the card,
// so a narrow sidebar crops the picture rather than squeezing out the text) and the text beside it, every line cut short with
// an ellipsis rather than wrapping (the title gets two lines).
// `not-prose`: the text these sit in is styled by Tailwind Typography, which gives every image a big top and bottom margin
// (that's what kept the thumbnail from filling the card; the Library's cards aren't in `prose`, so they never had it).
const cardClass = 'not-prose my-2 flex w-full max-w-xl h-[104px] overflow-hidden rounded-xl border border-[#303030] bg-[#141414] text-left no-underline hover:border-[#444] hover:bg-[#181818] transition-colors cursor-pointer';
// 185px is 16:9 at the card's 104px. No aspect-ratio here: with one, the 45% width cap would also cut the height, and the
// thumbnail would sit short of the card's top and bottom. The picture crops to fill whatever box this is.
const thumbClass = 'relative h-full w-[185px] max-w-[45%] shrink-0 overflow-hidden bg-[#1a1a1a]';
const textClass = 'min-w-0 flex-1 flex flex-col justify-center gap-0.5 px-3 py-2';
const line = 'block truncate';
/** Loads what a card shows; `undefined` while loading, `null` when it's gone. */
function useLoaded<T>(load: () => Promise<T | null>, key: string): T | null | undefined {
    const [data, setData] = useState<T | null | undefined>(undefined);
    useEffect(() => {
        let alive = true;
        setData(undefined);
        load().then(d => { if (alive) setData(d); }).catch(() => { if (alive) setData(null); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key]);
    return data;
}

function Placeholder() {
    return <div className={`${cardClass} pointer-events-none`} aria-hidden><div className={thumbClass} /></div>;
}

export function VideoEmbed({ videoId, fallback }: { videoId: string; fallback: ReactNode }) {
    const video = useLoaded<Video>(() => getVideoCard(videoId), videoId);
    if (video === undefined) return <Placeholder />;
    if (video === null) return <>{fallback}</>;
    const hasTranscript = video.hasTranscript ?? !!video.transcript;
    const hasSummary = video.hasSummary ?? !!video.summary;
    return (
        <button type="button" onClick={() => openInternalLink('video', videoId)} className={cardClass} title="Open this video">
            <div className={thumbClass}>
                {/* Zoomed so its black bars fall outside the box: the picture fills the height, the sides are cropped. */}
                <img src={videoThumbnail(videoId)} alt="" loading="lazy" className={TRIMMED_THUMB_IMG} />
            </div>
            <div className={textClass}>
                <span className="text-sm font-bold text-white leading-tight line-clamp-2 [overflow-wrap:anywhere]">{video.title}</span>
                <span className={`${line} text-[12px] text-[#aaaaaa]`}>{video.author || 'YouTube Creator'}</span>
                <span className={`${line} text-[12px] text-[#aaaaaa]`}>
                    {formatViewCount(video.viewCount)} views<span className="text-[8px] mx-1">•</span>{formatDate(video.publishedAt)}
                </span>
                {/* One line too: whatever doesn't fit is cut off at the right edge (AI Summary first, then Transcript). */}
                <span className="flex items-center gap-2 overflow-hidden whitespace-nowrap text-[10px] font-medium">
                    {video.dateAdded && (
                        <span className="flex items-center gap-1 shrink-0 text-yellow-600">
                            <Bookmark className="w-2.5 h-2.5 fill-yellow-600" />{formatDate(video.dateAdded)}
                        </span>
                    )}
                    {hasTranscript && <span className="flex items-center gap-0.5 shrink-0 text-green-600"><FileText className="w-2.5 h-2.5" /> Transcript</span>}
                    {hasSummary && <span className="flex items-center gap-0.5 shrink-0 text-purple-500"><Sparkles className="w-2.5 h-2.5" /> AI Summary</span>}
                </span>
            </div>
        </button>
    );
}

export function PlaylistEmbed({ drive, fallback }: { drive: string; fallback: ReactNode }) {
    const { labels } = useWorkspace();
    const data = useLoaded<{ summary: SequenceSummary; alias: string | null }>(async () => {
        const summary = await getSequenceSummary(drive);
        if (!summary) return null;
        const storage = encodeWdbs(drive);
        const aliases = await getWdbsAliases([storage]).catch(() => ({} as Record<string, string>));
        return { summary, alias: aliases[storage] ?? null };
    }, drive);
    if (data === undefined) return <Placeholder />;
    if (data === null) return <>{fallback}</>;
    const { summary, alias } = data;
    return (
        <button type="button" onClick={() => openInternalLink('playlist', drive)} className={cardClass} title={`Open this ${labels.aliasSequence.toLowerCase()} (its first video)`}>
            <PlaylistThumb videoId={summary.firstVideoId} count={summary.count} className={thumbClass} />
            <div className={textClass}>
                <span className="text-sm font-bold text-white leading-tight line-clamp-2 [overflow-wrap:anywhere]">{sequenceName(summary.drive, alias, labels.aliasSequence)}</span>
                {/* The count beside the Drive, kept whole while the Drive's path is what gets cut short. */}
                <span className="flex min-w-0 items-baseline gap-1 text-[11px] text-gray-500">
                    <span className="truncate font-mono">{summary.drive}</span>
                    <span className="shrink-0">({summary.count} video{summary.count === 1 ? '' : 's'})</span>
                </span>
                {summary.firstTitle && <span className={`${line} text-[11px] text-gray-500`}>Starts with: {summary.firstTitle}</span>}
            </div>
        </button>
    );
}
