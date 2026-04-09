import { Save, Trash2, Bookmark, ArrowDown, ArrowUp, Calendar, Users, Sparkles } from 'lucide-react';
import { type Video } from '../api';
import { useState, useMemo, useRef, useEffect } from 'react';
import { format } from 'date-fns';

interface Props {
    videos: Video[];
    onSelect: (video: Video) => void;
    onSaveAll?: () => void;
    onDelete?: (video: Video) => void;
    saveProgress?: string | null;
    compact?: boolean;
    onSummarizeAll?: () => void;
    summarizeProgress?: string | null;
    summarizedCount?: number;
    totalCount?: number;
    isLibrary?: boolean;
    onLoadMore?: () => void;
    loadingMore?: boolean;
    allowDeletion?: boolean;
}

type SortField = 'popularity' | 'date' | 'added';
type SortOrder = 'desc' | 'asc';

export function VideoList({ videos, onSelect, onSaveAll, onDelete, saveProgress, compact = false, onSummarizeAll, summarizeProgress, summarizedCount = 0, totalCount = 0, isLibrary = false, onLoadMore, loadingMore, allowDeletion = true }: Props) {
    const [sortField, setSortField] = useState<SortField>('date');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const loadMoreRef = useRef<HTMLDivElement>(null);

    // Infinite scroll - trigger onLoadMore when sentinel comes into view
    useEffect(() => {
        if (!onLoadMore || !loadMoreRef.current) return;

        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && !loadingMore) {
                    onLoadMore();
                }
            },
            { threshold: 0.1, rootMargin: '100px' }
        );

        observer.observe(loadMoreRef.current);
        return () => observer.disconnect();
    }, [onLoadMore, loadingMore]);

    const sortedVideos = useMemo(() => {
        return [...videos].sort((a, b) => {
            let cmp = 0;
            if (sortField === 'popularity') {
                const vA = parseViewCount(a.viewCount);
                const vB = parseViewCount(b.viewCount);
                cmp = vA - vB;
            } else if (sortField === 'added') {
                const timeA = a.dateAdded ? new Date(a.dateAdded).getTime() : 0;
                const timeB = b.dateAdded ? new Date(b.dateAdded).getTime() : 0;
                cmp = timeA - timeB;
            } else {
                const timeA = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
                const timeB = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;

                const validA = !isNaN(timeA) && timeA > 0;
                const validB = !isNaN(timeB) && timeB > 0;

                if (validA && validB) {
                    cmp = timeA - timeB;
                } else if (!validA && !validB) {
                    cmp = a.title.localeCompare(b.title);
                } else {
                    cmp = validA ? 1 : -1;
                }
            }
            if (cmp === 0) return a.id.localeCompare(b.id);
            return sortOrder === 'asc' ? cmp : -cmp;
        });
    }, [videos, sortField, sortOrder]);

    const handleSortField = (field: SortField) => {
        setSortField(field);
    };

    const toggleSortOrder = () => {
        setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    };

    if (videos.length === 0) return null;

    return (
        <div className="w-full max-w-[1700px] mx-auto">
            <div className="flex flex-col sm:flex-row justify-between items-center mb-6 gap-4 px-2">
                <div className="flex items-baseline gap-2">
                    <h3 className="text-xl font-bold text-white">Videos</h3>
                    <span className="text-[#aaaaaa] text-sm font-medium">
                        ({videos.length} results)
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    {onSaveAll && (
                        <button
                            onClick={onSaveAll}
                            disabled={!!saveProgress}
                            className={`mr-4 px-3 py-1.5 bg-white text-black hover:bg-[#e5e5e5] rounded-lg text-sm font-semibold transition-colors disabled:opacity-50 flex items-center gap-2 ${!saveProgress ? 'cursor-pointer' : 'cursor-default'}`}
                        >
                            {saveProgress ? (
                                <>
                                    <div className="w-3 h-3 border-2 border-black border-t-transparent rounded-full animate-spin" />
                                    {saveProgress}
                                </>
                            ) : (
                                <>
                                    <Save className="w-4 h-4" />
                                    Save All
                                </>
                            )}
                        </button>
                    )}

                    {isLibrary && onSummarizeAll && (
                        <button
                            onClick={onSummarizeAll}
                            disabled={!!summarizeProgress}
                            className={`summarize-btn mr-4 px-3 py-1.5 bg-gradient-to-r from-purple-600 to-blue-600 text-white hover:from-purple-500 hover:to-blue-500 rounded-lg text-sm font-semibold transition-all disabled:opacity-50 flex items-center gap-2 ${!summarizeProgress ? 'cursor-pointer shadow-lg shadow-purple-900/20' : 'cursor-default'}`}
                        >
                            {summarizeProgress ? (
                                <>
                                    <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    {summarizeProgress}
                                </>
                            ) : (
                                <>
                                    <Sparkles className="w-4 h-4" />
                                    {summarizedCount > 0 ? `Summarized (${summarizedCount}/${totalCount})` : 'Summarize All'}
                                </>
                            )}
                        </button>
                    )}

                    <div className="flex items-center bg-[#1a1a1a] p-1 rounded-xl border border-[#272727] gap-1 shadow-inner">
                        <div className="flex gap-2">
                            <button
                                onClick={() => handleSortField('date')}
                                className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all cursor-pointer flex items-center gap-2 ${sortField === 'date' ? 'bg-white text-black shadow-lg scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <Calendar className="w-3.5 h-3.5" />
                                Date Added
                            </button>
                            {videos.some(v => v.dateAdded) && (
                                <button
                                    onClick={() => handleSortField('added')}
                                    className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all cursor-pointer flex items-center gap-2 ${sortField === 'added' ? 'bg-white text-black shadow-lg scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                                >
                                    <Bookmark className="w-3.5 h-3.5" />
                                    Date Bookmarked
                                </button>
                            )}
                            <button
                                onClick={() => handleSortField('popularity')}
                                className={`px-3 py-1.5 rounded-lg text-[13px] font-bold transition-all cursor-pointer flex items-center gap-2 ${sortField === 'popularity' ? 'bg-white text-black shadow-lg scale-[1.02]' : 'text-[#888888] hover:text-white hover:bg-white/5'}`}
                            >
                                <Users className="w-3.5 h-3.5" />
                                Views
                            </button>
                        </div>

                        <div className="w-px h-4 bg-[#272727] mx-1" />

                        <button
                            onClick={toggleSortOrder}
                            className="p-1.5 rounded-lg text-[#888888] hover:text-white hover:bg-white/5 transition-all cursor-pointer group flex items-center gap-1"
                            title='Sort Order ↑ ↓'
                        >
                            {sortOrder === 'desc' ? (
                                <ArrowDown className="w-4 h-4 group-active:translate-y-0.5 transition-transform" />
                            ) : (
                                <ArrowUp className="w-4 h-4 group-active:-translate-y-0.5 transition-transform" />
                            )}
                        </button>
                    </div>
                </div>
            </div>

            <div className={`grid gap-x-3 gap-y-8 ${compact ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'}`}>
                {sortedVideos.map((video) => (
                    <div
                        key={video.id}
                        className="group flex flex-col gap-2 cursor-pointer"
                        onClick={() => onSelect(video)}
                    >
                        {/* Thumbnail */}
                        <div className={`${compact ? 'aspect-[16/9]' : 'aspect-video'} w-full rounded-lg overflow-hidden bg-[#272727] relative`}>
                            <img
                                src={video.thumbnail}
                                alt={video.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                loading="lazy"
                            />
                        </div>

                        {/* Details */}
                        <div className="flex gap-2">
                            <div className="flex flex-col flex-1 overflow-hidden">
                                <h3 className={`${compact ? 'text-xs' : 'text-sm'} font-bold text-white line-clamp-2 leading-tight group-hover:text-white`}>
                                    {video.title}
                                </h3>

                                <div className={`flex flex-col text-[#aaaaaa] ${compact ? 'text-[10px]' : 'text-[13px]'}`}>
                                    <span
                                        className="truncate"
                                        title={`${(h => h ? `Handle: ${h}` : `Channel Name: ${video.author}`)(video.handle)}`}
                                    >
                                        {video.author || "YouTube Creator"}
                                    </span>

                                    <div className="flex items-center gap-1">
                                        <span title={`Views: ${parseViewCount(video.viewCount).toLocaleString('en-US')}`}>
                                            {formatViewCount(video.viewCount)} views
                                        </span>
                                        <span className="text-[8px]">•</span>
                                        <span title={`Timestamp: ${video.publishedAt || 'Unknown'}`}>
                                            {formatDate(video.publishedAt)}
                                        </span>
                                    </div>

                                    {video.dateAdded && (
                                        <div className="flex items-center gap-1 mt-0.5 text-yellow-600 font-medium text-[10px]">
                                            <Bookmark className="w-2.5 h-2.5 fill-yellow-600" />
                                            <span title={`Timestamp: ${video.dateAdded}`}>
                                                {formatDate(video.dateAdded)}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {onDelete && allowDeletion && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete(video);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#3f3f3f] rounded-full transition-all text-white self-start hover:cursor-pointer"
                                    title="Remove"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>

            {/* Sentinel for infinite scroll */}
            {onLoadMore && (
                <div ref={loadMoreRef} className="py-8 flex items-center justify-center">
                    {loadingMore && (
                        <div className="flex flex-col items-center gap-2">
                            <div className="w-8 h-8 border-4 border-[#303030] border-t-red-600 rounded-full animate-spin" />
                            <p className="font-medium text-sm text-gray-400">Loading more...</p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function formatDate(dateStr: string) {
    if (!dateStr) return 'Unknown';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) {
        return dateStr;
    }
    return format(d, 'MMM dd, yyyy');
}

function parseViewCount(count: string): number {
    if (!count || count === "Saved") return 0;
    const clean = count.toLowerCase().replace(/,/g, '').trim();
    let multiplier = 1;
    if (clean.includes('k')) multiplier = 1000;
    else if (clean.includes('m')) multiplier = 1000000;
    else if (clean.includes('b')) multiplier = 1000000000;
    const num = parseFloat(clean.replace(/[^0-9.]/g, ''));
    if (isNaN(num)) return 0;
    return Math.floor(num * multiplier);
}

function formatViewCount(count: string): string {
    if (count === "Saved") return 'Saved';
    if (!count) return '0';
    if (count.toLowerCase().includes('view')) {
        return count.split(' ')[0];
    }
    const n = parseViewCount(count);
    if (n >= 1000000000) return (n / 1000000000).toFixed(1) + 'B';
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
}

