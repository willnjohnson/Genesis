import { type Video } from '../api';

interface Props {
    /** Null while loading. */
    videos: Video[] | null;
    error: string | null;
    /** How many tiles the skeleton shows while loading. */
    skeletonCount: number;
    /** Present = tiles open the video; absent = tiles are plain, non-interactive. */
    onOpenVideo?: (video: Video) => void;
}

/** The videos carrying a Quick Tag, as a small thumbnail grid. The modal owns the fetch so it can
 *  show the total in its header and footer. */
export function TagVideosPreview({ videos, error, skeletonCount, onOpenVideo }: Props) {
    if (error) {
        return <p className="text-sm text-red-400 py-8 text-center">Couldn't load videos: {error}</p>;
    }

    if (videos === null) {
        return (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                {Array.from({ length: skeletonCount }, (_, i) => (
                    <div key={i} className="flex flex-col gap-2 animate-pulse">
                        <div className="aspect-video w-full rounded-lg bg-[#272727]" />
                        <div className="h-3 w-full rounded bg-[#272727]" />
                        <div className="h-3 w-2/3 rounded bg-[#1f1f1f]" />
                    </div>
                ))}
            </div>
        );
    }

    if (videos.length === 0) {
        return <p className="text-sm text-[#aaaaaa] py-8 text-center">No videos have this tag yet.</p>;
    }

    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {videos.map(video => {
                const tile = (
                    <>
                        <div className="aspect-video w-full rounded-lg overflow-hidden bg-[#272727]">
                            <img
                                src={video.thumbnail}
                                alt=""
                                loading="lazy"
                                className={`w-full h-full object-cover ${onOpenVideo ? 'group-hover:scale-105 transition-transform duration-500' : ''}`}
                            />
                        </div>
                        <div className="flex flex-col overflow-hidden text-left">
                            <span className="text-xs font-bold text-white line-clamp-2 leading-tight">{video.title}</span>
                            <span className="text-[10px] text-[#aaaaaa] truncate">{video.author || 'YouTube Creator'}</span>
                        </div>
                    </>
                );
                return onOpenVideo ? (
                    <button key={video.id} onClick={() => onOpenVideo(video)} className="group flex flex-col gap-2 cursor-pointer rounded-lg">
                        {tile}
                    </button>
                ) : (
                    <div key={video.id} className="flex flex-col gap-2">{tile}</div>
                );
            })}
        </div>
    );
}
