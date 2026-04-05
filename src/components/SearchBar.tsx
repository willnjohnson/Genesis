import { Search, AtSign, Youtube, ListVideo, Filter, X, Lightbulb, History, Clock } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { addSearchHistory, getSearchHistory, type HistoryEntry } from '../api';
import { decodeHtmlEntities } from '../lib/utils';

export interface Facet {
    type: SearchFacet;
    value: string;
}

interface Props {
    onSearch: (query: string) => void;
    onLiveFilter?: (query: string) => void;
    loading: boolean;
    placeholder?: string;
    viewMode?: 'search' | 'library' | 'glossary';
    initialFacets?: Facet[];
    initialQuery?: string;
}

export type SearchFacet = 'handle' | 'playlist' | 'video' | 'title_search' | 'transcript_search' | 'term_search' | 'definition_search';

export function SearchBar({ onSearch, onLiveFilter, loading, viewMode = 'search', initialFacets = [], initialQuery = '' }: Props) {
    const [query, setQuery] = useState(initialQuery);
    const [facets, setFacets] = useState<Facet[]>(() => {
        if (initialFacets.length > 0) return initialFacets;
        if (viewMode === 'library') return [{ type: 'title_search', value: '' }];
        if (viewMode === 'glossary') return [{ type: 'term_search', value: '' }];
        return [];
    });
    const [showHistory, setShowHistory] = useState(false);
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    const isLibrary = viewMode === 'library';
    const isGlossary = viewMode === 'glossary';
    const isLibraryOrGlossary = isLibrary || isGlossary;
    const isFilterSearchActive = facets.some(f => f.type === 'title_search' || f.type === 'transcript_search' || f.type === 'term_search' || f.type === 'definition_search');

    useEffect(() => {
        if (initialFacets.length > 0) {
            setFacets(initialFacets);
        }
    }, [initialFacets]);

    useEffect(() => {
        setQuery(initialQuery);
    }, [initialQuery]);

    useEffect(() => {
        const fullQuery = facets.map(f => {
            const val = f.value || query;
            const escapedValue = val.includes(' ') ? `"${val}"` : val;
            return `${f.type}:${escapedValue}`;
        }).join(' ') + (facets.length === 0 ? query : "");

        if (onLiveFilter) onLiveFilter(fullQuery);
        if (isLibrary) onSearch(fullQuery);
    }, [facets, query, isLibrary, onLiveFilter, onSearch]);

    const loadHistory = useCallback(async () => {
        const entries = await getSearchHistory(50);
        setHistory(entries);
    }, []);

    const filteredHistory = useMemo(() => {
        if (!query.trim()) return history;
        const lowQuery = query.toLowerCase();
        return history.filter(entry =>
            entry.search_query.toLowerCase().includes(lowQuery)
        );
    }, [history, query]);
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setShowHistory(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const getFacetIcon = (type: SearchFacet) => {
        switch (type) {
            case 'handle': return <AtSign className="w-3 h-3" />;
            case 'video': return <Youtube className="w-3 h-3" />;
            case 'playlist': return <ListVideo className="w-3 h-3" />;
            case 'title_search': 
            case 'transcript_search': 
            case 'term_search':
            case 'definition_search': return <Filter className="w-3 h-3" />;
            default: return null;
        }
    };

    const facetPatterns = useMemo(() => {
        const patterns: Record<string, SearchFacet> = {};
        if (isGlossary) {
            patterns['term_search:'] = 'term_search';
            patterns['definition_search:'] = 'definition_search';
        } else {
            patterns['title_search:'] = 'title_search';
            if (isLibrary) {
                patterns['transcript_search:'] = 'transcript_search';
            }
            patterns['handle:'] = 'handle';
            patterns['video:'] = 'video';
            if (!isLibrary) {
                patterns['playlist:'] = 'playlist';
            }
        }
        return patterns;
    }, [isLibrary, isGlossary]);

    const extractPlaylistId = (val: string) => {
        const match = val.match(/[?&]list=([^#&?]+)/);
        if (match) return match[1];
        if (/^(PL|UU|LL|RD|OLAK5uy_)[a-zA-Z0-9_-]+$/.test(val)) return val;
        return null;
    };

    const extractVideoId = (val: string) => {
        if (val.startsWith('>')) return val.slice(1);
        const match = val.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i);
        if (match) return match[1];
        if (/^[a-zA-Z0-9_-]{11}$/.test(val) && !val.includes('.') && !val.includes('/')) return val;
        return null;
    };

    const extractHandle = (val: string) => {
        if (val.startsWith('@')) return val.slice(1);
        const match = val.match(/youtube\.com\/(?:c\/|channel\/|@|user\/)([^\/\s?]+)/i);
        if (match) return match[1];
        return null;
    };

    const handleInput = (val: string) => {
        let currentVal = val;

        for (const [prefix, type] of Object.entries(facetPatterns)) {
            const lowVal = currentVal.toLowerCase();
            const prefixIndex = lowVal.indexOf(prefix);
            if (prefixIndex !== -1) {
                const afterPrefix = currentVal.slice(prefixIndex + prefix.length);
                const parts = afterPrefix.trimStart().split(' ');
                const rawValue = parts[0];
                const remaining = parts.slice(1).join(' ');

                let actualValue = rawValue;
                if (type === 'video') actualValue = extractVideoId(rawValue) || rawValue;
                if (type === 'playlist') actualValue = extractPlaylistId(rawValue) || rawValue;
                if (type === 'handle') actualValue = extractHandle(rawValue) || rawValue;

                setFacets([{ type, value: "" }]);
                setQuery(actualValue + (remaining ? " " + remaining : ""));
                return;
            }
        }

        if (!isGlossary && (facets.length === 0 || (isLibrary && facets.length === 1 && (facets[0].type === 'title_search' || facets[0].type === 'transcript_search')))) {
            const handle = extractHandle(val);
            const videoId = extractVideoId(val);
            const playlistId = !isLibrary ? extractPlaylistId(val) : null;

            if (handle && (val.includes('youtube.com') || val.startsWith('@'))) {
                setFacets([{ type: 'handle', value: "" }]);
                setQuery(handle);
                return;
            } else if (videoId && (val.includes('youtube.com') || val.includes('youtu.be') || val.startsWith('>'))) {
                setFacets([{ type: 'video', value: "" }]);
                setQuery(videoId);
                return;
            } else if (!isLibrary && playlistId && val.includes('list=')) {
                setFacets([{ type: 'playlist', value: "" }]);
                setQuery(playlistId);
                return;
            }
        }
        setQuery(val);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && query === '' && facets.length > 0 && e.currentTarget.selectionStart === 0) {
            const lastFacet = facets[facets.length - 1];
            setFacets(facets.slice(0, -1));
            setQuery(lastFacet.type + ':');
            e.preventDefault();
        }
        if (e.key === 'Escape') {
            setShowHistory(false);
        }
    };

    const removeFacet = (index: number) => {
        setFacets(facets.filter((_, i) => i !== index));
        if (facets.length === 1) setQuery("");
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (isFilterSearchActive && !isLibraryOrGlossary) return;
        const fullQuery = facets.map(f => `${f.type}:${query}`).join(' ') + (facets.length === 0 ? query : "");
        const trimmed = fullQuery.trim();
        if (trimmed) {
            onSearch(trimmed);
            addSearchHistory(trimmed);
            setShowHistory(false);
        }
    };

    const handleHistorySelect = (entry: HistoryEntry) => {
        setFacets([]);
        handleInput(entry.search_query);
        setShowHistory(false);
        setTimeout(() => {
            onSearch(entry.search_query);
            addSearchHistory(entry.search_query);
        }, 0);
    };

    const handleFocus = () => {
        if (!isLibrary) {
            loadHistory();
            setShowHistory(true);
        }
    };

    return (
        <form onSubmit={handleSubmit} className="w-full max-w-2xl mx-auto mb-10 px-4">
            <div className={`flex items-stretch justify-center transition-all ${loading ? 'opacity-50 pointer-events-none' : ''}`}>
                <div ref={containerRef} className="relative flex-1">
                    <div className={`flex flex-wrap items-center bg-[#121212] border border-[#404040] ${isLibraryOrGlossary ? 'rounded-full' : 'rounded-l-full'} focus-within:ring-1 focus-within:ring-[red] transition-all min-h-11 py-1 px-3 gap-2`}>
                        {facets.map((f, i) => (
                            <div key={`${f.type}-${i}`} className="flex items-center gap-1.5 bg-[#272727] border border-[#444444] text-[#aaaaaa] rounded-full px-3 py-0.5 animate-in zoom-in-95 duration-200 shadow-sm shrink-0 select-none">
                                {getFacetIcon(f.type)}
                                <span className="text-[11px] font-bold uppercase tracking-wider">{f.type.replace(/_/g, ' ')}</span>
                                <button
                                    type="button"
                                    onClick={() => removeFacet(i)}
                                    className="hover:text-red-500 transition-colors ml-1"
                                >
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                        <input
                            ref={inputRef}
                            type="text"
                            value={query}
                            onChange={(e) => handleInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            onFocus={handleFocus}
                            placeholder={isLibraryOrGlossary ? "" : facets.length > 0 ? "" : "Search YouTube handle, playlist URL, or video URL"}
                            className="flex-1 min-w-[120px] bg-transparent text-white px-2 focus:outline-none placeholder-gray-500 text-[16px] h-full"
                            disabled={loading}
                        />

                        {/* Hints Lightbulb */}
                        <div className="group/hint relative flex items-center pr-1">
                            <Lightbulb className="w-4 h-4 text-gray-500 hover:text-yellow-400 transition-colors cursor-help" />

                            <div className="absolute top-full right-0 mt-3 w-80 bg-[#1a1a1a] border border-[#333] rounded-xl p-4 shadow-2xl opacity-0 translate-y-2 pointer-events-none group-hover/hint:opacity-100 group-hover/hint:translate-y-0 transition-all duration-200 z-100">
                                <h4 className="text-[11px] font-bold text-gray-500 uppercase tracking-widest mb-3 border-b border-[#333] pb-2">Search Tips</h4>
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">{isGlossary ? "Glossary Mode" : isLibrary ? "Library Mode" : "Paste Mode"}</span>
                                        <p className="text-[12px] text-gray-300">
                                            {isGlossary ? "Filter your glossary terms." : isLibrary ? "Filter your saved videos using facets." : "Paste any YouTube URL directly into the search bar."}
                                        </p>
                                    </div>
                                    <div className="flex flex-col gap-1">
                                        <span className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Facet Options</span>
                                        <div className="grid grid-cols-1 gap-1.5 pt-1 text-[11px]">
                                            {isGlossary ? (
                                                <>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>term_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Term Filter</span>
                                                    </code>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>definition_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Definition Filter</span>
                                                    </code>
                                                </>
                                            ) : (
                                                <>
                                                    <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                        <span>title_search:</span>
                                                        <span className="text-gray-500 group-hover/code:text-gray-300">Title Filter</span>
                                                    </code>
                                                    {isLibrary && (
                                                        <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                            <span>transcript_search:</span>
                                                            <span className="text-gray-500 group-hover/code:text-gray-300">Transcript Filter</span>
                                                        </code>
                                                    )}
                                                </>
                                            )}
                                            {!isLibraryOrGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>playlist:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300">ID / URL</span>
                                                </code>
                                            )}
                                            {!isGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>video:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300">{'>'} / ID / URL</span>
                                                </code>
                                            )}
                                            {!isGlossary && (
                                                <code className="bg-black/40 px-2 py-1 rounded text-white flex justify-between group/code transition-colors">
                                                    <span>handle:</span>
                                                    <span className="text-gray-500 group-hover/code:text-gray-300">@ / ID / URL</span>
                                                </code>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Search History Dropdown */}
                    {showHistory && !isLibraryOrGlossary && filteredHistory.length > 0 && (
                        <div className="absolute top-full left-0 right-0 mt-1.5 bg-white dark:bg-[#141414] border border-gray-200 dark:border-[#303030] rounded-xl shadow-2xl z-50 overflow-hidden animate-in fade-in slide-in-from-top-1 duration-150">
                            <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100 dark:border-[#272727]">
                                <History className="w-3.5 h-3.5 text-gray-400 dark:text-[#666]" />
                                <span className="text-[11px] font-bold text-gray-400 dark:text-[#555] uppercase tracking-widest">Recent Searches</span>
                            </div>
                            <ul className="max-h-72 overflow-y-auto">
                                {filteredHistory.map((entry) => (
                                    <li key={entry.id} className="flex items-center group hover:bg-gray-50 dark:hover:bg-white/5 transition-colors">
                                        <button
                                            type="button"
                                            onClick={() => handleHistorySelect(entry)}
                                            className="flex items-center gap-3 px-4 py-2.5 text-left flex-1 min-w-0"
                                        >
                                            <Clock className="w-3.5 h-3.5 text-gray-400 dark:text-[#555] shrink-0 group-hover:text-gray-600 dark:group-hover:text-[#888] transition-colors" />
                                            <span className="text-sm text-gray-600 dark:text-[#aaaaaa] group-hover:text-gray-900 dark:group-hover:text-white transition-colors truncate flex-1">
                                                {decodeHtmlEntities(entry.search_query)}
                                            </span>
                                            <span className="text-[10px] text-gray-400 dark:text-[#444] shrink-0 ml-2">
                                                {new Date(entry.searchedAt).toLocaleDateString()}
                                            </span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={async (e) => {
                                                e.stopPropagation();
                                                const { deleteHistoryEntry: del } = await import('../api');
                                                await del(entry.id);
                                                setHistory(prev => prev.filter(h => h.id !== entry.id));
                                            }}
                                            className="pr-3 pl-1 py-2.5 text-gray-300 dark:text-[#444] hover:text-red-500 transition-colors cursor-pointer shrink-0"
                                            title="Remove from history"
                                        >
                                            <X className="w-3.5 h-3.5" />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
                {!isLibraryOrGlossary && (
                    <button
                        type="submit"
                        disabled={loading || (query.trim() === '' && facets.length === 0) || isFilterSearchActive}
                        className={`flex items-center justify-center px-6 bg-[#222222] border border-[#404040] border-l-0 rounded-r-full transition-colors disabled:opacity-50 group h-auto min-h-11 ${isFilterSearchActive ? 'cursor-default' : 'hover:bg-[#444444] hover:border-[#505050] cursor-pointer'
                            }`}
                        title={isFilterSearchActive ? "In Filter Mode" : "Search"}
                    >
                        <Search className={`w-5 h-5 text-[#aaaaaa] ${!isFilterSearchActive && 'group-hover:text-white'}`} />
                    </button>
                )}
            </div>
        </form>
    );
}
