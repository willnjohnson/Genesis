import { useState, useMemo, useCallback } from "react";
import {
    getVideos, getVideoInfo, searchVideos, fetchChannelVideosV3,
    type Video
} from "../api";
import { type Facet } from "../components/SearchBar";

interface SearchState {
    id: string;
    isPlaylist: boolean;
    isV3Channel?: boolean;
    isSearch?: boolean;
}

export function useSearch(hasApiKey: boolean) {
    const [videos, setVideos] = useState<Video[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [activeFacets, setActiveFacets] = useState<Facet[]>([]);
    const [activeText, setActiveText] = useState("");
    const [continuationToken, setContinuationToken] = useState<string | null>(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [currentSearch, setCurrentSearch] = useState<SearchState | null>(null);

    // Deduplicate helper
    const dedup = (list: Video[]) => {
        const seen = new Set<string>();
        return list.filter(v => { if (seen.has(v.id)) return false; seen.add(v.id); return true; });
    };

    const handleSearch = useCallback(async (query: string) => {
        setLoading(true);
        setError(null);
        setVideos([]);
        setContinuationToken(null);
        setCurrentSearch(null);
        setSearchQuery(query);

        try {
            const facetRegex = /([a-z_]+):(?:"([^"]*)"|([^ ]*))/g;
            let match;
            let forcedType: 'handle' | 'playlist' | 'video' | null = null;
            let facetValue: string | null = null;
            let effectiveQuery = query;

            while ((match = facetRegex.exec(query)) !== null) {
                const type = match[1];
                const value = match[2] || match[3];
                if (type === 'handle') { forcedType = 'handle'; facetValue = value; }
                if (type === 'playlist') { forcedType = 'playlist'; facetValue = value; }
                if (type === 'video') { forcedType = 'video'; facetValue = value; }
                effectiveQuery = effectiveQuery.replace(match[0], '').trim();
            }

            const targetId = effectiveQuery || facetValue || "";
            const playlistIdMatch = targetId.match(/[?&]list=([^#&?]+)/);
            const videoIdMatch = targetId.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
            const isPlaylistId = /^(PL|UU|LL|RD|OLAK5uy_)[a-zA-Z0-9_-]+$/.test(targetId);
            const channelUrlPattern = /(?:youtube\.com\/(?:c\/|channel\/|@|user\/))([^\/\s?]+)|(?:^@([^\/\s?]+))/i;
            const isChannel = forcedType === 'handle' || channelUrlPattern.test(targetId) || targetId.startsWith('UC');

            let mode: 'playlist' | 'video' | 'channel' | 'search' = 'search';
            if (forcedType === 'playlist') mode = 'playlist';
            else if (forcedType === 'video') mode = 'video';
            else if (forcedType === 'handle') mode = 'channel';
            else if (videoIdMatch?.[1]) mode = 'video';
            else if (playlistIdMatch?.[1] || isPlaylistId) mode = 'playlist';
            else if (isChannel) mode = 'channel';

            if (mode === 'playlist') {
                const playlistId = playlistIdMatch ? playlistIdMatch[1] : targetId.trim();
                const res = await getVideos(playlistId, true);
                setVideos(dedup(res.videos));
                setContinuationToken(res.continuation);
                setCurrentSearch({ id: playlistId, isPlaylist: true });
                if (res.videos.length === 0) setError("No videos found in this playlist.");
            } else if (mode === 'video') {
                const videoId = videoIdMatch ? videoIdMatch[1] : (targetId.trim().length === 11 ? targetId.trim() : null);
                if (!videoId) throw new Error("Invalid Video ID");
                const videoInfo = await getVideoInfo(videoId);
                setVideos([videoInfo]);
                setCurrentSearch({ id: videoId, isPlaylist: false });
                return videoInfo; // so App can open sidebar
            } else if (mode === 'channel') {
                if (!hasApiKey) {
                    setError("You must import an API Key to search for channels.");
                } else {
                    const res = await fetchChannelVideosV3(targetId);
                    setVideos(dedup(res.videos));
                    setContinuationToken(res.continuation);
                    setCurrentSearch({ id: targetId, isPlaylist: false, isV3Channel: true });
                    if (res.videos.length === 0) setError("No videos found for this channel.");
                }
            } else {
                const res = await searchVideos(targetId);
                setVideos(dedup(res.videos));
                setContinuationToken(res.continuation);
                setCurrentSearch({ id: targetId, isPlaylist: false, isSearch: true });
                if (res.videos.length === 0) setError("No videos found for this search.");
            }

            setActiveFacets([{ type: 'title_search', value: '' }]);
            setActiveText("");
            setSearchQuery("title_search:");
        } catch (e: any) {
            console.error(e);
            setError(e.message || "Failed to fetch. Check your connection or the URL/handle.");
        } finally {
            setLoading(false);
        }
    }, [hasApiKey]);

    const handleLoadMore = useCallback(async () => {
        if (!continuationToken || !currentSearch || loadingMore) return;
        setLoadingMore(true);
        try {
            let res;
            if (currentSearch.isSearch) {
                res = await searchVideos(currentSearch.id, continuationToken);
            } else if (currentSearch.isV3Channel) {
                res = await fetchChannelVideosV3(currentSearch.id, continuationToken);
            } else {
                res = await getVideos(currentSearch.id, currentSearch.isPlaylist, continuationToken);
            }
            setVideos(prev => {
                const existing = new Set(prev.map(v => v.id));
                return [...prev, ...res.videos.filter(v => !existing.has(v.id))];
            });
            setContinuationToken(res.continuation);
        } catch (e) {
            console.error("Failed to load more:", e);
        } finally {
            setLoadingMore(false);
        }
    }, [continuationToken, currentSearch, loadingMore]);

    const handleLoadAll = useCallback(async () => {
        if (!continuationToken || !currentSearch || loadingMore) return;
        setLoadingMore(true);
        try {
            let token: string | null = continuationToken;
            while (token) {
                let res;
                if (currentSearch.isSearch) {
                    res = await searchVideos(currentSearch.id, token);
                } else if (currentSearch.isV3Channel) {
                    res = await fetchChannelVideosV3(currentSearch.id, token);
                } else {
                    res = await getVideos(currentSearch.id, currentSearch.isPlaylist, token);
                }
                setVideos(prev => {
                    const existing = new Set(prev.map(v => v.id));
                    return [...prev, ...res.videos.filter(v => !existing.has(v.id))];
                });
                token = res.continuation;
                setContinuationToken(token || null);
                if (!token) break;
                await new Promise(r => setTimeout(r, 100));
            }
        } catch (e) {
            console.error("Failed to load all:", e);
        } finally {
            setLoadingMore(false);
        }
    }, [continuationToken, currentSearch, loadingMore]);

    const filteredVideos = useMemo(() => {
        if (!searchQuery) return videos;
        const facetRegex = /([a-z_]+):(?:"([^"]*)"|([^ ]*))/g;
        const facets: { type: string; value: string }[] = [];
        let m;
        while ((m = facetRegex.exec(searchQuery)) !== null) {
            facets.push({ type: m[1], value: m[2] || m[3] || "" });
        }
        const textTerms = searchQuery.replace(facetRegex, '').trim().toLowerCase().split(' ').filter(Boolean);
        const filterBadge = facets.find(f => f.type === 'title_search');
        if (!filterBadge) return videos;
        const badgeTerms = filterBadge.value.toLowerCase().split(' ').filter(Boolean);
        const allTerms = [...textTerms, ...badgeTerms];
        if (allTerms.length === 0) return videos;
        return videos.filter(v =>
            allTerms.every(term =>
                v.title.toLowerCase().includes(term) ||
                (v.author && v.author.toLowerCase().includes(term))
            )
        );
    }, [videos, searchQuery]);

    // Computed: is this a regular search (not handle/playlist facet)?
    const isSearch = currentSearch?.isSearch === true;

    return {
        videos,
        loading,
        error,
        setError,
        searchQuery,
        setSearchQuery,
        activeFacets,
        activeText,
        continuationToken,
        loadingMore,
        handleSearch,
        handleLoadMore,
        handleLoadAll,
        filteredVideos,
        isSearch,
    };
}
