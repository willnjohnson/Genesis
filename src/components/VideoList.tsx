import { Save, Trash2, Bookmark, ArrowDown, ArrowUp, Calendar, Users, Sparkles, FileText } from 'lucide-react';
import { type Video, fetchImageAsDataUri, saveImage } from '../api';
import { useState, useMemo } from 'react';
import { format } from 'date-fns';
import { save } from '@tauri-apps/plugin-dialog';

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
    allowDeletion?: boolean;
    onSelectWithTab?: (video: Video, tab: 'transcript' | 'summary') => void;
    showSummarizeButton?: boolean;
}

type SortField = 'popularity' | 'date' | 'added';
type SortOrder = 'desc' | 'asc';
type FilterType = 'all' | 'transcript' | 'summary';

export function VideoList({ videos, onSelect, onSaveAll, onDelete, saveProgress, compact = false, onSummarizeAll, summarizeProgress, summarizedCount = 0, totalCount = 0, isLibrary = false, allowDeletion = true, onSelectWithTab, showSummarizeButton = true }: Props) {
    const [sortField, setSortField] = useState<SortField>('date');
    const [sortOrder, setSortOrder] = useState<SortOrder>('desc');
    const [filter, setFilter] = useState<FilterType>('all');

    const handleSaveImageAs = async (url: string) => {
        try {
            let dataUri = url;
            if (!url.startsWith('data:')) {
                dataUri = await fetchImageAsDataUri(url);
            }
            if (!dataUri) return;

            const filePath = await save({
                filters: [{ name: 'Image', extensions: ['webp', 'jpg', 'png'] }],
                defaultPath: 'video-thumbnail.webp'
            });
            
            if (filePath) {
                const parts = dataUri.split(',');
                const base64 = parts.length > 1 ? parts[1] : parts[0];
                await saveImage(filePath, base64);
            }
        } catch (e: any) {
            console.error("Save failed:", e);
        }
    };

    const filteredVideos = useMemo(() => {
        if (!isLibrary) return videos;
        return videos.filter(v => {
            const hasTranscript = v.hasTranscript ?? !!v.transcript;
            const hasSummary = v.hasSummary ?? !!v.summary;
            if (filter === 'transcript') return hasTranscript && !hasSummary;
            if (filter === 'summary') return hasSummary;
            return true;
        });
    }, [videos, filter, isLibrary]);

    const sortedVideos = useMemo(() => {
        return [...filteredVideos].sort((a, b) => {
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
    }, [filteredVideos, sortField, sortOrder]);

    const handleSortField = (field: SortField) => {
        setSortField(field);
    };

    const toggleSortOrder = () => {
        setSortOrder(prev => prev === 'desc' ? 'asc' : 'desc');
    };

    if (videos.length === 0) return null;

    return (
        <div className="w-full">
            {/* Header Row 1: Title and Actions */}
            <div className="flex flex-col lg:flex-row justify-between items-center mb-4 gap-4 px-2">
                <div className="flex items-baseline gap-1.5 flex-shrink-0">
                    <h3 className="text-xl font-bold text-white">Videos</h3>
                    <span className="text-[#aaaaaa] text-sm font-medium">
                        ({filteredVideos.length} results)
                    </span>
                </div>

                <div className="flex flex-wrap items-center justify-end gap-3 w-full lg:w-auto">
                    {onSaveAll && (
                        <button
                            onClick={onSaveAll}
                            disabled={!!saveProgress}
                            className={`px-3 py-1.5 bg-white text-black hover:bg-[#e5e5e5] rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 flex items-center gap-2 ${!saveProgress ? 'cursor-pointer' : 'cursor-default'}`}
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

                    <div className="flex items-center bg-[#1a1a1a] p-0.5 rounded-lg border border-[#272727] gap-0.5">
                        <div className="flex gap-0.5">
                            <button
                                onClick={() => handleSortField('date')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'date' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Calendar className="w-3 h-3" />
                                Date Added
                            </button>
                            {videos.some(v => v.dateAdded) && (
                                <button
                                    onClick={() => handleSortField('added')}
                                    className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'added' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                                >
                                    <Bookmark className="w-3 h-3" />
                                    Date Bookmarked
                                </button>
                            )}
                            <button
                                onClick={() => handleSortField('popularity')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${sortField === 'popularity' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Users className="w-3 h-3" />
                                Views
                            </button>
                        </div>

                        <div className="w-px h-3 bg-[#272727] mx-0.5" />

                        <button
                            onClick={toggleSortOrder}
                            className="p-1 rounded text-[#777] hover:text-white hover:bg-white/5 transition-all cursor-pointer group flex items-center gap-1"
                            title='Sort Order ↑ ↓'
                        >
                            {sortOrder === 'desc' ? (
                                <ArrowDown className="w-3.5 h-3.5 group-active:translate-y-0.5 transition-transform" />
                            ) : (
                                <ArrowUp className="w-3.5 h-3.5 group-active:-translate-y-0.5 transition-transform" />
                            )}
                        </button>
                    </div>

                    {isLibrary && (
                        <div className="flex items-center bg-[#1a1a1a] p-0.5 rounded-lg border border-[#272727] gap-0.5">
                            <button
                                onClick={() => setFilter('all')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer ${filter === 'all' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                All Videos
                            </button>
                            <button
                                onClick={() => setFilter('transcript')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${filter === 'transcript' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <FileText className="w-3 h-3" />
                                Transcript Only
                            </button>
                            <button
                                onClick={() => setFilter('summary')}
                                className={`px-2 py-1.5 rounded-md text-[11px] font-bold transition-all cursor-pointer flex items-center gap-1.5 ${filter === 'summary' ? 'bg-white text-black' : 'text-[#777] hover:text-white hover:bg-white/5'}`}
                            >
                                <Sparkles className="w-3 h-3" />
                                With AI Summary
                            </button>
                        </div>
                    )}
                </div>
            </div>


            <div className={`grid gap-x-3 gap-y-8 ${compact ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-8' : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5'}`}>
                {sortedVideos.map((video) => (
                    <div
                        key={video.id}
                        className="group flex flex-col gap-2 cursor-pointer"
                        onClick={() => onSelect(video)}
                    >
                        <div className={`${compact ? 'aspect-[16/9]' : 'aspect-video'} w-full rounded-lg overflow-hidden bg-[#272727] relative`}>
                            <img
                                src={video.thumbnail}
                                alt={video.title}
                                className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                                loading="lazy"
                                onContextMenu={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    handleSaveImageAs(video.thumbnail);
                                }}
                            />
                        </div>

                        <div className="flex gap-2 relative">
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
                                        <div className="flex items-center justify-between mt-0.5 font-medium text-[10px]">
                                            <div className="flex items-center gap-1 text-yellow-600">
                                                <Bookmark className="w-2.5 h-2.5 fill-yellow-600" />
                                                <span title={`Timestamp: ${video.dateAdded}`}>
                                                    {formatDate(video.dateAdded)}
                                                </span>
                                            </div>
                                            {/* Icons moved to absolute container below for better alignment and clickability */}
                                        </div>
                                    )}
                                </div>
                            </div>

                            <div className="absolute bottom-0 right-0 flex items-center gap-1 z-20">
                                {(video.hasTranscript ?? !!video.transcript) && (
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (onSelectWithTab) onSelectWithTab(video, 'transcript');
                                        }}
                                        className="p-0.5 text-green-600 hover:bg-green-600/10 rounded transition-colors cursor-pointer"
                                        title="Transcript"
                                    >
                                        <FileText className="w-2.5 h-2.5" />
                                    </button>
                                )}
                                {(video.hasSummary ?? !!video.summary) && (
                                    <button 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (onSelectWithTab) onSelectWithTab(video, 'summary');
                                        }}
                                        className="p-0.5 text-purple-600 hover:bg-purple-600/10 rounded transition-colors cursor-pointer"
                                        title="AI Summary"
                                    >
                                        <Sparkles className="w-2.5 h-2.5" />
                                    </button>
                                )}
                            </div>

                            {onDelete && allowDeletion && (
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onDelete(video);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-[#3f3f3f] rounded-full transition-all text-white self-start hover:cursor-pointer z-10"
                                    title="Remove"
                                >
                                    <Trash2 className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
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