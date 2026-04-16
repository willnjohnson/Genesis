import { useState, useMemo, useCallback } from "react";
import {
    getVideos, getVideoInfo, searchVideos, fetchChannelVideosV3,
    type Video
} from "../api";
import { type Facet } from "../components/SearchBar";
import { normalizeText } from "../lib/utils";

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
            let videoResult = null;

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
                videoResult = videoInfo; // deferred return so App can open sidebar
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

            // Only switch to title_search filter mode if we don't already have a valid search facet
            if (!forcedType) {
                setActiveFacets([]);
                setActiveText(effectiveQuery);
                setSearchQuery(effectiveQuery);
            } else {
                setActiveFacets([]);
                setActiveText("");
                setSearchQuery("");
            }
            
            return videoResult;
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
        
        const whitelist = ['handle', 'playlist', 'video', 'title_search', 'transcript_search', 'term_search', 'definition_search', 'tag_search'];
        const facetRegex = new RegExp(`(${whitelist.join('|')}):(?:"([^"]*)"|([^ ]*))`, 'g');
        const facets: { type: string; value: string }[] = [];
        let m;
        
        // Use a more robust check for a single facet with spaces (same as App.tsx)
        const colonIndex = searchQuery.indexOf(':');
        const firstSpaceIndex = searchQuery.indexOf(' ');
        if (colonIndex !== -1 && (firstSpaceIndex === -1 || firstSpaceIndex > colonIndex)) {
            const potentialType = searchQuery.slice(0, colonIndex);
            if (whitelist.includes(potentialType)) {
                const rest = searchQuery.slice(colonIndex + 1);
                if (!new RegExp(`(${whitelist.join('|')}):`).test(rest)) {
                    let val = rest;
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    facets.push({ type: potentialType, value: val });
                }
            }
        }

        // If not a single facet, or we need to catch others, use the regex
        if (facets.length === 0) {
            while ((m = facetRegex.exec(searchQuery)) !== null) {
                facets.push({ type: m[1], value: normalizeText(m[2] || m[3] || "") });
            }
        }
        
        const textTerms = facets.length === 1 
            ? [] 
            : searchQuery.replace(facetRegex, '').trim().split(' ').filter(Boolean).map(t => normalizeText(t));
        
        if (facets.length === 0 && textTerms.length === 0) return videos;
        
        return videos.filter(v => {
            // Check facets
            for (const f of facets) {
                if (!f.value) continue;
                const val = f.value;
                
                if (f.type === 'title_search') {
                    const terms = val.split(' ').filter(Boolean);
                    if (!terms.every(t =>
                        normalizeText(v.title).includes(t) ||
                        (v.author && normalizeText(v.author).includes(t))
                    )) return false;
                } else if (f.type === 'tag_search') {
                    if (!v.tags) return false;
                    const isExactMatch = val.endsWith('#');
                    let tagQuery = isExactMatch ? val.slice(0, -1) : val;
                    if (tagQuery.startsWith('#')) tagQuery = tagQuery.substring(1);
                    const videoTags = v.tags.split(',').map(t => normalizeText(t.trim()));
                    if (isExactMatch) {
                        if (!videoTags.includes(tagQuery)) return false;
                    } else {
                        const searchTerms = tagQuery.split(' ').filter(Boolean);
                        if (!searchTerms.every(term => videoTags.some(tag => tag.includes(term)))) return false;
                    }
                } else if (f.type === 'handle') {
                    if (!normalizeText(v.handle || "").includes(val)) return false;
                } else if (f.type === 'video') {
                    if (!normalizeText(v.id).includes(val)) return false;
                } else if (f.type === 'transcript_search') {
                    if (!normalizeText(v.transcript || "").includes(val)) return false;
                }
            }
            
            // Check global text terms
            if (textTerms.length > 0) {
                if (!textTerms.every(t =>
                    normalizeText(v.title).includes(t) ||
                    (v.author && normalizeText(v.author).includes(t))
                )) return false;
            }
            
            return true;
        });
    }, [videos, searchQuery]);

    const handleInput = useCallback((val: string) => {
        setSearchQuery(val);
        const lowerVal = val.toLowerCase();
        
        // Handle specific prefixes (consistent with App.tsx whitelist)
        const prefixes = ['handle:', 'playlist:', 'video:', 'title_search:', 'transcript_search:', 'tag_search:'];
        for (const prefix of prefixes) {
            if (lowerVal.includes(prefix)) {
                const afterFacet = val.slice(val.toLowerCase().indexOf(prefix) + prefix.length);
                setActiveFacets([{ type: prefix.slice(0, -1) as any, value: '' }]);
                setActiveText(afterFacet);
                return;
            }
        }
        
        setActiveFacets([]);
        setActiveText(val);
    }, []);

    // Computed: is this a regular search (not handle/playlist facet)?
    const isSearch = currentSearch?.isSearch === true;

    return useMemo(() => ({
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
        handleInput,
        filteredVideos,
        isSearch,
    }), [
        videos, loading, error, searchQuery, activeFacets, activeText, 
        continuationToken, loadingMore, handleSearch, handleLoadMore, 
        handleLoadAll, handleInput, filteredVideos, isSearch
    ]);
}
