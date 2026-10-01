import { ListVideo } from 'lucide-react';
import { encodeWdbs, getSequenceSummary, getWdbsAliases, videoThumbnail, type SequenceSummary } from '../api';
import { buildLink } from '../lib/internal-links';
import { driveSegmentLabel } from '../lib/utils';
import { FloatingCard } from './FloatingCard';
import { useHoverCard } from './VideoPreview';
import { useWorkspace } from '../hooks/useWorkspace';

// A Drive's sequence shown with its first video's thumbnail, video count, and display name. A sequence link previews
// as one (MarkdownLink.tsx), and the Link to picker lists sequences this way.

/** A sequence link's display name: its Drive's alias, or the Drive's own name, followed by its workspace label. */
export function sequenceName(drive: string, alias?: string | null, sequenceLabel = 'Sequence'): string {
    return `${alias || driveSegmentLabel(drive)} ${sequenceLabel.toLowerCase()}`;
}

/** A markdown link to a Drive's sequence, named as above. */
export function sequenceLink(drive: string, alias?: string | null, sequenceLabel = 'Sequence'): string {
    return buildLink(sequenceName(drive, alias, sequenceLabel), 'playlist', drive);
}

/**
 * A YouTube thumbnail (hqdefault, 4:3 with black bars above and below the 16:9 picture) sized to fill a box of any
 * shape without showing the bars: drawn a third taller than the box (so the bars fall outside it) and centered, with
 * the sides cropped. Put it in a `relative overflow-hidden` box.
 */
export const TRIMMED_THUMB_IMG = 'absolute left-1/2 top-1/2 h-[133.4%] w-auto min-w-full max-w-none -translate-x-1/2 -translate-y-1/2 object-cover';

/** The first video's thumbnail with the video count in its bottom-right corner, like a YouTube playlist. Size, shape
 *  and corners come from `className`: `aspect-video` for a box of its own, but not for one that fills a card's height
 *  (aspect-ratio turns a width cap into a height cap too, which would leave it short of the card). */
export function PlaylistThumb({ videoId, count, className = '' }: { videoId: string | null; count: number; className?: string }) {
    return (
        <div className={`relative shrink-0 overflow-hidden bg-[#1a1a1a] ${className}`}>
            {videoId && <img src={videoThumbnail(videoId)} alt="" loading="lazy" className={TRIMMED_THUMB_IMG} />}
            {/* Darkens toward the bottom and clears by the middle, so it reads as a playlist (more behind the first
                video) rather than a single video, and the count sits on something dark. */}
            <span
                aria-hidden
                className="absolute inset-0 pointer-events-none"
                style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.7) 25%, rgba(0,0,0,0.25) 45%, rgba(0,0,0,0) 60%)' }}
            />
            <span className="absolute bottom-1 right-1 flex items-center gap-0.5 rounded bg-black/80 px-1 py-px text-[10px] font-semibold text-white">
                <ListVideo className="w-3 h-3" />
                {count}
            </span>
        </div>
    );
}

/** A sequence card, floated beside `anchor`: thumbnail and count on the left, its name, Drive and first
 *  video on the right. */
export function SequencePreviewCard({ anchor, summary, alias, sequenceLabel = 'Sequence' }: { anchor: DOMRect; summary: SequenceSummary; alias: string | null; sequenceLabel?: string }) {
    return (
        <FloatingCard anchor={anchor} className="w-96 max-w-[calc(100vw-1rem)] p-2.5 text-left">
            <div className="flex gap-3">
                <PlaylistThumb videoId={summary.firstVideoId} count={summary.count} className="w-36 aspect-video rounded-md" />
                <div className="min-w-0 flex flex-col">
                    <span className="text-sm font-bold text-white leading-tight line-clamp-2">{sequenceName(summary.drive, alias, sequenceLabel)}</span>
                    <span className="mt-0.5 text-[11px] font-mono text-gray-500 truncate">{summary.drive}</span>
                    <span className="mt-1 text-[12px] text-[#aaaaaa]">{summary.count} video{summary.count === 1 ? '' : 's'}</span>
                    {summary.firstTitle && <span className="mt-0.5 text-[11px] text-gray-500 line-clamp-2">Starts with: {summary.firstTitle}</span>}
                </div>
            </div>
        </FloatingCard>
    );
}

/** The hover preview for a sequence link, looked up when the pointer rests on the link. No card when
 *  the Drive has no sequence any more. */
export function useSequenceLinkPreview(drive: string) {
    const { labels } = useWorkspace();
    return useHoverCard<{ summary: SequenceSummary; alias: string | null; sequenceLabel: string }>(
        async () => {
            if (!drive) return null;
            const summary = await getSequenceSummary(drive);
            if (!summary) return null;
            const storage = encodeWdbs(drive);
            const aliases = await getWdbsAliases([storage]).catch(() => ({} as Record<string, string>));
            return { summary, alias: aliases[storage] ?? null, sequenceLabel: labels.aliasSequence };
        },
        (rect, { summary, alias, sequenceLabel }) => <SequencePreviewCard anchor={rect} summary={summary} alias={alias} sequenceLabel={sequenceLabel} />,
    );
}
