import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { Bookmark, FileText, Sparkles } from 'lucide-react';
import { getVideoCard, type Video } from '../api';
import { formatDate, formatViewCount } from '../lib/video-format';
import { FloatingCard, type Side } from './FloatingCard';

const HOVER_MS = 350;

/** A video as its Library card shows it, floated beside `anchor`: thumbnail, title, channel, views and upload date, when it
 *  was saved, and whether it has a transcript and/or an AI summary (the card's own green and purple marks). */
export function VideoPreviewCard({ anchor, video, side = 'right', zIndex }: { anchor: DOMRect; video: Video; side?: Side | 'auto'; zIndex?: number }) {
    const hasTranscript = video.hasTranscript ?? !!video.transcript;
    const hasSummary = video.hasSummary ?? !!video.summary;
    return (
        <FloatingCard anchor={anchor} side={side} zIndex={zIndex} className="w-72 p-2.5 text-left">
            {video.thumbnail && (
                <div className="aspect-video w-full rounded-md overflow-hidden bg-[#1a1a1a] mb-2">
                    <img src={video.thumbnail} alt="" className="w-full h-full object-cover" />
                </div>
            )}
            <div className="text-sm font-bold text-white leading-tight line-clamp-2">{video.title}</div>
            <div className="mt-1 flex flex-col text-[12px] text-[#aaaaaa]">
                <span className="truncate">{video.author || 'YouTube Creator'}</span>
                <span className="whitespace-nowrap overflow-hidden text-ellipsis">
                    {formatViewCount(video.viewCount)} views
                    <span className="text-[8px] mx-1">•</span>
                    {formatDate(video.publishedAt)}
                </span>
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] font-medium">
                {video.dateAdded ? (
                    <span className="flex items-center gap-1 text-yellow-600 min-w-0">
                        <Bookmark className="w-2.5 h-2.5 fill-yellow-600 shrink-0" />
                        <span className="truncate">{formatDate(video.dateAdded)}</span>
                    </span>
                ) : <span />}
                <span className="flex items-center gap-2 shrink-0">
                    {hasTranscript && <span className="flex items-center gap-0.5 text-green-600"><FileText className="w-2.5 h-2.5" /> Transcript</span>}
                    {hasSummary && <span className="flex items-center gap-0.5 text-purple-500"><Sparkles className="w-2.5 h-2.5" /> AI Summary</span>}
                    {!hasTranscript && !hasSummary && <span className="text-gray-500">No transcript or summary</span>}
                </span>
            </div>
        </FloatingCard>
    );
}

/**
 * The hover preview for a video's name in a list: wire `handlers` to the name and render `card` beside it. It opens once
 * the pointer has rested there a moment, and closes on leaving, a click, or a scroll, like the app's other previews
 * (GlossaryPreview). `known` is the video when the list already has all of it; otherwise its card is looked up (without
 * the transcript, so it stays quick). `zIndex` lifts the card over a dialog the list sits in (FloatingCard's default sits
 * below dialogs, z-100).
 */
export function useVideoPreview(videoId: string, known?: Video, zIndex?: number) {
    return useHoverCard<Video>(
        () => (known ? Promise.resolve(known) : getVideoCard(videoId)),
        (rect, video) => <VideoPreviewCard anchor={rect} video={video} zIndex={zIndex} />,
    );
}

/**
 * A card that opens beside an element once the pointer has rested on it a moment, and closes on leaving, a click, or a
 * scroll. `load` fetches what it shows (null for nothing, so no card opens); `render` draws it at the element's
 * rectangle. Wire `handlers` to the element and render `card`. The video preview above and the sequence link's
 * "playlist" card (SequenceCard.tsx) both use it.
 */
export function useHoverCard<T>(load: () => Promise<T | null>, render: (rect: DOMRect, data: T) => ReactNode) {
    const [open, setOpen] = useState<{ rect: DOMRect; data: T } | null>(null);
    const timer = useRef(0);
    const attempt = useRef(0);

    const close = () => {
        window.clearTimeout(timer.current);
        attempt.current++;
        setOpen(null);
    };
    useEffect(() => {
        if (!open) return;
        document.addEventListener('scroll', close, true);
        document.addEventListener('pointerdown', close, true);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('scroll', close, true);
            document.removeEventListener('pointerdown', close, true);
            window.removeEventListener('blur', close);
        };
    }, [open]);
    useEffect(() => close, []);

    const handlers = {
        onMouseEnter: (e: MouseEvent<HTMLElement>) => {
            const el = e.currentTarget;
            const id = ++attempt.current;
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => {
                load().then(data => {
                    // The pointer may have moved on (and back, starting a new attempt) while this was fetched.
                    if (data && attempt.current === id && el.isConnected) setOpen({ rect: el.getBoundingClientRect(), data });
                }).catch(() => {});
            }, HOVER_MS);
        },
        onMouseLeave: close,
    };

    const card = open && render(open.rect, open.data);
    return { handlers, card };
}
