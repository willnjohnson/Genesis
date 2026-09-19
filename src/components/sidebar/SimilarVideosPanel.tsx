import type { Video } from '../../api';
import { useWorkspace } from '../../hooks/useWorkspace';

interface Props {
    videos: Video[];
    loading: boolean;
    onSelect: (video: Video) => void;
}

/** Compact "more like this" list for the Sidebar's Similar Videos tab — see api.ts's
 *  getSimilarVideos (backed by db::get_similar_videos's BM25-over-FTS5 ranking). Clicking a row
 *  swaps the Sidebar to that video in place via `onSelect`, without closing it. */
export function SimilarVideosPanel({ videos, loading, onSelect }: Props) {
    const { labels } = useWorkspace();
    if (loading) {
        return (
            <p className="text-[11px] text-[#666666] italic py-2">Finding similar videos...</p>
        );
    }

    if (videos.length === 0) {
        return (
            <p className="text-[11px] text-[#666666] italic py-2">
                No similar videos found yet. Add more videos to the {labels.aliasLibrary.toLowerCase()} to increase discovery.
            </p>
        );
    }

    return (
        <div className="space-y-2 max-h-[280px] overflow-y-auto custom-scrollbar pr-1">
            {videos.map((video) => (
                <div
                    key={video.id}
                    onClick={() => onSelect(video)}
                    className="cursor-pointer flex gap-2.5 p-1.5 rounded-lg hover:bg-white/5 transition-colors"
                >
                    <img
                        src={video.thumbnail}
                        alt={video.title}
                        className="w-20 h-12 object-cover rounded-md shrink-0 bg-[#272727]"
                        loading="lazy"
                    />
                    <div className="min-w-0 flex flex-col justify-center">
                        <h4 className="text-xs text-white leading-tight line-clamp-2">{video.title}</h4>
                        <span className="text-[10px] text-[#888888] truncate mt-0.5">
                            {video.author || "YouTube Creator"}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}
